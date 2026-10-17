import { afterEach, expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, SharedFilesystemState, connectFilesystemIdentity, createFilesystemIdentity, reapFilesystem, type FilesystemIdentity } from "../fs";
import { SHARED_SEGMENT_BYTES } from "../fs/shared";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function segments(identity: FilesystemIdentity): SharedArrayBuffer[] {
  const result = identity.segments;
  expect(Array.isArray(result)).toBe(true);
  return result;
}

test("root identities prepublish empty segment wrappers inherited by descendants", () => {
  const root = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 3);
  const wrappers = segments(root);
  expect(wrappers).toHaveLength(2);
  expect(wrappers.map(buffer => buffer.byteLength)).toEqual([0, 0]);
  const child = createFilesystemIdentity(root);
  expect(segments(child)).toBe(wrappers);
  const cloned = structuredClone(child);
  const growable = wrappers[0] as SharedArrayBuffer & { grow(size: number): void };
  growable.grow(SHARED_SEGMENT_BYTES);
  expect(segments(cloned)[0]!.byteLength).toBe(SHARED_SEGMENT_BYTES);
  expect(wrappers[1]!.byteLength).toBe(0);
});

test("the default cap reserves wrappers, not a gigabyte of backing storage", () => {
  const identity = createFilesystemIdentity();
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = connectFilesystemIdentity(identity);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  expect(segments(identity)).toHaveLength(63);
  expect(segments(identity).every(buffer => buffer.byteLength === 0)).toBe(true);
  expect(backend.shared.resources()).toMatchObject({ poolBytes: SHARED_SEGMENT_BYTES, usedBytes: 0, maxBytes: 1024 * 1024 * 1024 });
});

test("synchronous guests access service-grown segments without port delivery or IO fallback RPC", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2);
  const pair = connectFilesystemIdentity(identity);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  await client.asyncCall("writeFile", ["/full"], new Uint8Array(SHARED_SEGMENT_BYTES));
  await client.asyncCall("writeFile", ["/extra"], new Uint8Array());
  const connection = client.fork();
  const guest = new Worker(new URL("./fixtures/filesystem-segment-guest.ts", import.meta.url).href);
  cleanups.push(() => { guest.terminate(); reapFilesystem(connection); service.sweep(); });
  const result = new Promise<any>((resolve, reject) => { guest.onmessage = ({ data }) => resolve(data); guest.onerror = reject; });
  guest.postMessage({ connection }, [connection.port]);
  expect(await result).toEqual({
    written: 2, appended: { written: 2, offset: 4 },
    snapshots: Array.from({ length: 4 }, () => [65, 66, 67, 68]), operations: ["grow"],
  });
  expect(await client.asyncCall("readFile", ["/extra"])).toEqual(new Uint8Array([65, 66, 67, 68]));
  expect(backend.shared.resources().poolBytes).toBe(SHARED_SEGMENT_BYTES * 2);
});

test("prepublished segments preserve the real storage cap and report only grown backing bytes", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = connectFilesystemIdentity(createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2));
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  await client.asyncCall("writeFile", ["/first"], new Uint8Array(SHARED_SEGMENT_BYTES));
  expect(backend.shared.resources().poolBytes).toBe(SHARED_SEGMENT_BYTES);
  await client.asyncCall("writeFile", ["/second"], new Uint8Array(SHARED_SEGMENT_BYTES));
  expect(backend.shared.resources()).toMatchObject({ poolBytes: SHARED_SEGMENT_BYTES * 2, usedBytes: SHARED_SEGMENT_BYTES * 2, maxBytes: SHARED_SEGMENT_BYTES * 2 });
  expect(await client.asyncCall("writeFile", ["/overflow"], new Uint8Array([1])).catch(error => error)).toMatchObject({ errno: 51 });
  expect(backend.shared.resources().usedBytes).toBe(SHARED_SEGMENT_BYTES * 2);
});

test("root storage caps normalize to whole segments and never exceed one GiB", () => {
  for (const [requested, expected] of [
    [0, SHARED_SEGMENT_BYTES],
    [SHARED_SEGMENT_BYTES * 2 + 1, SHARED_SEGMENT_BYTES * 2],
    [Number.POSITIVE_INFINITY, 1024 * 1024 * 1024],
  ]) {
    const identity = createFilesystemIdentity(undefined, requested);
    expect(identity.maxBytes).toBe(expected!);
    expect(identity.segments).toHaveLength(expected! / SHARED_SEGMENT_BYTES - 1);
    expect(identity.segments.every(buffer => buffer.byteLength === 0)).toBe(true);
  }
  expect(() => createFilesystemIdentity(undefined, NaN)).toThrow(RangeError);
});

test("failed growth of a prepublished wrapper rolls back reservations and preserves accounting", () => {
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2);
  const state = new SharedFilesystemState(identity.shared, identity.maxBytes, undefined, identity.segments);
  const page = SHARED_SEGMENT_BYTES / 256;
  state.register(0, { kind: "file", ino: 1, size: page * 255, mtime: 1 });
  const wrapper = identity.segments[0] as SharedArrayBuffer & { grow(size: number): void };
  const original = wrapper.grow;
  wrapper.grow = () => { throw new RangeError("injected GSAB grow failure"); };
  try {
    let failure: unknown;
    try { state.register(1, { kind: "file", ino: 2, size: page * 2, mtime: 1 }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ errno: 51 });
    expect(Array.from(state.owners).filter(owner => owner !== 0)).toHaveLength(255);
    expect(state.resources()).toMatchObject({ poolBytes: SHARED_SEGMENT_BYTES, usedBytes: page * 255 });
    expect(wrapper.byteLength).toBe(0);
  } finally { wrapper.grow = original; }
  state.register(2, { kind: "file", ino: 3, size: page * 2, mtime: 1 });
  expect(state.resources()).toMatchObject({ poolBytes: SHARED_SEGMENT_BYTES * 2, usedBytes: page * 257 });
  expect(state.takeNewSegments()).toEqual([]);
});
