import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, createFilesystemConnection, createFilesystemIdentity, connectFilesystemIdentity, revokeFilesystem, MemoryBackend, SharedFilesystemState } from "../fs";
import { PAGE } from "../fs/protocol";

const empty = new Uint8Array();

test("recursive directory removal returns descendant shared pages", () => {
  const backend = new MemoryBackend();
  backend.execute("writeFile", ["/dir/file"], new Uint8Array(PAGE));
  expect(backend.shared.resources().usedBytes).toBe(PAGE);
  expect(backend.execute("remove", ["/dir"], empty)).toBe(true);
  expect(backend.shared.resources().usedBytes).toBe(0);
});

test("move replaces an unpinned target without throwing or leaking", () => {
  const backend = new MemoryBackend();
  backend.execute("writeFile", ["/source"], new Uint8Array([65]));
  backend.execute("writeFile", ["/target"], new Uint8Array([66]));
  expect(backend.execute("move", ["/source", "/target"], empty)).toBe(0);
  expect(backend.execute("readFile", ["/target"], empty)).toEqual(new Uint8Array([65]));
  expect(backend.fs.lookup("/source")).toBeUndefined();
  expect(backend.shared.resources().usedBytes).toBe(PAGE);
});

test("create/remove churn does not consume all shared identities", () => {
  const backend = new MemoryBackend();
  for (let n = 0; n < 4100; n++) {
    backend.execute("writeFile", ["/file"], empty);
    expect(backend.execute("remove", ["/file"], empty)).toBe(true);
  }
  expect(backend.shared.resources().files).toBe(0);
});

test("readFile honors a truncate between length sampling and read lock", () => {
  const backend = new MemoryBackend();
  backend.execute("writeFile", ["/file"], new Uint8Array([1, 2, 3, 4]));
  const original = backend.shared.read.bind(backend.shared);
  backend.shared.read = (...args) => {
    backend.shared.resize(args[0], 0, true);
    return original(...args);
  };
  expect(backend.execute("readFile", ["/file"], empty)).toEqual(empty);
});

test("geometric growth falls back to the final available page", () => {
  const state = new SharedFilesystemState(undefined, PAGE * 256);
  state.register(0, { kind: "file", ino: 1, size: PAGE * 128, mtime: 1 });
  state.register(1, { kind: "file", ino: 2, size: PAGE * 127, mtime: 1 });
  state.grow(0, PAGE * 129);
  expect(state.info(0)?.capacity).toBe(PAGE * 129);
  expect(state.resources().usedBytes).toBe(PAGE * 256);
});


function directFixture() {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  client.shared.register(0, { kind: "file", ino: 1, size: 1, mtime: 1 }, new Uint8Array([65]));
  client.call = () => undefined;
  const capabilities = new Int32Array(pair.client.capabilities);
  Atomics.store(capabilities, 1, 0);
  Atomics.store(capabilities, 2, 0);
  client.retain(0);
  return { client, cleanup: () => { client.dispose(); pair.server.port.close(); } };
}

test("an append after a coherent prefix read does not invent EOF", () => {
  const { client, cleanup } = directFixture();
  try {
    const original = client.shared.read.bind(client.shared);
    client.shared.read = (...args) => {
      const count = original(...args);
      client.shared.mutate(new Int32Array(client.connection.epoch), undefined, () => client.shared.write(0, [new Uint8Array([66])], 1));
      return count;
    };
    const out = new Uint8Array(1);
    expect(client.read(0, [out], 0)).toBe(1);
    expect(out[0]).toBe(65);
  } finally { cleanup(); }
});

test("retained direct stat rejects a revoked connection", () => {
  const { client, cleanup } = directFixture();
  try { revokeFilesystem(client.connection); expect(() => client.stat(0)).toThrow(); }
  finally { cleanup(); }
});

test("cancelled allocation followed by connect installs each segment once", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const root = connectFilesystemIdentity(createFilesystemIdentity(undefined, PAGE * 256 * 3));
  service.connect(root.server);
  const client = new FilesystemClient(root.client);
  let sibling: FilesystemClient | undefined;
  try {
    await client.asyncCall("writeFile", ["/full"], new Uint8Array(PAGE * 256));
    const original = backend.execute.bind(backend);
    let completion!: ReturnType<FilesystemClient["submit"]>;
    backend.execute = (operation, args, data) => {
      const result = original(operation, args, data);
      if (operation === "writeFile" && args[0] === "/extra") completion.cancel();
      return result;
    };
    completion = client.submit("writeFile", ["/extra"], new Uint8Array([65]));
    try { await completion.value(); } catch {} finally { completion.release(); }
    const pair = createFilesystemConnection(root.client);
    sibling = new FilesystemClient(pair.client);
    service.connect(pair.server);
    await sibling.asyncCall("listFiles");
    expect(sibling.shared.segments.length).toBe(backend.shared.segments.length);
  } finally { sibling?.dispose(); client.dispose(); service.dispose(); }
});

test("revoking a live in-flight writer keeps its locks and pages until it exits", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    await client.asyncCall("writeFile", ["/file"], new Uint8Array([65]));
    const root = await client.asyncCall("preopen", ["/"]);
    const path = await client.asyncCall("resolve", [root, "file"]);
    await client.asyncCall("retain", [path.node]);
    const handle = path.node as number;
    const epoch = new Int32Array(pair.client.epoch);
    class InterruptedBytes extends Uint8Array {
      subarray(start?: number, end?: number): Uint8Array {
        revokeFilesystem(pair.client);
        backend.shared.unlink(handle);
        service.sweep();
        expect(Atomics.load(backend.shared.cells, 1)).toBe(pair.client.owner);
        expect(service.resources().retained).toBeGreaterThan(0);
        expect(backend.shared.resources().usedBytes).toBe(PAGE);
        return super.subarray(start, end);
      }
    }
    // Exercise the guest's admitted state, not the service state with an impersonated owner.
    client.shared.mutate(epoch, undefined,
      () => client.shared.write(handle, [new InterruptedBytes([90])], 0));
    service.sweep();
    expect(Atomics.load(epoch, 0) & 1).toBe(0);
    expect(Atomics.load(backend.shared.cells, 1)).toBe(0);
    expect(service.resources().retained).toBe(0);
    expect(backend.shared.resources().usedBytes).toBe(0);
  } finally { client.dispose(); service.dispose(); }
});

test("zero-byte positioned writes do not grow or timestamp a file", () => {
  const state = new SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: 1, mtime: 1 }, new Uint8Array([65]));
  expect(state.write(0, [empty], 4096)).toBe(0);
  expect(state.stat(0)).toMatchObject({ size: 1, mtime: 1 });
  expect(state.append(0, [empty])).toEqual({ written: 0, offset: 1 });
  expect(state.stat(0)).toMatchObject({ size: 1, mtime: 1 });
});

test("a successful truncate returns trailing capacity for another file", () => {
  const backend = new MemoryBackend();
  backend.attachShared(SharedFilesystemState.createBuffer(), PAGE * 256);
  backend.execute("writeFile", ["/full"], new Uint8Array(PAGE * 256));
  const root = backend.execute("preopen", ["/"], empty) as number;
  const path = backend.execute("resolve", [root, "full"], empty) as { node: number };
  backend.execute("resize", [path.node, 0, true], empty);
  expect(backend.shared.resources().usedBytes).toBe(0);
  backend.execute("writeFile", ["/new"], new Uint8Array([65]));
  expect(backend.shared.resources().usedBytes).toBe(PAGE);
});

test("a failed SAB allocation rolls back all uncommitted page owners", () => {
  const state = new SharedFilesystemState(undefined, PAGE * 512);
  state.register(0, { kind: "file", ino: 1, size: PAGE * 255, mtime: 1 });
  const allocator = state as unknown as { ensureSegment(index: number): void };
  const original = allocator.ensureSegment.bind(state);
  allocator.ensureSegment = index => { if (index === 1) throw new RangeError("injected SAB allocation failure"); original(index); };
  expect(() => state.register(1, { kind: "file", ino: 2, size: PAGE * 2, mtime: 1 })).toThrow();
  expect(Array.from(state.owners).filter(owner => owner !== 0).length).toBe(255);
  allocator.ensureSegment = original;
  state.register(2, { kind: "file", ino: 3, size: PAGE, mtime: 1 });
  expect(state.resources().usedBytes).toBe(PAGE * 256);
});

test("shared stat cannot observe a torn two-word timestamp", () => {
  const state = new SharedFilesystemState();
  const oldTime = 0x1ffffffff;
  const newTime = 0x200000000;
  state.register(0, { kind: "file", ino: 1, size: 1, mtime: oldTime }, new Uint8Array([65]));
  const originalLoad = Atomics.load;
  let intercepted = false;
  Atomics.load = ((...args: any[]) => {
    const value = Reflect.apply(originalLoad, Atomics, args);
    if (!intercepted && args[0] === state.slots && args[1] === 12 + 3) {
      intercepted = true;
      // An actual competing writer can enter only if the metadata reader has no file lock.
      if (originalLoad(state.slots, 12 + 8) === 0) state.setMtime(0, newTime);
    }
    return value;
  }) as typeof Atomics.load;
  try { expect([oldTime, newTime]).toContain(state.stat(0)!.mtime); }
  finally { Atomics.load = originalLoad; }
});
