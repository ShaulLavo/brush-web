import { afterEach, expect, test } from "bun:test";
const workerCleanups = new Set<() => void>();
afterEach(() => { for (const cleanup of workerCleanups) cleanup(); workerCleanups.clear(); });
import { FilesystemClient, FilesystemService, MemoryBackend, SharedFilesystemState, createFilesystemConnection, createFilesystemIdentity, revokeFilesystem, reapFilesystem, waitForFilesystemQuiescence } from "../fs";
import { FilesystemSection } from "../fs/protocol";

function fixture() {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  client.shared.register(0, { kind: "file", ino: 1, size: 4, mtime: 1 }, new Uint8Array([65, 66, 67, 68]));
  const capabilities = new Int32Array(pair.client.capabilities);
  Atomics.store(capabilities, 1, 0);
  Atomics.store(capabilities, 2, 0);
  client.retain(0);
  client.call = () => { throw new Error("unexpected I/O RPC"); };
  return { client, cleanup: () => { client.dispose(); pair.server.port.close(); } };
}

for (const operation of ["read", "write", "append", "resize", "setMtime", "stat"] as const) test(`quiescence waits for ${operation}'s held lock, then permits another owner`, async () => {
  const { client, cleanup } = fixture();
  const compare = Atomics.compareExchange;
  let waiting: Promise<void> | undefined;
  let settled = false;
  let held = false;
  Atomics.compareExchange = ((...args: any[]) => {
    const result = Reflect.apply(compare, Atomics, args);
    if (!waiting && args[0] === client.shared.slots && args[1] === 20 && args[2] === 0 && result === 0) {
      held = true;
      waiting = waitForFilesystemQuiescence(client.connection).then(() => { settled = true; });
      expect(Atomics.load(new Int32Array(client.connection.sections), 0)).toBeGreaterThan(0);
      expect(settled).toBe(false);
    }
    return result;
  }) as typeof Atomics.compareExchange;
  try {
    try {
      if (operation === "read") client.read(0, [new Uint8Array(4)], 0);
      else if (operation === "write") client.write(0, [new Uint8Array([90])], 0);
      else if (operation === "append") client.append(0, [new Uint8Array([90])]);
      else if (operation === "resize") client.resize(0, 2, false);
      else if (operation === "setMtime") client.setMtime(0, 2);
      else client.stat(0);
    } catch (error) { expect(error).toMatchObject({ errno: 11 }); }
    expect(held).toBe(true);
    expect(waiting).toBeDefined();
    await waiting;
    expect(settled).toBe(true);
    expect(Atomics.load(client.shared.cells, 1)).toBe(0);
    expect(Atomics.load(client.shared.slots, 20)).toBe(0);
    expect(Atomics.load(new Int32Array(client.connection.sections), 0)).toBe(0);
    reapFilesystem(client.connection);
    const other = new SharedFilesystemState(client.connection.shared, client.connection.maxBytes, client.connection.owner + 1, client.connection.segments);
    expect(other.read(0, [new Uint8Array(4)], 0)).toBe(4);
  } finally { Atomics.compareExchange = compare; cleanup(); }
});

test("revocation between section admission and its check cannot acquire a lock or mutate pages", async () => {
  const { client, cleanup } = fixture();
  const add = Atomics.add;
  let raced = false;
  Atomics.add = ((...args: any[]) => {
    const result = Reflect.apply(add, Atomics, args);
    if (!raced && args[0].buffer === client.connection.sections && args[2] === 1) {
      raced = true;
      revokeFilesystem(client.connection);
    }
    return result;
  }) as typeof Atomics.add;
  try {
    expect(client.write(0, [new Uint8Array([90])], 0)).toBe(-11);
    expect(raced).toBe(true);
    await waitForFilesystemQuiescence(client.connection);
    expect(Atomics.load(client.shared.cells, 1)).toBe(0);
    expect(Atomics.load(client.shared.slots, 20)).toBe(0);
    const other = new SharedFilesystemState(client.connection.shared, client.connection.maxBytes, client.connection.owner + 1, client.connection.segments);
    const bytes = new Uint8Array(4);
    expect(other.read(0, [bytes], 0)).toBe(4);
    expect(Array.from(bytes)).toEqual([65, 66, 67, 68]);
    expect(client.write(0, [new Uint8Array([91])], 0)).toBe(-11);
    expect(other.read(0, [bytes], 0)).toBe(4);
    expect(Array.from(bytes)).toEqual([65, 66, 67, 68]);
  } finally { Atomics.add = add; cleanup(); }
});

test("the service keeps capabilities until an admitted entrant finishes its revocation check", async () => {
  const pair = createFilesystemConnection();
  const backend = new MemoryBackend();
  backend.fs.writeFile("/held", "seed");
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const add = Atomics.add;
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const path = await client.asyncCall("resolve", [root, "held"]);
    const retained = service.resources().retained;
    let raced = false;
    Atomics.add = ((...args: any[]) => {
      const result = Reflect.apply(add, Atomics, args);
      if (!raced && args[0].buffer === client.connection.sections && args[2] === 1) {
        raced = true;
        revokeFilesystem(client.connection);
        service.sweep();
        // No owner lock exists yet. Checking locks alone would drop these capabilities.
        expect(backend.shared.ownerActive(client.connection.owner)).toBe(false);
        expect(service.resources().clients).toBe(1);
        expect(service.resources().retained).toBe(retained);
      }
      return result;
    }) as typeof Atomics.add;
    expect(() => client.retain(path.node)).toThrow();
    expect(raced).toBe(true);
    await waitForFilesystemQuiescence(client.connection);
    service.sweep();
    expect(service.resources().clients).toBe(0);
    expect(service.resources().retained).toBe(0);
  } finally { Atomics.add = add; client.dispose(); service.dispose(); }
});

test("nested file metadata locks keep their outer allocator section admitted", async () => {
  const { client, cleanup } = fixture();
  let waiting: Promise<void> | undefined;
  let settled = false;
  try {
    client.shared.mutate(new Int32Array(client.connection.epoch), undefined, () => {
      expect(client.shared.stat(0)?.size).toBe(4);
      expect(Atomics.load(new Int32Array(client.connection.sections), 0)).toBe(1);
      waiting = waitForFilesystemQuiescence(client.connection).then(() => { settled = true; });
      expect(settled).toBe(false);
      expect(Atomics.load(client.shared.cells, 1)).toBe(client.connection.owner);
    });
    await waiting;
    expect(settled).toBe(true);
    expect(Atomics.load(new Int32Array(client.connection.sections), 0)).toBe(0);
    expect(Atomics.load(client.shared.cells, 1)).toBe(0);
  } finally { cleanup(); }
});

test("a revoked live worker finishes its held write before quiescence, without a late mutation", async () => {
  const pair = createFilesystemConnection();
  const shared = new SharedFilesystemState(pair.client.shared, pair.client.maxBytes, pair.client.owner + 1, pair.client.segments);
  shared.register(0, { kind: "file", ino: 1, size: 4, mtime: 1 }, new Uint8Array([65, 66, 67, 68]));
  const capabilities = new Int32Array(pair.client.capabilities);
  Atomics.store(capabilities, 1, 0); Atomics.store(capabilities, 2, 0);
  const control = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./fixtures/filesystem-quiescence-guest.ts", import.meta.url).href);
  const cleanup = () => { Atomics.store(control, 0, 1); Atomics.notify(control, 0); worker.terminate(); pair.client.port.close(); pair.server.port.close(); };
  workerCleanups.add(cleanup);
  let held!: () => void, finished!: (result: { written: number; late: number }) => void;
  let failHeld!: (error: unknown) => void, failFinished!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { held = resolve; failHeld = reject; });
  const done = new Promise<{ written: number; late: number }>((resolve, reject) => { finished = resolve; failFinished = reject; });
  worker.onmessage = ({ data }) => { if (data.held) held(); else finished(data); };
  worker.onerror = error => { failHeld(error); failFinished(error); };
  try {
    worker.postMessage({ connection: pair.client, control: control.buffer }, [pair.client.port]);
    await ready;
    expect(shared.ownerActive(pair.client.owner)).toBe(true);
    let settled = false;
    const waiting = waitForFilesystemQuiescence(pair.client).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(Atomics.load(new Int32Array(pair.client.sections), 0)).toBe(1);
    Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    await waiting;
    reapFilesystem(pair.client);
    // The worker remains alive for its attempted second write. Admission must reject it;
    // quiescence cannot depend on a physical termination happening promptly.
    expect(await done).toEqual({ written: 1, late: -11 });
    const bytes = new Uint8Array(4);
    expect(shared.read(0, [bytes], 0)).toBe(4);
    expect(Array.from(bytes)).toEqual([90, 66, 67, 68]);
    expect(shared.write(0, [new Uint8Array([88])], 1)).toBe(1);
    expect(shared.ownerActive(pair.client.owner)).toBe(false);
  } finally { cleanup(); workerCleanups.delete(cleanup); }
});

for (const timing of ["pending", "before-registration"] as const) test(`a proven-dead reap settles a quiescence waiter (${timing})`, async () => {
  const identity = createFilesystemIdentity();
  const cells = new Int32Array(identity.sections);
  // Model a worker proven stopped after abandoning an admitted section. No live operation
  // will decrement this count. Ordinary revocation alone must never be treated as this proof.
  Atomics.store(cells, 0, 1);
  const asyncAtomics = Atomics as typeof Atomics & {
    waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> };
  };
  const waitAsync = asyncAtomics.waitAsync;
  let reaped = false;
  if (timing === "before-registration") asyncAtomics.waitAsync = (array, index, value) => {
    if (!reaped && array.buffer === identity.sections) { reaped = true; reapFilesystem(identity); }
    return waitAsync(array, index, value);
  };
  let settled = false;
  const waiting = waitForFilesystemQuiescence(identity).then(() => { settled = true; });
  try {
    if (timing === "pending") reapFilesystem(identity);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(Atomics.load(cells, 0)).toBe(1); // Reaping must not reset a late aborting entrant's count.
  } finally {
    asyncAtomics.waitAsync = waitAsync;
    Atomics.store(cells, 0, 0); Atomics.notify(cells, 0);
    await waiting;
  }
});

test("nested sections and concurrent identity users do not announce quiescence prematurely", async () => {
  const identity = createFilesystemIdentity();
  const first = new FilesystemSection(identity);
  const second = new FilesystemSection(identity);
  first.enter(); first.enter(); second.enter();
  let settled = false;
  const waiting = waitForFilesystemQuiescence(identity).then(() => { settled = true; });
  try {
    first.exit(); second.exit();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(Atomics.load(new Int32Array(identity.sections), 0)).toBe(1);
  } finally { first.exit(); }
  await waiting;
  expect(settled).toBe(true);
  expect(() => first.enter()).toThrow();
  expect(Atomics.load(new Int32Array(identity.sections), 0)).toBe(0);
});
