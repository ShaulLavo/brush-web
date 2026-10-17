/** Real browser storage tests. Shared contract cases run unchanged against both backends. */
import { IndexedDBStorage } from "../fs/indexeddb";
import type { PersistenceBatch, PersistedNode, StorageBackend } from "../fs/storage";
export { opfsStorageTests, runOpfsStorageTests } from "./opfs-storage-browser";

export function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export async function rejects(action: Promise<unknown>, match: string | RegExp): Promise<void> {
  try { await action; } catch (error) {
    assert(typeof match === "string" ? String(error).includes(match) : match.test(String(error)), `Expected ${match}, got ${error}`); return;
  }
  throw new Error(`Expected rejection containing ${match}`);
}
export const bytes = (value: string) => new TextEncoder().encode(value);
export function batch(generation: number, text = `v${generation}`): PersistenceBatch {
  return { generation, root: 1, removes: [], upserts: [
    { ino: 1, kind: "dir", mtime: generation, size: 0, children: [["file", 2]] },
    { ino: 2, kind: "file", mtime: generation, size: bytes(text).length, data: `file:${generation}` },
  ], data: new Map([[`file:${generation}`, bytes(text)]]) };
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
async function raw(name: string, work: (db: IDBDatabase) => Promise<void>): Promise<void> {
  const db = await request(indexedDB.open(name));
  try { await work(db); } finally { db.close(); }
}
async function change(name: string, store: string, key: IDBValidKey, value?: unknown): Promise<void> {
  await raw(name, db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite", { durability: "strict" });
    if (value === undefined) tx.objectStore(store).delete(key); else tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  }));
}

export interface BrowserStorageTest { label: string; run(): Promise<void> }
export interface StorageContractCase {
  label: string;
  run(name: string, open: () => Promise<StorageBackend>): Promise<void>;
  compactEvery?: number;
}
type Register = (label: string, run: StorageContractCase["run"], compactEvery?: number) => void;

/** Backend-independent behavior, with no assumptions about the physical persistence layout. */
export function storageContractCases(): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test: Register = (label, run, compactEvery) => { cases.push({ label, run, compactEvery }); };
  test("empty, atomic save, reload, payload copies", async (_name, open) => {
    const storage = await open();
    assert(await storage.load() === undefined, "fresh storage must be empty");
    const first = batch(1);
    const saved = storage.persist(first);
    first.data.get("file:1")!.fill(0);
    first.upserts[1]!.size = 1000;
    await saved; await storage.flush(); await storage.close();
    const reopened = await open();
    const loaded = await reopened.load();
    assert(loaded?.generation === 1, "generation survives reopen");
    loaded.nodes.length = 0;
    assert((await reopened.load())?.nodes.length === 2, "load must return owned metadata");
    assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "caller mutation cannot change queued payload");
    const copy = await reopened.read("file:1"); copy.fill(0);
    assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "read must return owned bytes");
    await rejects(reopened.read("missing"), /Missing|ENOENT|NotFound/);
  });

  test("single writer lifetime and close", async (_name, open) => {
    const storage = await open(); await rejects(open(), "writer");
    await storage.close(); await storage.close();
    await rejects(storage.load(), "closed"); await rejects(storage.persist(batch(1)), "closed");
    await rejects(storage.read("file:1"), "closed"); await rejects(storage.flush(), "closed");
    const next = await open(); assert(await next.load() === undefined, "lock released on close");
  });

  test("immutable keys, missing payloads, monotonic generations, and flush errors", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    const collision = batch(2); collision.upserts[1]!.data = "file:1"; collision.data = new Map([["file:1", bytes("xx")]]);
    await rejects(storage.persist(collision), "immutable"); await rejects(storage.flush(), "immutable");
    const missing = batch(2); missing.data.clear();
    await rejects(storage.persist(missing), "Missing");
    await rejects(storage.persist(batch(1)), "generation");
    assert((await storage.load())?.generation === 1, "failed saves leave committed index untouched");
    await storage.persist(batch(2)); await storage.flush();
    const metadataOnly = batch(3);
    metadataOnly.upserts = [metadataOnly.upserts[1]!];
    metadataOnly.upserts[0]!.data = "file:2"; metadataOnly.data.clear();
    await storage.persist(metadataOnly); await storage.flush(); await storage.close();
    const reopened = await open();
    assert((await reopened.load())?.generation === 3, "incremental metadata can reuse an existing immutable payload without resending it");
    assert(new TextDecoder().decode(await reopened.read("file:2")) === "v2", "unchanged payload remains intact after metadata-only update");
    const duplicate = batch(4);
    duplicate.upserts[1]!.data = "file:2"; duplicate.data = new Map([["file:2", bytes("v2")]]);
    await reopened.persist(duplicate); await reopened.flush();
    assert(new TextDecoder().decode(await reopened.read("file:2")) === "v2", "resubmitting identical immutable bytes works even after a cached read");
  });

  test("runtime payload pins survive collection but expire without a new pin", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    for (let n = 2; n <= 5; n++) await storage.persist({ ...batch(n), retainedData: ["file:1"] });
    assert(new TextDecoder().decode(await storage.read("file:1")) === "v1", "cold detached descriptor payload must stay pinned");
    for (let n = 6; n <= 7; n++) await storage.persist(batch(n));
    await rejects(storage.read("file:1"), /Missing|ENOENT|NotFound/);
  });

  test("incremental removals and directory validation", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    await rejects(storage.persist({ generation: 2, root: 999, upserts: [], removes: [], data: new Map() }), "metadata");
    await rejects(storage.persist({ generation: 2, root: 999, upserts: [], removes: [1, 2], data: new Map() }), "metadata");
    await storage.persist({ generation: 2, root: 1, upserts: [], removes: [999], data: new Map() });
    await rejects(storage.persist({ generation: 3, root: 1, upserts: [], removes: [2], data: new Map() }), "metadata");
    const root: PersistedNode = { ino: 1, kind: "dir", size: 0, mtime: 3, children: [] };
    await storage.persist({ generation: 3, root: 1, upserts: [root], removes: [2], data: new Map() });
    assert((await storage.load())?.nodes.length === 1, "removed inode disappears");
  });
  return cases;
}

function indexedDBCases(): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test: Register = (label, run, compactEvery) => { cases.push({ label, run, compactEvery }); };
  test("incremental journal without full metadata rewrites", async (name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    await storage.persist({ ...batch(2), upserts: [batch(2).upserts[1]!] });
    await raw(name, async db => {
      const tx = db.transaction(["metadata", "journal"], "readonly");
      const [snapshots, journal] = await Promise.all([
        request(tx.objectStore("metadata").get(0)), request(tx.objectStore("journal").get(2)),
      ]);
      assert(snapshots.json.includes('"generation":1'), "ordinary save must not rewrite base snapshot");
      assert(JSON.parse(journal.json).upserts.length === 1, "only changed inode is journaled");
    });
    await storage.close();
    const reopened = await open();
    assert((await reopened.load())?.nodes.find(node => node.ino === 2)?.data === "file:2", "journal replay restores changed inode");
  });

  test("corrupt journal recovers previous generation, never an empty tree", async (name, open) => {
    const storage = await open(); await storage.persist(batch(1)); await storage.persist(batch(2)); await storage.close();
    await change(name, "journal", 2, { json: "corrupt", checksum: "wrong" });
    const reopened = await open();
    assert((await reopened.load())?.generation === 1, "bad journal must fall back to intact base");
    assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "previous data retained");
    await reopened.persist(batch(3)); await reopened.close();
    assert((await (await open()).load())?.generation === 3, "recovery can append a new valid chain");
  });

  test("generation reuse cannot resurrect abandoned journal successors", async (name, open) => {
    const original = await open();
    for (let n = 1; n <= 3; n++) await original.persist(batch(n));
    await original.close();
    await change(name, "journal", 2, { json: "corrupt middle journal", checksum: "wrong" });
    const recovered = await open();
    assert((await recovered.load())?.generation === 1, "broken chain must recover generation one");
    const replacement = batch(2, "new recovery edit");
    replacement.upserts[1]!.data = "recovered:2";
    replacement.data = new Map([["recovered:2", bytes("new recovery edit")]]);
    await recovered.persist(replacement); await recovered.close();
    const reopened = await open();
    const index = await reopened.load();
    assert(index?.generation === 2, "abandoned journal three must not reconnect to reused generation two");
    assert(index.nodes.find(node => node.ino === 2)?.data === "recovered:2", "new recovered edit must remain current");
    assert(new TextDecoder().decode(await reopened.read("recovered:2")) === "new recovery edit", "recovered edit bytes survive");
    await raw(name, async db => {
      assert(await request(db.transaction("journal").objectStore("journal").get(3)) === undefined, "abandoned successor must be discarded");
    });
  }, 128);

  test("IndexedDB pin validation does not hydrate cold payloads", async (_name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
      if (this.name === "data" && key === "file:1") throw new Error("pin validation must not hydrate cold payload bytes");
      return originalGet.call(this, key);
    };
    try { for (let n = 2; n <= 5; n++) await storage.persist({ ...batch(n), retainedData: ["file:1"] }); }
    finally { IDBObjectStore.prototype.get = originalGet; }
    assert(new TextDecoder().decode(await storage.read("file:1")) === "v1", "cold detached descriptor payload must stay pinned");
    for (let n = 6; n <= 7; n++) await storage.persist(batch(n));
    await rejects(storage.read("file:1"), "Missing");
  });

  test("both corrupt base snapshots reject instead of erasing existing storage", async (name, open) => {
    const storage = await open(); for (let n = 1; n <= 3; n++) await storage.persist(batch(n)); await storage.close();
    await change(name, "metadata", 0, { json: "bad", checksum: "bad" });
    await change(name, "metadata", 1, { json: "bad", checksum: "bad" });
    const reopened = await open(); await rejects(reopened.load(), "corrupt"); await rejects(reopened.persist(batch(4)), "corrupt");
  });

  test("compaction keeps both snapshots and collects only unreachable old data", async (_name, open) => {
    const storage = await open(); for (let n = 1; n <= 5; n++) await storage.persist(batch(n));
    assert(new TextDecoder().decode(await storage.read("file:3")) === "v3", "previous compacted snapshot data survives");
    assert(new TextDecoder().decode(await storage.read("file:4")) === "v4", "retained journal payload survives");
    assert(new TextDecoder().decode(await storage.read("file:5")) === "v5", "current data survives");
    await rejects(storage.read("file:1"), "Missing"); await rejects(storage.read("file:2"), "Missing");
  });

  test("missing latest snapshot payload recovers older valid copy", async (name, open) => {
    const storage = await open(); for (let n = 1; n <= 3; n++) await storage.persist(batch(n)); await storage.close();
    await change(name, "data", "file:3");
    const reopened = await open(); assert((await reopened.load())?.generation === 2, "invalid payload reference must not win recovery");
  });

  test("strict write transactions abort payload and metadata together", async (name, open) => {
    const storage = await open(); await storage.persist(batch(1));
    const originalPut = IDBObjectStore.prototype.put;
    const originalTransaction = IDBDatabase.prototype.transaction;
    let strict = false;
    IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase["transaction"]>) {
      if (args[1] === "readwrite") { assert(args[2]?.durability === "strict", "durability must be strict"); strict = true; }
      return originalTransaction.apply(this, args);
    };
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      if (this.name === "journal") throw new DOMException("injected quota", "QuotaExceededError");
      return originalPut.call(this, value, key);
    };
    try { await rejects(storage.persist(batch(2)), "quota"); }
    finally { IDBObjectStore.prototype.put = originalPut; IDBDatabase.prototype.transaction = originalTransaction; }
    assert(strict, "strict transaction observed"); await storage.close();
    const reopened = await open(); assert((await reopened.load())?.generation === 1, "abort retains prior commit");
    await rejects(reopened.read("file:2"), "Missing");
    await raw(name, async db => {
      assert(await request(db.transaction("metadata").objectStore("metadata").get("active")) === 1, "commit marker must remain old generation");
    });
  });

  return cases;
}

export function storageTests(): BrowserStorageTest[] {
  return storageContractCases().concat(indexedDBCases()).map(({ label, run, compactEvery = 2 }) => ({
    label,
    async run() {
      const name = `bun-wasm-storage-test-${crypto.randomUUID()}`;
      const opened: IndexedDBStorage[] = [];
      const open = async () => {
        const backend = await IndexedDBStorage.open(name, { compactEvery }); opened.push(backend); return backend;
      };
      try { await run(name, open); }
      finally {
        for (const backend of opened) await backend.close().catch(() => {});
        await request(indexedDB.deleteDatabase(name));
      }
    },
  }));
}

export async function runStorageTests(filter?: string): Promise<string[]> {
  const passed: string[] = [];
  for (const test of storageTests()) if (!filter || test.label.includes(filter)) {
    await test.run(); passed.push(test.label);
  }
  return passed;
}
