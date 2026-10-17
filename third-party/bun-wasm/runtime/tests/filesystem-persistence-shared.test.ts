import { expect, test } from "bun:test";
import { PAGE, createFilesystemIdentity } from "../fs/protocol";
import * as shared from "../fs/shared";

function fixture() {
  const state = new shared.SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: 4, mtime: 1 }, new Uint8Array([65, 66, 67, 68]));
  return state;
}

test("shared persistence snapshots own coherent content, metadata and revision", () => {
  const state = fixture();
  const snapshot = state.snapshot(0)!;
  expect(snapshot).toEqual({ stat: { kind: "file", ino: 1, size: 4, mtime: 1 }, data: new Uint8Array([65, 66, 67, 68]), revision: 1 });
  state.write(0, [new Uint8Array([90])], 0);
  expect(snapshot.data).toEqual(new Uint8Array([65, 66, 67, 68]));
  expect(state.revision(0)).toBe(2);
  expect(state.snapshot(99)).toBeUndefined();
  expect(state.revision(99)).toBeUndefined();
  state.register(1, { kind: "directory", ino: 2, size: 0, mtime: 1 });
  expect(state.snapshot(1)).toBeUndefined();
});

test("every shared content or timestamp mutation advances the revision", () => {
  const state = fixture();
  let revision = state.revision(0)!;
  for (const change of [
    () => state.write(0, [new Uint8Array([90])], 0),
    () => state.append(0, [new Uint8Array([69])]),
    () => state.resize(0, 2, true),
    () => state.resize(0, 6, false),
    () => state.setMtime(0, 77),
  ]) {
    change();
    expect(state.revision(0)).toBe(++revision);
    expect(state.snapshot(0)!.revision).toBe(revision);
  }
  expect(state.snapshot(0)!.data).toEqual(new Uint8Array([90, 66, 0, 0, 0, 0]));
  expect(state.snapshot(0)!.stat).toMatchObject({ size: 6, mtime: 77 });
});

test("direct guest writes and appends are visible to persistence without an RPC", () => {
  const state = fixture();
  const guest = new shared.SharedFilesystemState(state.buffer, undefined, 42);
  const slot = guest.fileSlot(0);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  expect(guest.directWrite(slot, 0, [new Uint8Array([90])], 0, 1, epoch, () => false, 42)).toBe(1);
  expect(state.snapshot(0)!.revision).toBe(2);
  expect(guest.directAppend(slot, 0, [new Uint8Array([69])], 1, epoch, () => false, 42)).toEqual({ written: 1, offset: 5 });
  const snapshot = state.snapshot(0)!;
  expect(snapshot.revision).toBe(3);
  expect(snapshot.data).toEqual(new Uint8Array([90, 66, 67, 68, 69]));
  expect(snapshot.stat.size).toBe(5);
  expect(snapshot.stat.mtime).toBeGreaterThan(1);
});

test("shared revisions remain monotonic across low-word overflow on slow and direct writes", () => {
  const state = fixture();
  const slot = state.fileSlot(0), base = slot * 12;
  Atomics.store(state.slots, base + 10, -1);
  expect(state.revision(0)).toBe(0xffffffff);
  state.write(0, [new Uint8Array([90])], 0);
  expect(state.revision(0)).toBe(0x100000000);
  expect(state.isResident(0)).toBe(true);
  Atomics.store(state.slots, base + 10, -1);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  state.directWrite(slot, 0, [new Uint8Array([89])], 0, 1, epoch, () => false, 42);
  expect(state.revision(0)).toBe(0x200000000);
  expect(state.snapshot(0)!.data[0]).toBe(89);
  expect(state.unload(0, 0x200000000)).toBe(true);
  expect(state.revision(0)).toBe(0x200000000);
  state.hydrate(0, new Uint8Array([89, 66, 67, 68]));
  expect(state.revision(0)).toBe(0x200000000);
});

test("eviction leaves connection-owner allocation and attachment probing untouched", () => {
  const identity = createFilesystemIdentity(undefined, PAGE * 256);
  const state = new shared.SharedFilesystemState(identity.shared, identity.maxBytes);
  Atomics.store(state.cells, 6, 123456);
  state.register(0, { kind: "file", ino: 1, size: 1, mtime: 1 });
  expect(state.evict(0, state.revision(0)!)).toBe(true);
  const child = createFilesystemIdentity(identity);
  expect(child.owner).toBe(identity.owner + 1);
  expect(Atomics.load(state.cells, 6)).toBe(123456);
});

test("failed growth, empty I/O, reads and capacity growth do not dirty shared content", () => {
  const state = fixture();
  const slot = state.fileSlot(0);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  expect(state.tryWrite(0, [new Uint8Array([1])], PAGE, 1)).toBeUndefined();
  expect(state.tryAppend(0, [new Uint8Array(PAGE)], PAGE)).toBe(PAGE + 4);
  expect(state.directWrite(slot, 0, [new Uint8Array([1])], PAGE, 1, epoch, () => false, 42)).toBeUndefined();
  expect(state.directAppend(slot, 0, [new Uint8Array(PAGE)], PAGE, epoch, () => false, 42)).toBe(PAGE + 4);
  state.write(0, [], 0);
  state.append(0, []);
  state.directWrite(slot, 0, [], 0, 0, epoch, () => false, 42);
  state.directAppend(slot, 0, [], 0, epoch, () => false, 42);
  state.read(0, [new Uint8Array(4)], 0);
  state.grow(0, PAGE * 2);
  expect(state.revision(0)).toBe(1);
});

test("snapshot retains matching bytes, metadata and revision when a writer follows its unlock", () => {
  const state = fixture();
  const compare = Atomics.compareExchange;
  const lock = state.fileSlot(0) * 12 + 8;
  let changed = false;
  Atomics.compareExchange = ((...args: any[]) => {
    const result = Reflect.apply(compare, Atomics, args);
    if (!changed && args[0] === state.slots && args[1] === lock && args[2] === state.lockOwner && args[3] === 0) {
      changed = true;
      state.resize(0, 0, true);
    }
    return result;
  }) as typeof Atomics.compareExchange;
  try {
    expect(state.snapshot(0)).toEqual({ stat: { kind: "file", ino: 1, size: 4, mtime: 1 }, data: new Uint8Array([65, 66, 67, 68]), revision: 1 });
    expect(changed).toBe(true);
    expect(state.snapshot(0)!.data).toHaveLength(0);
    expect(state.revision(0)).toBe(2);
  } finally { Atomics.compareExchange = compare; }
});

test("changed revisions and shared references block eviction of linked files", () => {
  const state = fixture();
  const saved = state.snapshot(0)!;
  state.write(0, [new Uint8Array([90])], 0);
  expect(state.evict(0, saved.revision)).toBe(false);
  state.retain(0);
  expect(state.evict(0, state.revision(0)!)).toBe(false);
  state.release(0);
  expect(state.evict(0, state.revision(0)!)).toBe(true);
  expect(state.hasFile(0)).toBe(false);
  expect(state.stat(0)).toBeUndefined();
  expect(state.snapshot(0)).toBeUndefined();
  expect(state.resources()).toMatchObject({ usedBytes: 0, files: 0 });
  expect(state.evict(0, saved.revision)).toBe(false);
});

test("eviction zeroes and reuses pages and collision slots without resetting their generation", () => {
  const state = fixture();
  const slot = state.fileSlot(0);
  const revision = state.revision(0)!;
  expect(state.evict(0, revision)).toBe(true);
  state.register(4095, { kind: "file", ino: 2, size: 4, mtime: 2 });
  expect(state.fileSlot(4095)).toBe(slot);
  expect(state.snapshot(4095)!.data).toEqual(new Uint8Array(4));
  expect(state.revision(4095)).toBeGreaterThan(revision);
  expect(state.evict(4095, revision)).toBe(false);
  expect(state.evict(4095, state.revision(4095)!)).toBe(true);
  state.register(0, { kind: "file", ino: 1, size: 4, mtime: 1 });
  expect(state.evict(0, revision)).toBe(false);
});

test("old snapshots cannot evict the same handle reincarnated in a different collision slot", () => {
  const state = new shared.SharedFilesystemState();
  state.register(4095, { kind: "file", ino: 1, size: 1, mtime: 1 });
  const oldSlot = state.fileSlot(4095);
  const oldRevision = state.revision(4095)!;
  expect(state.evict(4095, oldRevision)).toBe(true);
  state.register(0, { kind: "file", ino: 2, size: 1, mtime: 1 });
  state.register(4095, { kind: "file", ino: 1, size: 1, mtime: 1 });
  expect(state.fileSlot(4095)).not.toBe(oldSlot);
  expect(state.revision(4095)).toBeGreaterThan(oldRevision);
  expect(state.evict(4095, oldRevision)).toBe(false);
});

test("evicting a collision preserves lookup for the remaining files", () => {
  const state = fixture();
  state.register(4095, { kind: "file", ino: 2, size: 1, mtime: 1 }, new Uint8Array([7]));
  expect(state.evict(0, state.revision(0)!)).toBe(true);
  expect(state.snapshot(4095)!.data).toEqual(new Uint8Array([7]));
});

test("eviction checks references and revision only after acquiring the file lock", () => {
  const state = fixture();
  const slot = state.fileSlot(0), lock = slot * 12 + 8;
  const revision = state.revision(0)!;
  Atomics.store(state.slots, lock, 42);
  let contended = false;
  state.onContention = () => {
    contended = true;
    // A peer owns the held file lock and publishes its retain before handing it over.
    Atomics.add(state.slots, slot * 12 + 6, 1);
    Atomics.store(state.slots, lock, 0);
  };
  expect(state.evict(0, revision)).toBe(false);
  expect(contended).toBe(true);
  state.onContention = undefined;
  state.release(0);
  Atomics.store(state.slots, lock, 42);
  state.onContention = () => {
    Atomics.store(state.slots, slot * 12 + 10, revision + 1);
    Atomics.store(state.slots, lock, 0);
  };
  expect(state.evict(0, revision)).toBe(false);
  state.onContention = undefined;
  expect(state.evict(0, revision + 1)).toBe(true);
});

test("snapshots reject a slot recycled between lookup and file lock acquisition", () => {
  const state = fixture();
  const compare = Atomics.compareExchange;
  const lock = state.fileSlot(0) * 12 + 8;
  let intercepted = false;
  Atomics.compareExchange = ((...args: any[]) => {
    if (!intercepted && args[0] === state.slots && args[1] === lock && args[2] === 0) {
      intercepted = true;
      expect(state.evict(0, 1)).toBe(true);
      state.register(4095, { kind: "file", ino: 2, size: 1, mtime: 1 }, new Uint8Array([90]));
    }
    return Reflect.apply(compare, Atomics, args);
  }) as typeof Atomics.compareExchange;
  try {
    expect(state.snapshot(0)).toBeUndefined();
    expect(intercepted).toBe(true);
    expect(state.snapshot(4095)!.data).toEqual(new Uint8Array([90]));
  } finally { Atomics.compareExchange = compare; }
});

test("unreferenced directory slots can also be evicted without losing collision lookups", () => {
  const state = fixture();
  state.register(4095, { kind: "directory", ino: 2, size: 0, mtime: 1 });
  const revision = state.revision(4095)!;
  state.setMtime(4095, 77);
  expect(state.evict(4095, revision)).toBe(false);
  expect(state.evict(4095, state.revision(4095)!)).toBe(true);
  expect(state.snapshot(0)!.data).toEqual(new Uint8Array([65, 66, 67, 68]));
});

test("linked eviction supports a corpus larger than the identity table", () => {
  const state = new shared.SharedFilesystemState();
  for (let handle = 0; handle < 10_000; handle++) {
    state.register(handle, { kind: "file", ino: handle + 1, size: 1, mtime: 1 }, new Uint8Array([handle % 256]));
    expect(state.evict(handle, state.revision(handle)!)).toBe(true);
  }
  expect(state.resources()).toMatchObject({ usedBytes: 0, files: 0 });
});

test("metadata-only registration preserves stat without allocating or exposing zero content", () => {
  const state = new shared.SharedFilesystemState();
  const stat = { kind: "file" as const, ino: 1, size: 4, mtime: 1 };
  state.register(0, stat, undefined, false);
  expect(state.stat(0)).toEqual(stat);
  expect(state.isResident(0)).toBe(false);
  expect(state.snapshot(0)).toBeUndefined();
  expect(state.resources().usedBytes).toBe(0);
  expect(state.registeredHandles()).toEqual([0]);
  expect(() => state.read(0, [new Uint8Array(4)], 0)).toThrow(shared.MissingDataError);
  expect(() => state.directRead(state.fileSlot(0), 0, [new Uint8Array(4)], 0, () => false, 42)).toThrow(shared.MissingDataError);
  expect(state.tryWrite(0, [new Uint8Array([90])], 0, 1)).toBeUndefined();
  expect(state.tryAppend(0, [new Uint8Array([90])], 1)).toBe(5);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  expect(state.directWrite(state.fileSlot(0), 0, [new Uint8Array([90])], 0, 1, epoch, () => false, 42)).toBeUndefined();
  expect(state.directAppend(state.fileSlot(0), 0, [new Uint8Array([90])], 1, epoch, () => false, 42)).toBe(5);
  expect(state.revision(0)).toBe(1);
  state.hydrate(0, new Uint8Array([65, 66, 67, 68]));
  expect(state.isResident(0)).toBe(true);
  expect(state.snapshot(0)).toEqual({ stat, data: new Uint8Array([65, 66, 67, 68]), revision: 1 });
  state.hydrate(0, new Uint8Array([90, 90, 90, 90]));
  expect(state.snapshot(0)!.data).toEqual(new Uint8Array([65, 66, 67, 68]));
});

test("relinking an open unlinked file preserves its dirty bytes after the last release", () => {
  const state = fixture();
  const slot = state.fileSlot(0);
  state.retain(0);
  state.unlink(0);
  state.write(0, [new Uint8Array([78, 69, 87])], 0);
  const revision = state.revision(0)!;
  state.relink(0);
  expect(state.isUnlinked(0)).toBe(false);
  expect(state.revision(0)).toBe(revision);
  state.release(0);
  expect(state.fileSlot(0)).toBe(slot);
  expect(state.snapshot(0)!.data).toEqual(new Uint8Array([78, 69, 87, 68]));
  expect(state.resources()).toMatchObject({ usedBytes: PAGE, files: 1 });
  expect(state.evict(0, revision)).toBe(true);
});

test("clean pinned payloads can unload and hydrate without changing their cached slot", () => {
  const state = fixture();
  const slot = state.fileSlot(0);
  const saved = state.snapshot(0)!;
  state.retain(0);
  expect(state.evict(0, saved.revision)).toBe(false);
  expect(state.unload(0, saved.revision)).toBe(true);
  expect(state.fileSlot(0)).toBe(slot);
  expect(state.stat(0)).toEqual(saved.stat);
  expect(state.revision(0)).toBe(saved.revision);
  expect(state.isResident(0)).toBe(false);
  expect(state.resources().usedBytes).toBe(0);
  expect(() => state.directRead(slot, 0, [new Uint8Array(4)], 0, () => false, 42)).toThrow(shared.MissingDataError);
  state.hydrate(0, saved.data);
  const out = new Uint8Array(4);
  expect(state.directRead(slot, 0, [out], 0, () => false, 42)).toBe(4);
  expect(out).toEqual(saved.data);
  expect(state.evict(0, saved.revision)).toBe(false);
  state.write(0, [new Uint8Array([90])], 0);
  expect(state.unload(0, saved.revision)).toBe(false);
  expect(state.snapshot(0)!.data[0]).toBe(90);
  state.release(0);
  expect(state.evict(0, state.revision(0)!)).toBe(true);
});

test("empty files are resident and metadata-only slots can be evicted", () => {
  const state = new shared.SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: 0, mtime: 1 }, undefined, false);
  expect(state.isResident(0)).toBe(true);
  expect(state.snapshot(0)!.data).toHaveLength(0);
  state.register(1, { kind: "file", ino: 2, size: PAGE, mtime: 1 }, undefined, false);
  expect(state.evict(1, state.revision(1)!)).toBe(true);
  expect(state.registeredHandles()).toEqual([0]);
  expect(state.isResident(1)).toBe(false);
});
