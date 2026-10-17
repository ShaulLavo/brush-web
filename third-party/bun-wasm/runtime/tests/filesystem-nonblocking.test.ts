import { afterEach, expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs";
import { PAGE } from "../fs/protocol";
import { PersistentBackend } from "../fs/persistent";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0).reverse()) stop(); });
async function fixture(cold = false) {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([65, 66, 67, 68]));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "file"]);
  const handle = path.node as number;
  client.retain(handle);
  let release!: () => void;
  let preparations = 0;
  const gate = new Promise<void>(done => { release = done; });
  cleanups.push(release);
  if (cold) {
    expect(backend.shared.unload(handle, backend.shared.revision(handle)!)).toBe(true);
    backend.prepare = (operation, args) => {
      if (operation !== "grow" || backend.shared.isResident(args[0])) return;
      preparations++;
      return gate.then(() => { backend.shared.hydrate(handle, new Uint8Array([65, 66, 67, 68])); });
    };
  }
  client.call = () => { throw new Error("blocking RPC in nonblocking filesystem path"); };
  client.shared.onContention = () => { throw new Error("spinning on a held lock"); };
  return { backend, client, handle, release, preparations: () => preparations };
}
async function ready(client: FilesystemClient, handle: number, writing: boolean) {
  for (let i = 0; i < 100; i++) {
    const status = client.ioReadiness(handle, writing);
    if (writing ? status.writable : status.readable) return;
    await new Promise(done => setTimeout(done, 1));
  }
  throw new Error("filesystem never became ready");
}

test("try I/O never spins or waits for contended file or allocator locks", async () => {
  const { client, handle } = await fixture();
  const lock = client.shared.fileSlot(handle) * 12 + 8;
  const bytes = new Uint8Array(4).fill(9);
  Atomics.store(client.shared.slots, lock, 123);
  try {
    expect(client.tryRead(handle, [bytes], 0)).toBe(-6);
    expect(client.tryWrite(handle, [new Uint8Array([90])], 0)).toBe(-6);
    expect(client.tryAppend(handle, [new Uint8Array([90])])).toBe(-6);
    expect(client.ioReadiness(handle, false).readable).toBe(false);
    expect(client.ioReadiness(handle, true).writable).toBe(false);
    expect(bytes).toEqual(new Uint8Array(4).fill(9));
    expect(Atomics.load(client.shared.cells, 1)).toBe(0);
    expect(Atomics.load(new Int32Array(client.connection.epoch), 0) & 1).toBe(0);
  } finally { Atomics.store(client.shared.slots, lock, 0); }
  Atomics.store(client.shared.cells, 1, 123);
  try {
    expect(client.tryWrite(handle, [new Uint8Array([90])], 0)).toBe(-6);
    expect(client.tryAppend(handle, [new Uint8Array([90])])).toBe(-6);
    expect(client.ioReadiness(handle, true).writable).toBe(false);
    expect(client.tryRead(handle, [bytes], 0)).toBe(4);
  } finally { Atomics.store(client.shared.cells, 1, 0); }
  expect(client.tryWrite(handle, [new Uint8Array([90])], 0)).toBe(1);
  expect(client.tryAppend(handle, [new Uint8Array([69])])).toEqual({ written: 1, offset: 5 });
});

test("cold reads submit hydration once and report EAGAIN without touching guest bytes", async () => {
  const { client, handle, release, preparations } = await fixture(true);
  const bytes = new Uint8Array(4).fill(9);
  expect(client.tryRead(handle, [bytes], 0)).toBe(-6);
  expect(client.tryRead(handle, [bytes], 0)).toBe(-6);
  expect(bytes).toEqual(new Uint8Array(4).fill(9));
  expect(client.ioReadiness(handle, false).readable).toBe(false);
  await new Promise(done => setTimeout(done, 5));
  expect(preparations()).toBe(1);
  release();
  await ready(client, handle, false);
  expect(client.tryRead(handle, [bytes], 0)).toBe(4);
  expect(Array.from(bytes)).toEqual([65, 66, 67, 68]);
  expect(client.completions.size).toBe(0);
});

test("growth prepares capacity but commits no positioned write until the successful retry", async () => {
  const { backend, client, handle } = await fixture();
  const revision = backend.shared.revision(handle);
  const bytes = new Uint8Array([90]);
  expect(client.tryWrite(handle, [bytes], PAGE)).toBe(-6);
  bytes[0] = 89;
  await ready(client, handle, true);
  expect(backend.shared.stat(handle)!.size).toBe(4);
  expect(backend.shared.revision(handle)).toBe(revision);
  expect(client.tryWrite(handle, [bytes], PAGE)).toBe(1);
  const read = new Uint8Array(1);
  expect(client.tryRead(handle, [read], PAGE)).toBe(1);
  expect(read[0]).toBe(89);
});

test("cold append preparation does not secretly append bytes or advance EOF", async () => {
  const { backend, client, handle, release } = await fixture(true);
  const revision = backend.shared.revision(handle);
  const source = new Uint8Array(PAGE).fill(90);
  expect(client.tryAppend(handle, [source])).toBe(-6);
  expect(backend.shared.stat(handle)!.size).toBe(4);
  release();
  await ready(client, handle, true);
  expect(backend.shared.stat(handle)!.size).toBe(4);
  expect(backend.shared.revision(handle)).toBe(revision);
  source[0] = 89;
  expect(client.tryAppend(handle, [source])).toEqual({ written: PAGE, offset: PAGE + 4 });
  const read = new Uint8Array(1);
  expect(client.tryRead(handle, [read], 4)).toBe(1);
  expect(read[0]).toBe(89);
});

async function persistentFixture(failure = false) {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const reading = new Promise<void>(done => { started = done; });
  let reads = 0;
  const backend = await PersistentBackend.open({
    async load() {
      return { version: 1, generation: 1, root: 1, nodes: [
        { ino: 1, kind: "dir", size: 0, mtime: 1, children: [["file", 2]] },
        { ino: 2, kind: "file", size: 4, mtime: 1, data: "payload" },
      ] };
    },
    async read() { reads++; started(); await gate; if (failure) throw new Error("storage unavailable"); return new Uint8Array([65, 66, 67, 68]); },
    async persist() {}, async flush() {}, async close() {},
  }, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => { release(); client.dispose(); service.dispose(); backend.dispose(); });
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "file"]);
  client.retain(path.node);
  client.call = () => { throw new Error("blocking RPC in nonblocking filesystem path"); };
  return { client, backend, root, path, handle: path.node as number, release, reading, reads: () => reads };
}

test("polling a cold persistent file starts hydration without a preceding read", async () => {
  const { client, handle, release, reading, reads } = await persistentFixture();
  expect(client.ioReadiness(handle, false).readable).toBe(false);
  await reading;
  expect(reads()).toBe(1);
  expect(client.ioReadiness(handle, false).readable).toBe(false);
  release();
  await ready(client, handle, false);
  const bytes = new Uint8Array(4);
  expect(client.tryRead(handle, [bytes], 0)).toBe(4);
  expect(Array.from(bytes)).toEqual([65, 66, 67, 68]);
});

test("persistent hydration errors wake readiness and reach the syscall without waiting", async () => {
  const { client, handle, release, reading } = await persistentFixture(true);
  expect(client.tryRead(handle, [new Uint8Array(4)], 0)).toBe(-6);
  await reading;
  release();
  await ready(client, handle, false);
  expect(client.tryRead(handle, [new Uint8Array(4)], 0)).toBe(-29);
  expect(client.completions.size).toBe(0);
});

test("cold open file I/O keeps its inode across unlink and pathname reuse", async () => {
  const { client, handle, root, path, release, reading } = await persistentFixture();
  expect(client.tryRead(handle, [new Uint8Array(4)], 0)).toBe(-6);
  await reading;
  expect(await client.asyncCall("removePath", [path, false])).toBe(0);
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([90]));
  const replacement = await client.asyncCall("resolve", [root, "file"]);
  expect(replacement.node).not.toBe(handle);
  release();
  await ready(client, handle, false);
  const bytes = new Uint8Array(4);
  expect(client.tryRead(handle, [bytes], 0)).toBe(4);
  expect(Array.from(bytes)).toEqual([65, 66, 67, 68]);
  expect(client.tryWrite(handle, [new Uint8Array([89])], 0)).toBe(1);
  expect(Array.from(await client.asyncCall("readFile", ["/file"]))).toEqual([90]);
});

test("try I/O and readiness never enter a completion wait, even after preparation finishes", async () => {
  const { client, handle } = await fixture();
  const atomicsWait = Atomics.wait;
  const completion = client.submit("grow", [handle, PAGE * 2]);
  // This independent request completes before blocking calls are prohibited.
  await completion.value(); completion.release();
  Atomics.wait = (() => { throw new Error("Atomics.wait entered outside poll"); }) as typeof Atomics.wait;
  const wait = Object.getPrototypeOf(completion).wait;
  Object.getPrototypeOf(completion).wait = () => { throw new Error("completion.wait entered outside poll"); };
  try {
    expect(client.tryWrite(handle, [new Uint8Array([90])], PAGE * 3)).toBe(-6);
    await ready(client, handle, true);
    expect(client.tryWrite(handle, [new Uint8Array([90])], PAGE * 3)).toBe(1);
    const bytes = new Uint8Array(1);
    expect(client.tryRead(handle, [bytes], PAGE * 3)).toBe(1);
    expect(bytes[0]).toBe(90);
  } finally { Atomics.wait = atomicsWait; Object.getPrototypeOf(completion).wait = wait; }
});

test("closing the last open reference cancels and releases pending preparation", async () => {
  const { client, handle, release, reading } = await persistentFixture();
  client.retain(handle);
  expect(client.tryRead(handle, [new Uint8Array(4)], 0)).toBe(-6);
  await reading;
  expect(client.completions.size).toBe(1);
  client.release(handle);
  expect(client.completions.size).toBe(1);
  client.release(handle);
  expect(client.completions.size).toBe(0);
  release();
});

test("runtime_proc file read returns EAGAIN before worker poll waits for real persistent hydration", async () => {
  const { client, release, reading } = await persistentFixture();
  const connection = client.fork();
  const worker = new Worker(new URL("./fixtures/filesystem-proc-guest.ts", import.meta.url).href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sawRead = false, sawBlocked = false;
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("runtime_proc file poll did not wake")), 5000);
      worker.onerror = reject;
      worker.onmessage = ({ data }) => {
        if (data.phase === "before-poll") {
          sawRead = data.read === -6 && data.offset === 0;
          if (!sawRead) reject(new Error("cold read did not return EAGAIN without advancing offset"));
        } else if (data.phase === "blocked") {
          sawBlocked = true;
          void reading.then(release);
        } else resolve(data);
      };
      worker.postMessage({ connection }, [connection.port]);
    });
    expect(sawRead).toBe(true);
    expect(sawBlocked).toBe(true);
    expect(result).toEqual({ phase: "done", ready: 1, count: 4, bytes: [65, 66, 67, 68], userdata: 77n });
  } finally { clearTimeout(timer); release(); worker.terminate(); }
});
