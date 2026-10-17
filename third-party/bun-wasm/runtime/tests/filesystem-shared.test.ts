import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import { MemoryBackend, SharedFilesystemState } from "../fs";

test("revoking a killed shared-page writer releases its file lock", () => {
  const state = new SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: PAGE, mtime: 1 }, new Uint8Array(PAGE));
  const lock = 12 + 8;
  Atomics.store(state.slots, lock, 41);
  state.revokeOwner(41);
  expect(Atomics.load(state.slots, lock)).toBe(0);
  expect(state.write(0, [new Uint8Array([7])], 0, undefined, 42)).toBe(1);
});

test("the service grows into another SAB segment and preserves page data", () => {
  const state = new SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: PAGE * 256, mtime: 1 }, new Uint8Array(PAGE * 256).fill(65));
  state.register(1, { kind: "file", ino: 2, size: PAGE, mtime: 1 }, new Uint8Array(PAGE).fill(66));
  const [segment] = state.takeNewSegments();
  expect(segment?.buffer).toBeInstanceOf(SharedArrayBuffer);
  const guest = new SharedFilesystemState(state.buffer);
  guest.addSegment(segment!.buffer, segment!.index);
  const out = new Uint8Array(1);
  expect(guest.read(1, [out], 0)).toBe(1);
  expect(out[0]).toBe(66);
});

test("storage cap reports ENOSPC while the address-space limit reports EFBIG", () => {
  const cap = new SharedFilesystemState(undefined, 16 * 1024 * 1024);
  cap.register(0, { kind: "file", ino: 1, size: PAGE * 256, mtime: 1 }, new Uint8Array(PAGE * 256));
  try { cap.register(1, { kind: "file", ino: 2, size: PAGE, mtime: 1 }, new Uint8Array(PAGE)); throw new Error("expected ENOSPC"); }
  catch (error) { expect((error as { errno?: number }).errno).toBe(51); }
  expect(() => cap.register(2, { kind: "file", ino: 3, size: 1024 * 1024 * 1024 + PAGE, mtime: 1 }, new Uint8Array())).toThrow(RangeError);
});

test("a cloned root attachment preserves service-owned extra segments", () => {
  const backend = new MemoryBackend();
  const buffer = SharedFilesystemState.createBuffer();
  backend.attachShared(buffer);
  const state = backend.shared;
  state.register(0, { kind: "file", ino: 1, size: PAGE * 256, mtime: 1 });
  state.register(1, { kind: "file", ino: 2, size: PAGE, mtime: 1 }, new Uint8Array(PAGE).fill(73));
  backend.attachShared(structuredClone(buffer));
  expect(backend.shared).toBe(state);
  const bytes = new Uint8Array(1);
  expect(backend.shared.read(1, [bytes], 0)).toBe(1);
  expect(bytes[0]).toBe(73);
  expect(() => backend.attachShared(SharedFilesystemState.createBuffer())).toThrow();
});

test("revoking a reader must not repair a live writer's odd epoch", () => {
  const state = new SharedFilesystemState();
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(state.cells, 1, 42);
  Atomics.store(epoch, 0, 1);
  Atomics.store(state.slots, 12 + 8, 41);
  state.revokeOwner(41, epoch);
  expect(Atomics.load(epoch, 0)).toBe(1);
  expect(Atomics.load(state.cells, 1)).toBe(42);
  expect(Atomics.load(state.slots, 12 + 8)).toBe(0);
});

test("revoking the global mutation owner repairs its epoch", () => {
  const state = new SharedFilesystemState();
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(state.cells, 1, 41);
  Atomics.store(epoch, 0, 1);
  state.revokeOwner(41, epoch);
  expect(Atomics.load(epoch, 0)).toBe(2);
  expect(Atomics.load(state.cells, 1)).toBe(0);
});

test("failed growth returns partial page reservations to the allocator", () => {
  const state = new SharedFilesystemState(undefined, PAGE * 256);
  state.register(0, { kind: "file", ino: 1, size: PAGE * 255, mtime: 1 });
  expect(() => state.register(1, { kind: "file", ino: 2, size: PAGE * 2, mtime: 1 })).toThrow();
  state.register(2, { kind: "file", ino: 3, size: PAGE, mtime: 1 });
  expect(state.resources().usedBytes).toBe(PAGE * 256);
});

test("namespace edits refresh shared parent directory timestamps", () => {
  const backend = new MemoryBackend();
  const root = backend.execute("preopen", ["/"], new Uint8Array()) as number;
  backend.execute("setMtime", [root, 1], new Uint8Array());
  const path = backend.execute("resolve", [root, "child"], new Uint8Array());
  backend.execute("create", [path, "file", true], new Uint8Array());
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(1);
});

test("unlink retains open pages then zeroes and reuses them on last close", () => {
  const state = new SharedFilesystemState(undefined, PAGE * 256);
  state.register(0, { kind: "file", ino: 1, size: PAGE, mtime: 1 }, new Uint8Array(PAGE).fill(91));
  state.retain(0);
  state.unlink(0);
  const bytes = new Uint8Array(1);
  expect(state.read(0, [bytes], 0)).toBe(1);
  expect(bytes[0]).toBe(91);
  state.release(0);
  expect(state.resources().usedBytes).toBe(0);
  state.register(1, { kind: "file", ino: 2, size: PAGE, mtime: 1 });
  const fresh = new Uint8Array(PAGE);
  state.read(1, [fresh], 0);
  expect(fresh).toEqual(new Uint8Array(PAGE));
  expect(state.resources().usedBytes).toBe(PAGE);
});

test("resource snapshots include all allocated SAB bytes and the storage cap", () => {
  const state = new SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: PAGE * 256, mtime: 1 });
  state.register(1, { kind: "file", ino: 2, size: PAGE, mtime: 1 });
  const resources = state.resources() as Record<string, number>;
  expect(resources.bytes).toBe(state.buffer.byteLength + PAGE * 256);
  expect(resources.metadataBytes! + resources.poolBytes!).toBe(resources.bytes);
  expect(resources.usedBytes! + resources.freeBytes!).toBe(resources.poolBytes);
  expect(resources.maxBytes).toBe(1024 * 1024 * 1024);
});

test("link, unlink and cross-directory rename refresh both affected directory timestamps", () => {
  const backend = new MemoryBackend();
  const call = (operation: string, args: unknown[]) => backend.execute(operation, args, new Uint8Array());
  const root = call("preopen", ["/"]) as number;
  const child = call("create", [call("resolve", [root, "child"]), "directory", true]) as number;
  const file = call("create", [call("resolve", [root, "file"]), "file", true]) as number;
  backend.retain(file);
  call("setMtime", [root, 1]);
  expect(call("link", [call("resolve", [root, "file"]), call("resolve", [root, "linked"])] )).toBe(0);
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(1);
  call("setMtime", [root, 1]);
  expect(call("removePath", [call("resolve", [root, "linked"]), false])).toBe(0);
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(1);
  call("setMtime", [root, 1]); call("setMtime", [child, 1]);
  expect(call("rename", [call("resolve", [root, "file"]), call("resolve", [child, "file"])] )).toBe(0);
  expect(backend.shared.stat(root)!.mtime).toBeGreaterThan(1);
  expect(backend.shared.stat(child)!.mtime).toBeGreaterThan(1);
});
