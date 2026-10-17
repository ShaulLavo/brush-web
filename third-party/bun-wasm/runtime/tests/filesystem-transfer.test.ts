import { afterEach, expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity, createFilesystemConnection, createProcessFilesystemIdentity, reapFilesystem } from "../fs";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
class TrackingBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  retain(handle: number): void { super.retain(handle); this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1); }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle)! - 1;
    if (count) this.pins.set(handle, count); else this.pins.delete(handle);
  }
}
async function fixture() {
  const backend = new TrackingBackend();
  const service = new FilesystemService(backend);
  const root = createFilesystemConnection();
  service.connect(root.server);
  const client = new FilesystemClient(root.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  await client.asyncCall("writeFile", ["/file"], new TextEncoder().encode("inherited"));
  const directory = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [directory, "file"]);
  client.retain(path.node);
  return { backend, service, client, directory, path, handle: path.node as number };
}

test("reserved child file survives parent close, unlink and reap before child connects", async () => {
  const { backend, service, client, path, handle } = await fixture();
  const identity = createProcessFilesystemIdentity(client.connection);
  const reservation = client.reserve(handle, identity);
  client.release(handle);
  await client.asyncCall("removePath", [path, false]);
  reapFilesystem(client.connection);
  service.sweep();
  expect(backend.shared.hasFile(handle)).toBe(true);
  const connection = connectFilesystemIdentity(identity);
  service.connect(connection.server);
  const child = new FilesystemClient(connection.client);
  cleanups.push(() => child.dispose());
  child.adopt(reservation);
  const bytes = new Uint8Array(9);
  expect(child.read(handle, [bytes], 0)).toBe(9);
  expect(new TextDecoder().decode(bytes)).toBe("inherited");
  child.releaseReservation(reservation);
  await child.asyncCall("listFiles", ["/"]);
  service.sweep();
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("cancelled unpublished child reservations release the detached parent pin", async () => {
  const { backend, service, client, path, handle } = await fixture();
  const identity = createProcessFilesystemIdentity(client.connection);
  const reservation = client.reserve(handle, identity);
  client.release(handle);
  await client.asyncCall("removePath", [path, false]);
  reapFilesystem(client.connection);
  service.sweep();
  client.releaseReservation(reservation);
  service.sweep();
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("directory reservation transfers identity rather than reopening its old pathname", async () => {
  const { service, client, directory } = await fixture();
  const identity = createProcessFilesystemIdentity(client.connection);
  const reservation = client.reserve(directory, identity);
  const connection = connectFilesystemIdentity(identity);
  service.connect(connection.server);
  const child = new FilesystemClient(connection.client);
  cleanups.push(() => child.dispose());
  child.adopt(reservation);
  expect(child.shared.stat(directory)?.kind).toBe("directory");
  expect(await child.asyncCall("resolve", [directory, "file"])).toMatchObject({ node: expect.any(Number) });
  child.releaseReservation(reservation);
});


test("adoption trims the live source's final detached transfer pin", async () => {
  const { backend, service, client, handle, path } = await fixture();
  const identity = createProcessFilesystemIdentity(client.connection);
  const reservation = client.reserve(handle, identity);
  client.release(handle);
  await client.asyncCall("removePath", [path, false]);
  expect(backend.pins.get(handle)).toBe(1);
  const connection = connectFilesystemIdentity(identity);
  service.connect(connection.server);
  const child = new FilesystemClient(connection.client);
  cleanups.push(() => child.dispose());
  child.adopt(reservation);
  // Neither the parent process nor its client has exited. Adoption must retire its pin.
  expect(backend.pins.get(handle)).toBe(1);
  child.releaseReservation(reservation);
  // A missing overflow transfer is a port/queue barrier that does not itself trim capabilities.
  await expect(child.asyncCall("take", [-1, 0, 0])).rejects.toMatchObject({ errno: 11 });
  service.sweep();
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("releasing the last live target reservation promptly retires its detached pin", async () => {
  const { backend, service, client, handle, path } = await fixture();
  const identity = createProcessFilesystemIdentity(client.connection);
  const reservation = client.reserve(handle, identity);
  const connection = connectFilesystemIdentity(identity);
  service.connect(connection.server);
  const child = new FilesystemClient(connection.client);
  cleanups.push(() => child.dispose());
  child.adopt(reservation);
  await client.asyncCall("removePath", [path, false]);
  expect(backend.pins.get(handle)).toBe(2);
  child.releaseReservation(reservation);
  await expect(child.asyncCall("take", [-1, 0, 0])).rejects.toMatchObject({ errno: 11 });
  service.sweep();
  // The parent still holds its ordinary open; only the released target pin disappears.
  expect(backend.pins.get(handle)).toBe(1);
});
