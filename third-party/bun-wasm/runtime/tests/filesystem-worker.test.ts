import { afterEach, expect, test } from "bun:test";
import { FilesystemService, MemoryBackend, FilesystemClient, createFilesystemConnection, revokeFilesystem, type FilesystemBackend } from "../fs";
import { HEADER, PAGE, State } from "../fs/protocol";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(backend: FilesystemBackend = new MemoryBackend()) {
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  return { service, client };
}
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const encode = (value: string) => new TextEncoder().encode(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class TrackingBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  readonly calls: string[] = [];
  private gate?: { operation: string; entered: ReturnType<typeof deferred<void>>; released: ReturnType<typeof deferred<void>> };
  get pinCount(): number { return Array.from(this.pins.values()).reduce((total, count) => total + count, 0); }
  retain(handle: number): void { super.retain(handle); this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1); }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle)!;
    if (count === 1) this.pins.delete(handle);
    else this.pins.set(handle, count - 1);
  }
  gateNext(operation: string) {
    const gate = { operation, entered: deferred<void>(), released: deferred<void>() };
    this.gate = gate;
    const release = () => gate.released.resolve();
    cleanups.push(release);
    return { entered: gate.entered.promise, release };
  }
  execute(operation: string, args: any[], data: Uint8Array): unknown {
    this.calls.push(operation);
    if (this.gate?.operation === operation) {
      const gate = this.gate;
      this.gate = undefined;
      gate.entered.resolve();
      return gate.released.promise.then(() => super.execute(operation, args, data));
    }
    return super.execute(operation, args, data);
  }
}
function guestWorker() {
  const worker = new Worker(new URL("./fixtures/filesystem-guest.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  return worker;
}
function nextMessage(worker: Worker): Promise<any> {
  return new Promise((resolve, reject) => {
    worker.onmessage = event => resolve(event.data);
    worker.onerror = reject;
  });
}

test("completed writes are visible to siblings before either process exits", async () => {
  const { client } = fixture();
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => sibling.dispose());
  await client.asyncCall("writeFile", ["/shared"], new TextEncoder().encode("parent"));
  expect(text(await sibling.asyncCall("readFile", ["/shared"]) as Uint8Array)).toBe("parent");
  await sibling.asyncCall("writeFile", ["/shared"], new TextEncoder().encode("child"));
  expect(text(await client.asyncCall("readFile", ["/shared"]) as Uint8Array)).toBe("child");
});

test("open identities survive rename, unlink and name reuse", async () => {
  const { client } = fixture();
  await client.asyncCall("writeFile", ["/a"], new TextEncoder().encode("original"));
  const root = await client.asyncCall("preopen", ["/"]) as number;
  const from = await client.asyncCall("resolve", [root, "a"]) as any;
  await client.asyncCall("retain", [from.node]);
  const to = await client.asyncCall("resolve", [root, "b"]) as any;
  expect(await client.asyncCall("rename", [from, to])).toBe(0);
  const renamed = await client.asyncCall("resolve", [root, "b"]) as any;
  expect(await client.asyncCall("removePath", [renamed, false])).toBe(0);
  await client.asyncCall("writeFile", ["/b"], new TextEncoder().encode("replacement"));
  expect(text(await client.asyncCall("read", [from.node, 100, 0]) as Uint8Array)).toBe("original");
  const replacement = await client.asyncCall("resolve", [root, "b"]) as any;
  expect((await client.asyncCall("stat", [replacement.node]) as any).ino).not.toBe((await client.asyncCall("stat", [from.node]) as any).ino);
  await client.asyncCall("release", [from.node]);
});

test("concurrent writers allocate distinct inodes and never lose unrelated files", async () => {
  const { client } = fixture();
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => sibling.dispose());
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    const writer = i % 2 ? client : sibling;
    await writer.asyncCall("writeFile", [`/file${i}`], new Uint8Array([i]));
  }));
  const entries = await client.asyncCall("lookup", ["/"]) as any;
  expect(entries.children.size).toBe(30);
  expect(new Set(Array.from(entries.children.values(), (entry: any) => entry.ino)).size).toBe(30);
  for (let i = 0; i < 30; i++) expect(await client.asyncCall("readFile", [`/file${i}`])).toEqual(new Uint8Array([i]));
});

test("revoking a guest cancels queued requests and releases open handles and overflow results", async () => {
  const { client, service } = fixture();
  const child = new FilesystemClient(client.fork());
  await child.asyncCall("writeFile", ["/keep"], new Uint8Array([7]));
  const handle = await child.asyncCall("preopen", ["/"]) as number;
  await child.asyncCall("retain", [handle]);
  const pending = child.submit("writeFile", ["/must-not-exist"], new Uint8Array([9]));
  revokeFilesystem(child.connection);
  client.sweep();
  await expect(pending.value()).rejects.toMatchObject({ errno: 11 });
  await client.asyncCall("listFiles", ["/"]);
  expect(await client.asyncCall("readFile", ["/must-not-exist"])).toBeUndefined();
  expect(service.resources()).toMatchObject({ clients: 1, retained: 0, transient: 0, responses: 0 });
  child.dispose();
});

test("submission is non-blocking and exposes kind-3 poll readiness and a shared wake word", async () => {
  const { client } = fixture();
  const request = client.submit("preopen", ["/"]);
  expect(client.readiness(request.id)).toEqual({ kind: 3, id: request.id, ready: false });
  const seen = Atomics.load(new Int32Array(client.connection.signal), 0);
  await request.value();
  expect(client.readiness(request.id)).toEqual({ kind: 3, id: request.id, ready: true });
  expect(Atomics.load(new Int32Array(client.connection.signal), 0)).not.toBe(seen);
  request.release();
  expect(client.readiness(request.id)).toBeUndefined();
});

test("blocking adapter maps backend errors to positive status and negative I/O errno", async () => {
  // A real worker is essential: Atomics.wait must not block the filesystem service's thread.
  const worker = new Worker(new URL("./fixtures/filesystem-guest.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const { client } = fixture();
  const connection = client.fork();
  const result = new Promise<any>((resolve, reject) => {
    worker.onmessage = event => resolve(event.data);
    worker.onerror = reject;
  });
  worker.postMessage(connection, [connection.port]);
  expect(await result).toEqual({ missing: 44, escape: 63, invalidRead: -8, invalidResize: 8, original: "before", changed: "after!" });
});

test("terminating a real worker during an in-flight backend request releases every pin and leaves siblings usable", async () => {
  const backend = new TrackingBackend();
  const { client, service } = fixture(backend);
  await client.asyncCall("writeFile", ["/held"], encode("survives"));
  const worker = guestWorker();
  const connection = client.fork();
  const gate = backend.gateNext("read");
  const submitted = nextMessage(worker);
  worker.postMessage({ scenario: "inflight", connection }, [connection.port]);
  expect(await submitted).toMatchObject({ submitted: expect.any(Number) });
  await gate.entered;
  expect(backend.pinCount).toBe(2);
  expect(service.resources().retained).toBe(backend.pinCount);
  await worker.terminate();
  revokeFilesystem(connection);
  service.sweep();
  expect(backend.pinCount).toBe(0);
  expect(service.resources()).toMatchObject({ clients: 1, retained: 0, transient: 0, responses: 0 });
  gate.release();
  expect(text(await client.asyncCall("readFile", ["/held"]))).toBe("survives");
  await client.asyncCall("writeFile", ["/after-kill"], encode("still live"));
  expect(text(await client.asyncCall("readFile", ["/after-kill"]))).toBe("still live");
});

test("cancelling pending async values wakes every waiter without waiting for the gated backend", async () => {
  const backend = new TrackingBackend();
  const { client, service } = fixture(backend);
  await client.asyncCall("writeFile", ["/held"], encode("value"));
  const gate = backend.gateNext("readFile");
  const request = client.submit("readFile", ["/held"]);
  const first = request.value().catch(error => error);
  const second = request.value().catch(error => error);
  await gate.entered;
  expect(request.ready).toBe(false);
  const wakeBeforeCancel = Atomics.load(new Int32Array(client.connection.signal), 0);
  request.cancel();
  expect(Atomics.load(new Int32Array(client.connection.signal), 0)).not.toBe(wakeBeforeCancel);
  expect(await first).toMatchObject({ errno: 11 });
  expect(await second).toMatchObject({ errno: 11 });
  expect(client.readiness(request.id)).toEqual({ kind: 3, id: request.id, ready: true });
  request.release();
  expect(client.readiness(request.id)).toBeUndefined();
  gate.release();
  expect(text(await client.asyncCall("readFile", ["/held"]))).toBe("value");
  expect(service.resources().responses).toBe(0);
  expect(client.completions.size).toBe(0);
});

test("releasing a queued mutation cancels it before the backend can execute it", async () => {
  const backend = new TrackingBackend();
  const { client } = fixture(backend);
  const gate = backend.gateNext("listFiles");
  const blocking = client.asyncCall("listFiles", ["/"]);
  void blocking.catch(() => {}); // Teardown cancels the caller too if an assertion fails.
  await gate.entered;
  const queued = client.submit("writeFile", ["/cancelled"], encode("never committed"));
  const result = queued.value().catch(error => error);
  queued.release();
  expect(await result).toMatchObject({ errno: 11 });
  gate.release();
  await blocking;
  expect(await client.asyncCall("readFile", ["/cancelled"])).toBeUndefined();
  expect(backend.calls.filter(operation => operation === "writeFile")).toHaveLength(0);
  expect(client.completions.size).toBe(0);
});

test("overflow payloads are drained, discarded on release, and cleared when an owner is revoked", async () => {
  const { client, service } = fixture();
  const bytes = Uint8Array.from({ length: PAGE * 2 + 19 }, (_, i) => i % 251);
  await client.asyncCall("writeFile", ["/large"], bytes);
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "large"]);
  // Request a tiny response page so this low-level read really enters the overflow path.
  const drained = client.submit("read", [path.node, bytes.length, 0], undefined, 128);
  expect(await drained.value()).toEqual(bytes);
  expect(drained.cells[0]).toBe(State.Overflow);
  expect(service.resources().responses).toBe(0);
  drained.release();
  const released = client.submit("readFile", ["/large"], undefined, 128);
  // A later request on the same port is a deterministic barrier for the first completion.
  await client.asyncCall("listFiles", ["/"]);
  expect(released.cells[0]).toBe(State.Overflow);
  expect(service.resources().responses).toBe(1);
  released.release();
  await client.asyncCall("listFiles", ["/"]);
  expect(service.resources().responses).toBe(0);
  const child = new FilesystemClient(client.fork());
  cleanups.push(() => child.dispose());
  const abandoned = child.submit("readFile", ["/large"], undefined, 128);
  await child.asyncCall("listFiles", ["/"]);
  expect(abandoned.cells[0]).toBe(State.Overflow);
  expect(service.resources().responses).toBe(1);
  revokeFilesystem(child.connection);
  service.sweep();
  await expect(abandoned.value()).rejects.toMatchObject({ errno: 11 });
  expect(service.resources().responses).toBe(0);
  expect(text(await client.asyncCall("readFile", ["/large"]))).toBe(text(bytes));
});

test("unaligned large request buffers do not break the cancellation guard", async () => {
  const { client } = fixture();
  const bytes = new Uint8Array(PAGE + 3).fill(91);
  const request = client.submit("writeFile", ["/unaligned"], bytes);
  expect((request.buffer.byteLength - HEADER) % 4).not.toBe(0);
  await request.value();
  request.release();
  expect(await client.asyncCall("readFile", ["/unaligned"])).toEqual(bytes);
});

test("resource counts include transient capabilities, bound them, and preserve explicit open handles", async () => {
  const backend = new TrackingBackend();
  const { client, service } = fixture(backend);
  const root = await client.asyncCall("preopen", ["/"]);
  await client.asyncCall("retain", [root]);
  await client.asyncCall("writeFile", ["/opened"], encode("open identity"));
  const opened = await client.asyncCall("resolve", [root, "opened"]);
  expect(service.resources().retained).toBe(backend.pinCount);
  expect(service.resources().transient).toBe(1);
  await client.asyncCall("retain", [opened.node]);
  expect(service.resources().transient).toBe(0);
  for (let i = 0; i < 300; i++) {
    await client.asyncCall("writeFile", [`/transient-${i}`], new Uint8Array([i % 256]));
    const path = await client.asyncCall("resolve", [root, `transient-${i}`]);
    await client.asyncCall("removePath", [path, false]);
  }
  expect(service.resources().transient).toBeLessThanOrEqual(256);
  expect(service.resources().retained).toBe(backend.pinCount);
  expect(backend.pinCount).toBeLessThanOrEqual(258);
  expect(text(await client.asyncCall("read", [opened.node, PAGE, 0]))).toBe("open identity");
  await client.asyncCall("release", [opened.node]);
  expect(await client.asyncCall("stat", [opened.node]).catch(error => error)).toMatchObject({ errno: 8 });
  await client.asyncCall("release", [root]);
  client.dispose();
  service.sweep();
  expect(backend.pinCount).toBe(0);
  expect(service.resources()).toMatchObject({ clients: 0, retained: 0, transient: 0, responses: 0 });
});

test("blocking caches observe sibling same-size writes, stat changes, truncation, and growth after cached EOF", async () => {
  const backend = new TrackingBackend();
  const { client } = fixture(backend);
  await client.asyncCall("writeFile", ["/cached"], encode("before!!"));
  const worker = guestWorker();
  const connection = client.fork();
  let result = nextMessage(worker);
  worker.postMessage({ scenario: "cache", connection }, [connection.port]);
  const initial = await result;
  expect(initial.count).toBe(8);
  expect(text(Uint8Array.from(initial.bytes))).toBe("before!!");
  const coldCalls = backend.calls.length;
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot" });
  expect(await result).toEqual(initial);
  expect(backend.calls.length).toBe(coldCalls); // resolve + read + stat are all cache hits.
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "cached"]);
  await client.asyncCall("write", [path.node, 0], encode("after!!!"));
  await client.asyncCall("setMtime", [path.node, 123456]);
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot" });
  const changed = await result;
  expect(text(Uint8Array.from(changed.bytes))).toBe("after!!!");
  expect(changed.stat).toMatchObject({ ino: initial.stat.ino, size: 8, mtime: 123456 });
  await client.asyncCall("resize", [path.node, 3, true]);
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot" });
  expect(await result).toMatchObject({ count: 3, bytes: [97, 102, 116, 0, 0, 0, 0, 0], stat: { size: 3 } });
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot", offset: 3 });
  expect(await result).toMatchObject({ count: 0, stat: { size: 3 } });
  await client.asyncCall("write", [path.node, 3], encode("growth"));
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot", offset: 3 });
  expect(await result).toMatchObject({ count: 6, bytes: [103, 114, 111, 119, 116, 104, 0, 0], stat: { size: 9 } });
});

test("transient eviction invalidates hot resolve/read/stat caches before a cached capability can be reused", async () => {
  const backend = new TrackingBackend();
  const { client, service } = fixture(backend);
  await client.asyncCall("writeFile", ["/cached"], encode("cached!!"));
  for (let i = 0; i < 300; i++) await client.asyncCall("writeFile", [`/transient-${i}`], new Uint8Array([i % 256]));
  const worker = guestWorker();
  const connection = client.fork();
  let result = nextMessage(worker);
  worker.postMessage({ scenario: "path-cache", connection }, [connection.port]);
  const original = await result;
  const epoch = Atomics.load(new Int32Array(connection.epoch), 0);
  result = nextMessage(worker);
  worker.postMessage({ scenario: "churn" });
  expect(await result).toEqual({ churned: 300 });
  expect(service.resources().transient).toBe(256);
  expect(service.resources().retained).toBe(backend.pinCount);
  expect(Atomics.load(new Int32Array(connection.epoch), 0)).toBeGreaterThan(epoch);
  expect(Atomics.load(new Int32Array(connection.epoch), 0) & 1).toBe(0);
  const before = backend.calls.length;
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot" });
  expect(await result).toEqual(original);
  expect(backend.calls.slice(before)).toEqual(["resolve", "read", "stat"]);
  const warmed = backend.calls.length;
  result = nextMessage(worker);
  worker.postMessage({ scenario: "snapshot" });
  expect(await result).toEqual(original);
  expect(backend.calls.length).toBe(warmed);
});

for (const length of [8, PAGE + 7]) test(`releasing a ready ${length > PAGE ? "overflow" : "inline"} completion wakes an already-waiting async value`, async () => {
  const { client, service } = fixture();
  await client.asyncCall("writeFile", ["/ready"], new Uint8Array(length).fill(12));
  const request = client.submit("readFile", ["/ready"], undefined, 128);
  // Hold only this completion's port notification. Shared state can become ready before that
  // notification is delivered, and release must not strand value() after deleting its lookup.
  client.connection.port.onmessage = ({ data }) => {
    if (data.completed !== request.id) client.completions.get(data.completed)?.notify();
  };
  let settled = false;
  const waiting = request.value().then(value => ({ value, error: undefined }), error => ({ value: undefined, error })).then(result => { settled = true; return result; });
  await client.asyncCall("listFiles", ["/"]);
  expect(request.ready).toBe(true);
  expect(settled).toBe(false);
  request.release();
  expect((await waiting).error).toMatchObject({ errno: 11 });
  await client.asyncCall("listFiles", ["/"]);
  expect(service.resources().responses).toBe(0);
  expect(client.completions.size).toBe(0);
});

test("cancelling overflow retrieval cancels a queued take and wakes its async caller immediately", async () => {
  const backend = new TrackingBackend();
  const { client, service } = fixture(backend);
  await client.asyncCall("writeFile", ["/overflow"], new Uint8Array(PAGE + 7).fill(42));
  const request = client.submit("readFile", ["/overflow"], undefined, 128);
  await client.asyncCall("listFiles", ["/"]);
  expect(request.cells[0]).toBe(State.Overflow);
  const gate = backend.gateNext("listFiles");
  const blocking = client.asyncCall("listFiles", ["/"]);
  void blocking.catch(() => {}); // Teardown cancels the caller too if an assertion fails.
  await gate.entered;
  const waiting = request.value().catch(error => error);
  expect(client.completions.size).toBe(3); // outer read, gate, and the queued take.
  request.release();
  expect(await waiting).toMatchObject({ errno: 11 });
  gate.release();
  await blocking;
  await client.asyncCall("listFiles", ["/"]);
  expect(service.resources().responses).toBe(0);
  expect(client.completions.size).toBe(0);
});

test("concurrent async overflow consumers share one transfer instead of draining each other's response", async () => {
  const { client, service } = fixture();
  const bytes = new Uint8Array(PAGE * 2 + 7).fill(63);
  await client.asyncCall("writeFile", ["/overflow"], bytes);
  const request = client.submit("readFile", ["/overflow"], undefined, 128);
  const values = await Promise.all([request.value(), request.value()]);
  expect(values).toEqual([bytes, bytes]);
  request.release();
  expect(service.resources().responses).toBe(0);
  expect(client.completions.size).toBe(0);
});

test("resolve protects both returned capabilities from eviction when an old hard link gains a new parent", async () => {
  const backend = new TrackingBackend();
  backend.fs.writeFile("/source", "linked");
  backend.fs.mkdirp("/new-parent");
  const treeRoot = backend.fs.preopen("/");
  const from = backend.fs.resolve(treeRoot, "source");
  const to = backend.fs.resolve(treeRoot, "new-parent/link");
  if (typeof from === "number" || typeof to === "number") throw new Error("invalid link fixture");
  expect(backend.fs.link(from, to)).toBe(0);
  const { client, service } = fixture(backend);
  const root = await client.asyncCall("preopen", ["/"]);
  const original = await client.asyncCall("resolve", [root, "source"]);
  for (let i = 0; i < 255; i++) {
    await client.asyncCall("writeFile", [`/filler-${i}`], new Uint8Array([i]));
    await client.asyncCall("resolve", [root, `filler-${i}`]);
  }
  expect(service.resources().transient).toBe(256);
  const linked = await client.asyncCall("resolve", [root, "new-parent/link"]);
  expect(linked.node).toBe(original.node);
  expect(text(await client.asyncCall("read", [linked.node, 8, 0]))).toBe("linked");
  expect((await client.asyncCall("stat", [linked.parent])).kind).toBe("directory");
  expect(service.resources().transient).toBe(256);
  expect(service.resources().retained).toBe(backend.pinCount);
});

// Unopened handles read through the epoch-validated service cache. Retained handles read shared
// pages under the file lock instead, where a later truncate cannot invalidate a finished copy.
test("a cached read rejected by the epoch check does not modify guest bytes beyond the final EOF", async () => {
  const { client } = fixture();
  await client.asyncCall("writeFile", ["/cached"], encode("oldbytes"));
  const worker = guestWorker();
  const connection = client.fork();
  let result = nextMessage(worker);
  worker.postMessage({ scenario: "path-cache", connection }, [connection.port]);
  expect((await result).count).toBe(8);
  result = nextMessage(worker);
  worker.postMessage({ scenario: "race-truncate" });
  expect(await result).toEqual({ count: 0, bytes: Array(8).fill(77) });
});

async function dedicatedService() {
  const worker = new Worker(new URL("./fixtures/filesystem-service.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const connection = createFilesystemConnection();
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => client.dispose());
  const connected = nextMessage(worker);
  worker.postMessage({ connect: connection.server }, [connection.server.port]);
  expect(await connected).toEqual({ connected: true });
  return { worker, client };
}

test("root revocation wakes a descendant blocked in wait after the actual filesystem worker dies", async () => {
  const service = await dedicatedService();
  const guest = guestWorker();
  const connection = service.client.fork();
  const inflight = nextMessage(service.worker);
  const finished = nextMessage(guest);
  guest.postMessage({ scenario: "service-crash", connection }, [connection.port]);
  expect(await inflight).toEqual({ inflight: true });
  await service.worker.terminate();
  // The controller knows only the root identity, not the descendant's pending request buffer.
  service.client.dispose();
  expect(await finished).toEqual({ errno: 11 });
});

test("root revocation cancels descendant async values after the filesystem worker dies without a completion message", async () => {
  const service = await dedicatedService();
  const child = new FilesystemClient(service.client.fork());
  cleanups.push(() => child.dispose());
  const inflight = nextMessage(service.worker);
  const finished = child.asyncCall("readFile", ["/blocked"]).catch(error => error);
  expect(await inflight).toEqual({ inflight: true });
  await service.worker.terminate();
  service.client.dispose();
  expect(await finished).toMatchObject({ errno: 11 });
  expect(child.completions.size).toBe(0);
  expect(() => child.fork()).toThrow("filesystem errno 11");
});
