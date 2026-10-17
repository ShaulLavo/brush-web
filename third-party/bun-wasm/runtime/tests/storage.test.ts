import { describe, expect, test } from "bun:test";
import { decodeSnapshot, encodeSnapshot, validatePersistedIndex, type PersistedIndex } from "../fs/storage";
import { IndexedDBStorage, recoverIndex, type StorageLockManager } from "../fs/indexeddb";

const index = (): PersistedIndex => ({
  version: 1, generation: 1, root: 1,
  nodes: [
    { ino: 1, kind: "dir", mtime: 0, size: 0, children: [["hello", 2]] },
    { ino: 2, kind: "file", mtime: 1, size: 2, data: "2:1" },
  ],
});

describe("durable metadata", () => {
  test("round trips checksummed metadata and rejects a changed copy", async () => {
    const value = index();
    const snapshot = await encodeSnapshot(value);
    expect(await decodeSnapshot(snapshot)).toEqual(value);
    expect(await decodeSnapshot({ ...snapshot, json: snapshot.json.replace('"generation":1', '"generation":2') })).toBeUndefined();
    expect(await decodeSnapshot({ json: "{}", checksum: snapshot.checksum })).toBeUndefined();
    expect(await decodeSnapshot(undefined)).toBeUndefined();
  });

  test("rejects unsupported versions, dangling children, missing payload keys, and duplicate names", () => {
    expect(() => validatePersistedIndex({ ...index(), version: 2 })).toThrow();
    const dangling = index();
    dangling.nodes[0]!.children![0]![1] = 99;
    expect(() => validatePersistedIndex(dangling)).toThrow();
    const missing = index();
    delete missing.nodes[1]!.data;
    expect(() => validatePersistedIndex(missing)).toThrow();
    const duplicate = index();
    duplicate.nodes[0]!.children!.push(["hello", 2]);
    expect(() => validatePersistedIndex(duplicate)).toThrow();
  });

  test("rejects directory cycles, unreachable nodes, and non-finite metadata", () => {
    const cycle = index();
    cycle.nodes[0]!.children!.push(["cycle", 1]);
    expect(() => validatePersistedIndex(cycle)).toThrow();
    const unreachable = index();
    unreachable.nodes.push({ ino: 3, kind: "file", mtime: 0, size: 0 });
    expect(() => validatePersistedIndex(unreachable)).toThrow();
    const nonfinite = index();
    nonfinite.nodes[1]!.mtime = Number.NaN;
    expect(() => validatePersistedIndex(nonfinite)).toThrow();
  });

  test("allows hard-linked files and payload-free empty files", async () => {
    const value = index();
    value.nodes[0]!.children!.push(["hardlink", 2], ["empty", 3]);
    value.nodes.push({ ino: 3, kind: "file", mtime: 0, size: 0 });
    expect(await decodeSnapshot(await encodeSnapshot(value))).toEqual(value);
  });
});

describe("journal recovery", () => {
  const journal = (generation: number, previous: number) => ({ version: 1 as const, generation, previous, root: 1,
    upserts: [{ ino: 2, kind: "file" as const, mtime: generation, size: 2, data: `2:${generation}` }], removes: [] as number[] });

  test("selects the newest valid branch, not the first old branch", () => {
    // Recovery may append a new branch after rejecting a damaged journal. If an old
    // branch becomes readable again, it must not hide the newer committed generation.
    const journals = new Map([[2, journal(2, 1)], [3, journal(3, 1)], [4, journal(4, 3)]]);
    const recovered = recoverIndex([index(), undefined], journals, new Set(["2:1", "2:2", "2:3", "2:4"]));
    expect(recovered?.generation).toBe(4);
    expect(recovered?.nodes.find(node => node.ino === 2)?.data).toBe("2:4");
  });

  test("does not revalidate unchanged inodes for every journal entry", () => {
    let reads = 0;
    const base = index();
    base.nodes[0]!.children!.push(["unchanged", 3]);
    base.nodes.push({ ino: 3, get kind() { reads++; return "file" as const; }, mtime: 0, size: 0 });
    const journals = new Map(Array.from({ length: 127 }, (_, i) => [i + 2, journal(i + 2, i + 1)]));
    const keys = new Set(Array.from({ length: 128 }, (_, i) => `2:${i + 1}`));
    expect(recoverIndex([base], journals, keys)?.generation).toBe(128);
    expect(reads).toBeLessThan(10);
  });

  test("falls back when the newest chain has a missing link or invalid graph", () => {
    const invalid = { ...journal(4, 2), root: 999, upserts: [], removes: [1, 2] };
    const journals = new Map([[2, journal(2, 1)], [3, journal(3, 99)], [4, invalid]]);
    expect(recoverIndex([index(), undefined], journals, new Set(["2:1", "2:2", "2:3"]))?.generation).toBe(2);
  });
});

describe("single-writer acquisition", () => {
  test("refuses an occupied lock before opening IndexedDB", async () => {
    let opened = false;
    const factory = { open() { opened = true; throw new Error("should not open"); } } as unknown as IDBFactory;
    const locks: StorageLockManager = { async request(_name, options, callback) {
      expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
      return callback(null);
    } };
    await expect(IndexedDBStorage.open("occupied", { indexedDB: factory, locks })).rejects.toThrow("writer");
    expect(opened).toBe(false);
  });

  test("releases its writer lock when opening the database fails", async () => {
    let held = false;
    const locks: StorageLockManager = { async request(_name, _options, callback) {
      held = true;
      try { return await callback({}); } finally { held = false; }
    } };
    const factory = { open() { throw new Error("open failed"); } } as unknown as IDBFactory;
    await expect(IndexedDBStorage.open("failed", { indexedDB: factory, locks })).rejects.toThrow("open failed");
    expect(held).toBe(false);
  });
});
