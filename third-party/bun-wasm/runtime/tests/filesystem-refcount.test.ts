import { CAPABILITY_HEADER, CAPABILITY_WORDS } from "../fs/protocol";
import { afterEach, expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection, reapFilesystem, revokeFilesystem, type FilesystemConnection } from "../fs";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const encode = (value: string) => new TextEncoder().encode(value);
class TrackingBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  retain(handle: number): void { super.retain(handle); this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1); }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle)!;
    if (count === 1) this.pins.delete(handle); else this.pins.set(handle, count - 1);
  }
}
function fixture() {
  const backend = new TrackingBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  // A regression must fail rather than block the same-thread service on the old sync RPC.
  const call = client.call.bind(client);
  client.call = (...args) => {
    if (args[0] === "retain" || args[0] === "release") throw new Error(`unexpected reference RPC: ${args[0]}`);
    return call(...args);
  };
  return { backend, service, client };
}
async function file(client: FilesystemClient) {
  await client.asyncCall("writeFile", ["/shared"], encode("original"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "shared"]);
  return { root, path, handle: path.node as number };
}
function worker(connection: FilesystemConnection, scenario: string) {
  const guest = new Worker(new URL("./fixtures/filesystem-refcount-guest.ts", import.meta.url).href);
  cleanups.push(() => { guest.terminate(); reapFilesystem(connection); });
  const result = nextMessage(guest);
  guest.postMessage({ connection, scenario }, [connection.port]);
  return { guest, result };
}
function nextMessage(guest: Worker): Promise<any> {
  return new Promise((resolve, reject) => { guest.onmessage = ({ data }) => resolve(data); guest.onerror = reject; });
}
function table(connection: FilesystemConnection): Int32Array {
  const buffer = (connection as FilesystemConnection & { capabilities: SharedArrayBuffer }).capabilities;
  expect(buffer).toBeInstanceOf(SharedArrayBuffer);
  return new Int32Array(buffer);
}
function refIndex(cells: Int32Array, handle: number): number {
  for (let key = CAPABILITY_HEADER; key < cells.length; key += CAPABILITY_WORDS) if (Atomics.load(cells, key) === handle && Atomics.load(cells, key + 1) >= 0) return key + 1;
  throw new Error(`missing capability ${handle}`);
}

test("cached WASI path_open and close send no retain/release or other RPC", async () => {
  const { client } = fixture();
  await client.asyncCall("writeFile", ["/shared"], encode("original"));
  const { result } = worker(client.fork(), "hot");
  expect(await result).toEqual({ operations: [], errors: Array.from({ length: 40 }, () => 0), stderr: [] });
});

test("readdir caches the response epoch, not a later sibling mutation epoch", async () => {
  const { client } = fixture();
  const { result } = worker(client.fork(), "readdir");
  const entries = await result;
  expect(entries.before).not.toContain("after");
  expect(entries.after).toContain("after");
});

test("separate opens of one unlinked file survive one close and transient eviction", async () => {
  const { client, service, backend } = fixture();
  const { root, path, handle } = await file(client);
  client.retain(handle); client.retain(handle);
  client.release(handle);
  expect(await client.asyncCall("removePath", [path, false])).toBe(0);
  for (let i = 0; i < 300; i++) {
    await client.asyncCall("writeFile", [`/other-${i}`], new Uint8Array());
    await client.asyncCall("resolve", [root, `other-${i}`]);
  }
  expect(backend.pins.get(handle)).toBe(1);
  const bytes = new Uint8Array(8);
  expect(client.read(handle, [bytes], 0)).toBe(8);
  expect(new TextDecoder().decode(bytes)).toBe("original");
  expect(service.resources().transient).toBeLessThanOrEqual(256);
  client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(backend.pins.has(handle)).toBe(false);
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("RPC and local reference ownership cannot release each other's open", async () => {
  const { client, backend } = fixture();
  const { handle } = await file(client);
  await client.asyncCall("retain", [handle]);
  client.retain(handle);
  await client.asyncCall("release", [handle]);
  expect(backend.pins.get(handle)).toBe(1);
  expect(await client.asyncCall("release", [handle]).catch(error => error)).toMatchObject({ errno: 8 });
  const bytes = new Uint8Array(8);
  expect(client.read(handle, [bytes], 0)).toBe(8);
  client.release(handle);
  await client.asyncCall("retain", [handle]);
  await client.asyncCall("release", [handle]);
  expect(backend.pins.has(handle)).toBe(false);
});

test("a retain winning exactly at trim's CAS prevents eviction", async () => {
  const { client, backend } = fixture();
  const { root, handle } = await file(client);
  for (let i = 0; i < 256; i++) await client.asyncCall("writeFile", [`/other-${i}`], new Uint8Array());
  for (let i = 0; i < 255; i++) await client.asyncCall("resolve", [root, `other-${i}`]);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const compareExchange = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: Int32Array, at: number, expected: number, replacement: number) => {
    if (!raced && array.buffer === cells.buffer && at === index && expected === 0 && replacement === -1) {
      raced = true;
      client.retain(handle);
    }
    return compareExchange(array, at, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try { await client.asyncCall("resolve", [root, "other-255"]); }
  finally { Atomics.compareExchange = compareExchange; }
  expect(raced).toBe(true);
  expect(Atomics.load(cells, index)).toBe(1);
  expect(backend.pins.get(handle)).toBe(1);
  client.release(handle);
});

test("reused capability entries cannot make a stale retain acquire a different handle", async () => {
  const { client } = fixture();
  const { handle } = await file(client);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const compareExchange = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: Int32Array, at: number, expected: number, replacement: number) => {
    if (!raced && array.buffer === cells.buffer && at === index && expected === 0 && replacement === 1) {
      raced = true;
      expect(compareExchange(cells, index, 0, -1)).toBe(0);
      Atomics.store(cells, index - 1, handle + 100000);
      Atomics.store(cells, index, 0);
    }
    return compareExchange(array, at, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try {
    expect(() => client.retain(handle)).toThrow();
    expect(raced).toBe(true);
    expect(Atomics.load(cells, index)).toBe(0);
  } finally {
    Atomics.compareExchange = compareExchange;
    Atomics.store(cells, index - 1, handle);
    Atomics.store(cells, index, 0);
  }
});

test("closing a local open after revocation is a no-op, not a cancelled RPC", async () => {
  const { client, service, backend } = fixture();
  const { handle } = await file(client);
  client.retain(handle);
  revokeFilesystem(client.connection);
  expect(() => client.release(handle)).not.toThrow();
  reapFilesystem(client.connection);
  service.sweep();
  expect(backend.pins.size).toBe(0);
});

test("killing a guest with held local references releases its one backend pin", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/shared"], encode("original"));
  const connection = client.fork();
  const { guest, result } = worker(connection, "held");
  const { handle } = await result;
  expect(backend.pins.get(handle)).toBe(1);
  await client.asyncCall("remove", ["/shared"]);
  const stopped = nextMessage(guest);
  revokeFilesystem(connection);
  guest.postMessage({ scenario: "stat" });
  expect(await stopped).toEqual({ errno: 11 });
  guest.terminate();
  reapFilesystem(connection);
  service.sweep();
  expect(backend.pins.has(handle)).toBe(false);
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("the last local close frees an unlinked file below the transient budget", async () => {
  const { client, backend } = fixture();
  const { handle, path } = await file(client);
  client.retain(handle);
  expect(await client.asyncCall("removePath", [path, false])).toBe(0);
  expect(backend.shared.resources().usedBytes).toBeGreaterThan(0);
  client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(backend.shared.resources().usedBytes).toBe(0);
  expect(backend.pins.has(handle)).toBe(false);
});

test("unlink frees idle cached capabilities in sibling sessions", async () => {
  const { client, service, backend } = fixture();
  const { handle } = await file(client);
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => sibling.dispose());
  const root = await sibling.asyncCall("preopen", ["/"]);
  await sibling.asyncCall("resolve", [root, "shared"]);
  client.retain(handle); client.release(handle);
  expect(backend.pins.get(handle)).toBe(2);
  await sibling.asyncCall("remove", ["/shared"]);
  expect(backend.shared.resources().usedBytes).toBe(0);
  expect(backend.pins.has(handle)).toBe(false);
  expect(service.resources().transient).toBe(0);
});

test("in-capacity append and zero-byte positioned writes make no service calls", async () => {
  const { client } = fixture();
  const { handle } = await file(client);
  client.retain(handle);
  expect(client.setMtime(handle, 123)).toBe(0);
  client.call = () => { throw new Error("unexpected direct IO RPC"); };
  expect(client.write(handle, [new Uint8Array()], 0x10000000)).toBe(0);
  expect(client.append(handle, [new Uint8Array()])).toEqual({ written: 0, offset: 8 });
  expect(client.stat(handle).mtime).toBe(123);
  expect(client.append(handle, [encode("a"), encode("b")])).toEqual({ written: 2, offset: 10 });
  const bytes = new Uint8Array(10);
  expect(client.read(handle, [bytes], 0)).toBe(10);
  expect(new TextDecoder().decode(bytes)).toBe("originalab");
  client.release(handle);
});

test("more than 256 active opens do not evict the next returned capability", async () => {
  const { client, service } = fixture();
  const root = await client.asyncCall("preopen", ["/"]);
  const handles: number[] = [];
  for (let i = 0; i < 301; i++) {
    await client.asyncCall("writeFile", [`/active-${i}`], new Uint8Array());
    const path = await client.asyncCall("resolve", [root, `active-${i}`]);
    client.retain(path.node);
    handles.push(path.node);
  }
  expect(service.resources().transient).toBe(0);
  for (const handle of handles) client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(service.resources().transient).toBeLessThanOrEqual(256);
});

test("service memory accounting enumerates capability table metadata", () => {
  const { client, service } = fixture();
  const cells = table(client.connection);
  const resources = { ...service.resources() };
  expect(resources.capabilityBytes).toBe(cells.byteLength);
  expect(resources.metadataBytes).toBeGreaterThanOrEqual(cells.byteLength);
  expect(resources.bytes).toBe(resources.poolBytes! + resources.metadataBytes!);
});
