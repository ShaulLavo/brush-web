import { afterEach, expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { validatePersistedIndex } from "../fs/storage";
import { FilesystemService, FilesystemClient, createFilesystemConnection, createFilesystemIdentity, connectFilesystemIdentity } from "../fs";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
class Store {
  index: any;
  payloads = new Map<string, Uint8Array>();
  reads = 0;
  batches: any[] = [];
  fail = false;
  gate?: Promise<void>;
  async load() { return this.index && structuredClone(this.index); }
  async read(key: string) { this.reads++; const data = this.payloads.get(key); if (!data) throw new Error("missing data"); return data.slice(); }
  async persist(batch: any) {
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("storage failed");
    this.batches.push(batch);
    const nodes = new Map<number, any>((this.index?.nodes ?? []).map((node: any) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, structuredClone(node));
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, data] of batch.data) this.payloads.set(key, data.slice());
    this.index = { version: 1, generation: batch.generation, root: batch.root, nodes: Array.from(nodes.values()) };
  }
  async flush() {}
  async close() {}
}
async function fixture(store: Store, maxBytes?: number, intervalMs = 0) {
  const backend = await PersistentBackend.open(store, { intervalMs });
  const service = new FilesystemService(backend);
  const connection = maxBytes === undefined ? createFilesystemConnection() : connectFilesystemIdentity(createFilesystemIdentity(undefined, maxBytes));
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => { client.dispose(); service.dispose(); backend.dispose(); });
  return { backend, service, client };
}
test("flush preserves data, metadata, hard links and renames; reload loads no payloads", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/dir/a"], encode("saved"));
  const root = await first.client.asyncCall("preopen", ["/"]);
  const a = await first.client.asyncCall("resolve", [root, "dir/a"]);
  const b = await first.client.asyncCall("resolve", [root, "dir/b"]);
  expect(await first.client.asyncCall("link", [a, b])).toBe(0);
  expect(await first.client.asyncCall("setMtime", [a.node, 123456])).toBe(0);
  await first.client.asyncCall("move", ["/dir/a", "/dir/renamed"]);
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  expect(store.reads).toBe(0);
  const listing = await second.client.asyncCall("lookup", ["/dir"]);
  expect(listing.children.get("b").ino).toBe(listing.children.get("renamed").ino);
  expect(listing.children.get("renamed").mtime).toBe(123456);
  expect(store.reads).toBe(0);
  expect(decode(await second.client.asyncCall("readFile", ["/dir/renamed"]))).toBe("saved");
  expect(store.reads).toBe(1);
});
test("a blocked background commit never stalls writes or reads and errors reach flush", async () => {
  const store = new Store();
  const { client, backend } = await fixture(store);
  await client.asyncCall("writeFile", ["/a"], encode("first"));
  let release!: () => void;
  store.gate = new Promise<void>(done => { release = done; });
  const flushing = client.asyncCall("flush");
  await new Promise(done => setTimeout(done, 10));
  await client.asyncCall("writeFile", ["/b"], encode("second"));
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("second");
  release(); await flushing;
  store.gate = undefined;
  store.fail = true;
  await expect(backend.flush()).rejects.toThrow("storage failed");
  store.fail = false;
  await backend.flush();
  const second = await fixture(store);
  expect(decode(await second.client.asyncCall("readFile", ["/b"]))).toBe("second");
});
test("unlinked open files retain bytes while persisted names disappear", async () => {
  const store = new Store();
  const { client } = await fixture(store);
  await client.asyncCall("writeFile", ["/a"], encode("open"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "a"]);
  await client.asyncCall("retain", [path.node]);
  await client.asyncCall("removePath", [path, false]);
  expect(decode(await client.asyncCall("read", [path.node, 8, 0]))).toBe("open");
  await client.asyncCall("flush");
  const second = await fixture(store);
  expect(await second.client.asyncCall("readFile", ["/a"])).toBeUndefined();
});
test("one file edit writes bounded metadata instead of the entire tree", async () => {
  const store = new Store();
  const { client } = await fixture(store);
  for (let i = 0; i < 100; i++) await client.asyncCall("writeFile", [`/pkg/file${i}`], encode("old"));
  await client.asyncCall("flush");
  await client.asyncCall("writeFile", ["/pkg/file42"], encode("new"));
  await client.asyncCall("flush");
  expect(store.batches.at(-1).upserts.length).toBeLessThan(5);
});
test("direct shared writes are checkpointed, including writes during an older commit", async () => {
  const store = new Store();
  const { client } = await fixture(store);
  await client.asyncCall("writeFile", ["/direct"], encode("old data"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "direct"]);
  client.retain(path.node);
  await client.asyncCall("flush");
  let release!: () => void;
  store.gate = new Promise<void>(done => { release = done; });
  expect(client.write(path.node, [encode("first")], 0)).toBe(5);
  const older = client.asyncCall("flush");
  await new Promise(done => setTimeout(done, 10));
  expect(client.write(path.node, [encode("later")], 0)).toBe(5);
  release(); await older; store.gate = undefined;
  await client.asyncCall("flush");
  client.release(path.node);
  const second = await fixture(store);
  expect(decode(await second.client.asyncCall("readFile", ["/direct"]))).toBe("laterata");
});
test("lazy stat and descriptor retain do not read payloads; first direct read does", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/lazy"], encode("payload"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "lazy"]);
  second.client.retain(path.node);
  expect(second.client.stat(path.node).size).toBe(7);
  expect(store.reads).toBe(0);
  expect(decode(await second.client.asyncCall("read", [path.node, 100, 0]))).toBe("payload");
  expect(store.reads).toBe(1);
  second.client.release(path.node);
});
test("metadata-only edits to a lazy open file persist without loading its bytes", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/metadata"], encode("payload"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "metadata"]);
  second.client.retain(path.node);
  expect(second.client.setMtime(path.node, 777)).toBe(0);
  await second.client.asyncCall("flush");
  expect(store.reads).toBe(0);
  const third = await fixture(store);
  expect((await third.client.asyncCall("lookup", ["/metadata"])).mtime).toBe(777);
  second.client.release(path.node);
});

test("clean persisted contents can exceed the resident pool even with few large files", async () => {
  const store = new Store();
  const { client } = await fixture(store, 16 * 1024 * 1024);
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(7);
  for (let i = 0; i < 6; i++) {
    await client.asyncCall("writeFile", [`/large${i}`], bytes);
    await client.asyncCall("flush");
  }
  expect((await client.asyncCall("readFile", ["/large0"])).length).toBe(bytes.length);
});
test("persisted files spanning segments reload lazily beyond the resident pool", async () => {
  const store = new Store();
  const first = await fixture(store, 64 * 1024 * 1024);
  const bytes = new Uint8Array(32 * 1024 * 1024).fill(7);
  for (let i = 0; i < 3; i++) {
    await first.client.asyncCall("writeFile", [`/spanning${i}`], bytes);
    await first.client.asyncCall("flush");
  }
  const second = await fixture(store, 64 * 1024 * 1024);
  expect(store.reads).toBe(0);
  for (let i = 0; i < 3; i++) {
    const loaded = await second.client.asyncCall("readFile", [`/spanning${i}`]);
    expect(loaded.length).toBe(bytes.length);
    expect(loaded[0]).toBe(7);
    expect(loaded.at(-1)).toBe(7);
  }
  expect(second.backend.shared.resources().usedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
});
test("memory-only worker sync acknowledges success with a zero errno", async () => {
  const { MemoryBackend } = await import("../fs");
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection(); service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => { client.dispose(); service.dispose(); });
  const root = await client.asyncCall("preopen", ["/"]);
  expect(await client.asyncCall("sync", [root])).toBe(0);
});

test("background persistence coalesces writes while an earlier checkpoint is blocked", async () => {
  const store = new Store();
  let release!: () => void;
  store.gate = new Promise<void>(done => { release = done; });
  cleanup.push(release);
  const { client, backend } = await fixture(store, undefined, 2);
  let snapshots = 0;
  const snapshot = backend.shared.snapshot.bind(backend.shared);
  backend.shared.snapshot = handle => { snapshots++; return snapshot(handle); };
  await client.asyncCall("writeFile", ["/busy"], encode("zero"));
  await new Promise(done => setTimeout(done, 10));
  const first = snapshots;
  for (let i = 0; i < 5; i++) {
    await client.asyncCall("writeFile", ["/busy"], encode(`edit${i}`));
    await new Promise(done => setTimeout(done, 4));
  }
  expect(first).toBeGreaterThan(0);
  expect(snapshots).toBe(first);
  release(); store.gate = undefined;
  await client.asyncCall("flush");
});

test("a direct write immediately after hydration is not mistaken for clean data", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/race"], encode("OLD"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const hydrate = second.backend.shared.hydrate.bind(second.backend.shared);
  second.backend.shared.hydrate = (handle, bytes) => {
    hydrate(handle, bytes);
    second.backend.shared.write(handle, [encode("NEW")], 0);
  };
  await second.client.asyncCall("readFile", ["/race"]);
  await second.client.asyncCall("flush");
  const third = await fixture(store);
  expect(decode(await third.client.asyncCall("readFile", ["/race"]))).toBe("NEW");
});

test("capacity reclamation does not evict the cold file being hydrated", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/small"], new Uint8Array(6 * 1024 * 1024).fill(1));
  await first.client.asyncCall("writeFile", ["/large"], new Uint8Array(12 * 1024 * 1024).fill(2));
  await first.client.asyncCall("flush");
  const second = await fixture(store, 16 * 1024 * 1024);
  await second.client.asyncCall("readFile", ["/small"]);
  const bytes = await second.client.asyncCall("readFile", ["/large"]);
  expect(bytes.length).toBe(12 * 1024 * 1024);
  expect(bytes[0]).toBe(2);
});

test("full replacement and truncate-to-zero do not load discarded cold contents", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/replace"], encode("discarded"));
  await first.client.asyncCall("writeFile", ["/truncate"], encode("discarded"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  store.read = async () => { throw new Error("old payload must not be read"); };
  await second.client.asyncCall("writeFile", ["/replace"], encode("new"));
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "truncate"]);
  expect(await second.client.asyncCall("resize", [path.node, 0, true])).toBe(0);
  await second.client.asyncCall("flush");
  expect(decode(await second.client.asyncCall("readFile", ["/replace"]))).toBe("new");
  expect((await second.client.asyncCall("readFile", ["/truncate"])).length).toBe(0);
});

test("rename replacement and removal do not walk the unrelated cold namespace", async () => {
  const store = new Store();
  const first = await fixture(store);
  for (let i = 0; i < 100; i++) await first.client.asyncCall("writeFile", [`/cold${i}/a`], encode("cold"));
  await first.client.asyncCall("writeFile", ["/a"], encode("hot"));
  await first.client.asyncCall("writeFile", ["/renamed"], encode("replaced"));
  await first.client.asyncCall("writeFile", ["/removed"], encode("removed"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const children = second.backend.fs.root.children;
  const values = children.values.bind(children);
  let walks = 0;
  children.values = () => { walks++; return values(); };
  await second.client.asyncCall("move", ["/a", "/renamed"]);
  await second.client.asyncCall("remove", ["/removed"]);
  await second.client.asyncCall("flush");
  expect(walks).toBe(0);
  expect(store.reads).toBe(0);
});

test("deleted closed files release persistence bookkeeping", async () => {
  const store = new Store();
  const { client, backend } = await fixture(store);
  for (let i = 0; i < 10; i++) {
    await client.asyncCall("writeFile", [`/temporary${i}`], encode("gone"));
    await client.asyncCall("flush");
    await client.asyncCall("remove", [`/temporary${i}`]);
    await client.asyncCall("flush");
  }
  expect((backend as any).registeredNodes.size).toBeLessThanOrEqual(1);
  expect((backend as any).keys.size).toBe(0);
  expect((backend as any).committedKeys.size).toBe(0);
});

test("cold detached descriptors retain their payload key across unrelated failed commits", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("cold"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "a"]);
  second.client.retain(path.node);
  await second.client.asyncCall("removePath", [path, false]);
  await second.client.asyncCall("flush");
  await second.client.asyncCall("writeFile", ["/b"], encode("unrelated"));
  store.fail = true;
  await expect(second.backend.flush()).rejects.toThrow("storage failed");
  store.fail = false;
  await second.backend.flush();
  expect(decode(await second.client.asyncCall("read", [path.node, 20, 0]))).toBe("cold");
  second.client.release(path.node);
});

test("closing a detached descriptor during its commit does not resurrect a payload pin", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("cold"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const root = await second.client.asyncCall("preopen", ["/"]);
  const path = await second.client.asyncCall("resolve", [root, "a"]);
  second.client.retain(path.node);
  await second.client.asyncCall("removePath", [path, false]);
  let release!: () => void;
  store.gate = new Promise<void>(done => { release = done; });
  cleanup.push(release);
  const pending = second.backend.flush();
  await new Promise(done => setTimeout(done, 5));
  second.client.release(path.node);
  await second.client.asyncCall("stat", [root]);
  const later = second.backend.flush();
  release(); store.gate = undefined;
  await Promise.all([pending, later]);
  expect((second.backend as any).detachedKeys.size).toBe(0);
});

test("recursive removal empties retained directory capabilities without destroying open file bytes", async () => {
  const { MemFS } = await import("../fs/memory");
  const memory = new MemFS();
  memory.writeFile("/dir/a", "child");
  const directory = memory.preopen("/dir");
  memory.retain(directory);
  memory.remove("/dir");
  expect(memory.readdir(directory).map(entry => entry.name)).toEqual([".", ".."]);

  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/dir/a"], encode("child"));
  await first.client.asyncCall("flush");
  const second = await fixture(store);
  const dir = await second.client.asyncCall("preopen", ["/dir"]);
  const file = await second.client.asyncCall("resolve", [dir, "a"]);
  second.client.retain(file.node);
  await second.client.asyncCall("remove", ["/dir"]);
  await second.client.asyncCall("flush");
  expect((await second.client.asyncCall("resolve", [dir, "a"])).node).toBeUndefined();
  expect(decode(await second.client.asyncCall("read", [file.node, 20, 0]))).toBe("child");
  second.client.release(file.node);
});

test("retry after a failed unlink checkpoint respects a later relink", async () => {
  const store = new Store();
  const { client, backend } = await fixture(store);
  await client.asyncCall("writeFile", ["/a"], encode("kept"));
  await client.asyncCall("flush");
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  await client.asyncCall("removePath", [a, false]);
  let release!: () => void;
  store.gate = new Promise<void>(done => { release = done; });
  cleanup.push(release);
  const removal = backend.flush();
  const removalFailed = removal.then(() => undefined, error => error);
  await new Promise(done => setTimeout(done, 5));
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "", parent: undefined }, b])).toBe(0);
  const relink = backend.flush();
  const relinkFailed = relink.then(() => undefined, error => error);
  store.fail = true; release();
  const failures = await Promise.all([removalFailed, relinkFailed]);
  expect(failures[0]?.message).toContain("storage failed");
  expect(failures[1]?.message).toContain("invalidated");
  store.gate = undefined; store.fail = false;
  await backend.flush();
  const second = await fixture(store);
  expect(decode(await second.client.asyncCall("readFile", ["/b"]))).toBe("kept");
  client.release(a.node);
});

test("dirty detached bytes survive relink and last close before durability", async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("OLD"));
  await first.client.asyncCall("flush");
  const { client } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  await client.asyncCall("read", [a.node, 3, 0]);
  await client.asyncCall("removePath", [a, false]);
  expect(client.write(a.node, [encode("NEW")], 0)).toBe(3);
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "" }, b])).toBe(0);
  client.release(a.node);
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("NEW");
  await client.asyncCall("flush");
  const reloaded = await fixture(store);
  expect(decode(await reloaded.client.asyncCall("readFile", ["/b"]))).toBe("NEW");
});

for (const fail of [false, true]) test(`cold relink restores its durable payload after deletion${fail ? " and a failed retry" : ""}`, async () => {
  const store = new Store();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("OLD"));
  await first.client.asyncCall("flush");
  const { client, backend } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  await client.asyncCall("removePath", [a, false]);
  await client.asyncCall("flush");
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "" }, b])).toBe(0);
  if (fail) {
    store.fail = true;
    await expect(backend.flush()).rejects.toThrow("storage failed");
    store.fail = false;
  }
  await backend.flush();
  expect(() => validatePersistedIndex(store.index)).not.toThrow();
  expect(store.reads).toBe(0);
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("OLD");
  await client.asyncCall("writeFile", ["/b"], encode("NEW"));
  await client.asyncCall("flush");
  const revision = backend.shared.revision(a.node)!;
  expect(backend.shared.unload(a.node, revision)).toBe(true);
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("NEW");
  client.release(a.node);
  const reloaded = await fixture(store);
  expect(decode(await reloaded.client.asyncCall("readFile", ["/b"]))).toBe("NEW");
});

test("a queued deletion checkpoint pins a later cold reattachment until its upsert commits", async () => {
  class CollectingStore extends Store {
    async persist(batch: any) {
      await super.persist(batch);
      const keep = new Set<string>((this.index.nodes as any[]).flatMap(node => node.data ? [node.data] : []).concat(batch.retainedData ?? []));
      for (const key of this.payloads.keys()) if (!keep.has(key)) this.payloads.delete(key);
    }
  }
  const store = new CollectingStore();
  const first = await fixture(store);
  await first.client.asyncCall("writeFile", ["/a"], encode("OLD"));
  await first.client.asyncCall("flush");
  const { client, backend } = await fixture(store);
  const root = await client.asyncCall("preopen", ["/"]);
  const a = await client.asyncCall("resolve", [root, "a"]);
  client.retain(a.node);
  let release!: () => void;
  store.gate = new Promise<void>(done => { release = done; });
  cleanup.push(release);
  await client.asyncCall("writeFile", ["/unrelated"], encode("other"));
  const older = backend.flush();
  await new Promise(done => setTimeout(done, 5));
  await client.asyncCall("removePath", [a, false]);
  const removal = backend.flush();
  const b = await client.asyncCall("resolve", [root, "b"]);
  expect(await client.asyncCall("link", [{ node: a.node, name: "" }, b])).toBe(0);
  const relink = backend.flush();
  release(); store.gate = undefined;
  await Promise.all([older, removal, relink]);
  validatePersistedIndex(store.index);
  expect(decode(await client.asyncCall("readFile", ["/b"]))).toBe("OLD");
  client.release(a.node);
});
