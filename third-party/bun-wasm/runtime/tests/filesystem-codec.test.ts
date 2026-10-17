import { afterEach, expect, test } from "bun:test";
import { DescriptorTable, type Resource } from "../core/descriptors";
import { withFileOffset } from "../core/open-file";
import { FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity, createFilesystemConnection, createProcessFilesystemIdentity, reapFilesystem, revokeFilesystem } from "../fs";
import { createFilesystemDescriptorCodec, type FilesystemDescriptorToken } from "../proc/filesystem-codec";
import { atomicHost } from "./fixtures/wasi-atomic-host";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  await client.asyncCall("writeFile", ["/file"], new TextEncoder().encode("abcdef"));
  const root = await client.asyncCall("preopen", ["/"]);
  const { node: handle } = await client.asyncCall("resolve", [root, "file"]);
  client.retain(handle);
  const parent = new DescriptorTable();
  const fd = parent.open({ kind: "file", handle, offset: 0, append: false }, 0x1fffffffn, 0n, () => client.release(handle));
  cleanups.push(() => parent.dispose());
  const identity = createProcessFilesystemIdentity(client.connection);
  const exporter = createFilesystemDescriptorCodec(client, identity);
  const token = exporter.export(parent.get(fd)!, 2) as FilesystemDescriptorToken;
  const childConnection = connectFilesystemIdentity(identity);
  service.connect(childConnection.server);
  const child = new FilesystemClient(childConnection.client);
  cleanups.push(() => child.dispose());
  const table = new DescriptorTable();
  const description = createFilesystemDescriptorCodec(child).import(structuredClone(token), 2);
  table.add(description, { rightsBase: 0x1fffffffn, rightsInheriting: 0n });
  cleanups.push(() => table.dispose());
  return { parent, fd, client, child, table, token, resource: description.resource as Extract<Resource, { kind: "file" }>, identity, service, backend };
}

test("transferred file shares offset and append flags without sharing descriptor bindings", async () => {
  const { parent, fd, resource } = await fixture();
  const original = parent.get(fd)!.resource as Extract<Resource, { kind: "file" }>;
  resource.offset = 3;
  expect(original.offset).toBe(3);
  original.append = true;
  expect(resource.append).toBe(true);
  const duplicate = parent.dup(fd);
  parent.close(fd);
  expect((parent.get(duplicate)!.resource as typeof resource).offset).toBe(3);
});

test("controller and worker copies release a transferred lifetime only once", async () => {
  const { child, identity, token, table, service } = await fixture();
  const controller = new DescriptorTable();
  controller.add(createFilesystemDescriptorCodec(identity, undefined, () => child.sweep()).import(structuredClone(token), 2), { rightsBase: 1n, rightsInheriting: 0n });
  table.dispose();
  controller.dispose();
  expect(new Int32Array(identity.capabilities)[token.reservation.targetKey + 1]).toBe(0);
  await child.asyncCall("listFiles", ["/"]);
  expect(service.resources().retained).toBeGreaterThan(0);
});

test("WASI ordinary write holds shared offset selection through its filesystem write", async () => {
  const { parent, fd, client, resource } = await fixture();
  const host = atomicHost(client, {});
  cleanups.push(() => host.wasi.descriptors.dispose());
  host.wasi.descriptors.inherit(8, parent.get(fd)!);
  const write = client.write.bind(client);
  let competing = 0;
  client.write = (...args) => { competing = withFileOffset(resource, () => 123, true); return write(...args); };
  host.iovecs([new TextEncoder().encode("z")]);
  expect(host.calls.fd_write!(8, 0, 1, 1024)).toBe(0);
  expect(competing).toBe(-6);
  expect(resource.offset).toBe(1);
});

test("a revoked lock owner is not stolen until reaping proves it stopped", async () => {
  const { client, resource, token } = await fixture();
  const lock = new Int32Array(token.offset!);
  Atomics.store(lock, 0, client.connection.owner);
  revokeFilesystem(client.connection);
  expect(withFileOffset(resource, () => 9, true)).toBe(-6);
  reapFilesystem(client.connection);
  expect(withFileOffset(resource, () => 9, true)).toBe(9);
  expect(Atomics.load(lock, 0)).toBe(0);
});

test("a revoked offset waiter clears admission without acquiring the held lock", async () => {
  const { client, child, resource, token } = await fixture();
  Atomics.store(new Int32Array(token.offset!), 0, client.connection.owner);
  revokeFilesystem(child.connection);
  expect(withFileOffset(resource, () => 9, true)).toBe(-11);
  expect(new Int32Array(child.connection.sections)[0]).toBe(0);
});


test("concurrent parent and worker writes consume one shared open-file offset", async () => {
  const { parent, fd, client, child, token } = await fixture();
  const guest = new Worker(new URL("./fixtures/filesystem-offset-guest.ts", import.meta.url).href);
  cleanups.push(() => { guest.terminate(); reapFilesystem(child.connection); });
  const start = new SharedArrayBuffer(8);
  const gate = new Int32Array(start);
  const result = new Promise<{ offset: number }>((resolve, reject) => { guest.onmessage = ({ data }) => resolve(data); guest.onerror = reject; });
  guest.postMessage({ connection: child.connection, token, count: 2000, start }, [child.connection.port]);
  const waiting = (Atomics as typeof Atomics & { waitAsync(array: Int32Array, index: number, value: number): { value: string | Promise<string> } }).waitAsync(gate, 0, 0);
  await waiting.value;
  Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
  const file = parent.get(fd)!.resource as Extract<Resource, { kind: "file" }>;
  const bytes = new Uint8Array([80]);
  for (let i = 0; i < 2000; i++) expect(withFileOffset(file, () => {
    const written = client.write(file.handle, [bytes], file.offset);
    if (written >= 0) file.offset += written;
    return written;
  })).toBe(1);
  await result;
  expect(file.offset).toBe(4000);
  const contents = new Uint8Array(4000);
  expect(client.read(file.handle, [contents], 0)).toBe(4000);
  expect(contents.filter(byte => byte === 80)).toHaveLength(2000);
  expect(contents.filter(byte => byte === 67)).toHaveLength(2000);
});

test("reaping a worker stopped inside its offset transaction recovers the lock", async () => {
  const { parent, fd, client, child, token } = await fixture();
  const guest = new Worker(new URL("./fixtures/filesystem-offset-guest.ts", import.meta.url).href);
  cleanups.push(() => { guest.terminate(); reapFilesystem(child.connection); });
  const result = new Promise<unknown>((resolve, reject) => { guest.onmessage = ({ data }) => resolve(data); guest.onerror = reject; });
  guest.postMessage({ connection: child.connection, token, count: 0, start: new SharedArrayBuffer(8), crash: true }, [child.connection.port]);
  expect(await result).toEqual({ locked: true });
  expect(new Int32Array(child.connection.sections)[0]).toBe(1);
  const file = parent.get(fd)!.resource as Extract<Resource, { kind: "file" }>;
  expect(withFileOffset(file, () => 1, true)).toBe(-6);
  guest.terminate();
  reapFilesystem(child.connection);
  expect(withFileOffset(file, () => { file.offset = 5; return 1; }, true)).toBe(1);
  expect(file.offset).toBe(5);
  expect(new Int32Array(client.connection.sections)[0]).toBe(0);
});


test("shared offsets preserve the existing number representation above signed-64 limits", async () => {
  const { parent, fd, resource } = await fixture();
  const original = parent.get(fd)!.resource as Extract<Resource, { kind: "file" }>;
  original.offset = 2 ** 63;
  expect(resource.offset).toBe(2 ** 63);
  resource.offset = Number.MAX_SAFE_INTEGER;
  expect(original.offset).toBe(Number.MAX_SAFE_INTEGER);
});
