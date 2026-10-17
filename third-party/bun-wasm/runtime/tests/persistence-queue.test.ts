import { afterEach, expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import { MemoryBackend } from "../fs/backend";
import { PersistentBackend } from "../fs/persistent";
import type { PersistedIndex, StorageBackend } from "../fs/storage";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

class BlockedStore implements StorageBackend {
  readonly started = deferred();
  readonly release = deferred();
  readonly persistStarted = deferred();
  readonly releasePersist = deferred();
  blockPersist = false;
  failReads = false;
  private storageQueue = Promise.resolve();
  reads = 0;
  index: PersistedIndex = {
    version: 1, generation: 1, root: 1,
    nodes: [
      { ino: 1, kind: "dir", mtime: 1, size: 0, children: [["cold", 2], ["replacement", 3]] },
      { ino: 2, kind: "file", mtime: 1, size: 4, data: "cold" },
      { ino: 3, kind: "file", mtime: 1, size: 3, data: "replacement" },
    ],
  };
  async load() { return structuredClone(this.index); }
  async read(key: string) {
    this.reads++;
    if (key === "cold") this.started.resolve();
    await this.storageQueue;
    if (key === "cold") await this.release.promise;
    if (this.failReads) throw new Error("storage read failed");
    return encode(key === "cold" ? "cold" : "new");
  }
  persist() {
    this.storageQueue = this.storageQueue.then(async () => {
      if (this.blockPersist) { this.persistStarted.resolve(); await this.releasePersist.promise; }
    });
    return this.storageQueue;
  }
  async flush() {}
  async close() {}
}

async function fixture() {
  const store = new BlockedStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => { store.release.resolve(); store.releasePersist.resolve(); client.dispose(); service.dispose(); backend.dispose(); });
  return { store, backend, client, service, connection };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("hot operation waited for cold storage")), 500);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("a cold read queued behind a blocked persist does not hold up in-memory reads and writes", async () => {
  const { store, client } = await fixture();
  await client.asyncCall("writeFile", ["/hot"], encode("before"));
  store.blockPersist = true;
  const flushing = client.asyncCall("flush");
  await store.persistStarted.promise;
  const cold = client.asyncCall("readFile", ["/cold"]);
  await store.started.promise;
  try {
    await promptly(client.asyncCall("writeFile", ["/hot"], encode("after")));
    expect(decode(await promptly(client.asyncCall("readFile", ["/hot"])))).toBe("after");
    expect(store.reads).toBe(1);
  } finally {
    store.releasePersist.resolve(); store.release.resolve();
    await Promise.allSettled([flushing, cold]);
  }
});

test("a prepared path read rechecks a replacement before executing", async () => {
  const { store, client } = await fixture();
  const cold = client.asyncCall("readFile", ["/cold"]);
  await store.started.promise;
  try {
    expect(await promptly(client.asyncCall("move", ["/replacement", "/cold"]))).toBe(0);
  } finally { store.release.resolve(); await cold.catch(() => {}); }
  expect(decode(await cold)).toBe("new");
  expect(store.reads).toBe(2);
});

test("a prepared path read observes deletion instead of reviving an old file", async () => {
  const { store, client } = await fixture();
  const cold = client.asyncCall("readFile", ["/cold"]);
  await store.started.promise;
  try { expect(await promptly(client.asyncCall("remove", ["/cold"]))).toBe(true); }
  finally { store.release.resolve(); await cold.catch(() => {}); }
  expect(await cold).toBeUndefined();
  expect(await client.asyncCall("lookup", ["/cold"])).toBeUndefined();
});

test("concurrent reads of one cold handle share a load and cannot overwrite a later write", async () => {
  const { store, client } = await fixture();
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "cold"]);
  const first = client.asyncCall("read", [path.node, 4, 0]);
  await store.started.promise;
  const second = client.asyncCall("read", [path.node, 4, 0]);
  try {
    await promptly(client.asyncCall("writeFile", ["/hot"], encode("hot")));
    expect(store.reads).toBe(1);
  } finally { store.release.resolve(); await Promise.allSettled([first, second]); }
  expect(decode(await first)).toBe("cold");
  expect(decode(await second)).toBe("cold");
  await client.asyncCall("write", [path.node, 0], encode("EDIT"));
  expect(decode(await client.asyncCall("read", [path.node, 4, 0]))).toBe("EDIT");
  expect(store.reads).toBe(1);
});

test("unowned handles fail before preparation can start a storage read", async () => {
  const { store, backend, client } = await fixture();
  const root = backend.execute("preopen", ["/"], new Uint8Array()) as number;
  const path = backend.execute("resolve", [root, "cold"], new Uint8Array()) as { node: number };
  const read = client.asyncCall("read", [path.node, 4, 0]);
  try { await expect(promptly(read)).rejects.toMatchObject({ errno: 8 }); }
  finally { store.release.resolve(); await read.catch(() => {}); }
  expect(store.reads).toBe(0);
});

test("capability cache churn cannot evict a handle with suspended preparation", async () => {
  const { store, client } = await fixture();
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "cold"]);
  const cold = client.asyncCall("read", [path.node, 4, 0]);
  const result = cold.catch(error => error);
  await store.started.promise;
  try {
    for (let index = 0; index < 260; index++) {
      await client.asyncCall("create", [{ parent: root, name: `new${index}` }, "file"]);
    }
  } finally { store.release.resolve(); }
  expect(await result).toBeInstanceOf(Uint8Array);
  expect(decode(await cold)).toBe("cold");
});

test("an in-memory full overwrite wins over an outstanding cold hydration", async () => {
  const { store, client } = await fixture();
  const cold = client.asyncCall("readFile", ["/cold"]);
  await store.started.promise;
  try {
    await promptly(client.asyncCall("writeFile", ["/cold"], encode("new memory bytes")));
    expect(decode(await promptly(client.asyncCall("readFile", ["/cold"])))).toBe("new memory bytes");
  } finally { store.release.resolve(); await cold.catch(() => {}); }
  expect(decode(await cold)).toBe("new memory bytes");
  expect(decode(await client.asyncCall("readFile", ["/cold"]))).toBe("new memory bytes");
  expect(store.reads).toBe(1);
});

test("failed cold preparation completes the request without poisoning the queue", async () => {
  const { store, client } = await fixture();
  store.failReads = true;
  const cold = client.asyncCall("readFile", ["/cold"]);
  const rejected = cold.catch(error => error);
  await store.started.promise;
  try { await promptly(client.asyncCall("writeFile", ["/hot"], encode("memory"))); }
  finally { store.release.resolve(); expect(await rejected).toMatchObject({ errno: 29 }); }
  expect(decode(await client.asyncCall("readFile", ["/hot"]))).toBe("memory");
});

test("revoking a session during preparation prevents its suspended write from executing", async () => {
  const { store, client, service, connection } = await fixture();
  const peerConnection = createFilesystemConnection({ ...connection.client, revocations: [] });
  service.connect(peerConnection.server);
  const peer = new FilesystemClient(peerConnection.client);
  cleanup.push(() => peer.dispose());
  const write = client.asyncCall("writeFile", ["/cold", true], encode("cancelled"));
  const rejected = write.catch(error => error);
  await store.started.promise;
  client.dispose();
  expect(await rejected).toMatchObject({ errno: 11 });
  store.release.resolve();
  expect(decode(await peer.asyncCall("readFile", ["/cold"]))).toBe("cold");
  expect(store.reads).toBe(1);
});

test("yielding storage preparation does not allow overlapping async backend mutations", async () => {
  const started = deferred(), release = deferred(), arrived = deferred();
  const trace: string[] = [];
  class PausedBackend extends MemoryBackend {
    execute(operation: string, args: any[], data: Uint8Array): unknown {
      if (operation !== "writeFile") return super.execute(operation, args, data);
      trace.push(`start:${args[0]}`);
      if (args[0] === "/first") {
        started.resolve();
        return release.promise.then(() => {
          const result = super.execute(operation, args, data);
          trace.push(`end:${args[0]}`);
          return result;
        });
      }
      const result = super.execute(operation, args, data);
      trace.push(`end:${args[0]}`);
      return result;
    }
  }
  const service = new FilesystemService(new PausedBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => { release.resolve(); client.dispose(); service.dispose(); });
  const first = client.asyncCall("writeFile", ["/first"], encode("one"));
  await started.promise;
  connection.server.port.addEventListener("message", () => arrived.resolve(), { once: true });
  const second = client.asyncCall("writeFile", ["/second"], encode("two"));
  try {
    await arrived.promise;
    await new Promise<void>(done => setImmediate(done));
    expect(trace).toEqual(["start:/first"]);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
  expect(trace).toEqual(["start:/first", "end:/first", "start:/second", "end:/second"]);
});
