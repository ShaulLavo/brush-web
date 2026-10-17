import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs";
import { DEFAULT_SHARED_MAX_BYTES, errno } from "../fs/protocol";

const MiB = 1024 * 1024;

test("allocation errors use WASI EFBIG, never EINTR", () => {
  expect(errno(new RangeError("file is too large"))).toBe(22);
});

test("shared files cross multiple 16 MiB segments and return their pages on removal", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    const bytes = new Uint8Array(48 * MiB);
    bytes[0] = 17;
    bytes[16 * MiB] = 23;
    bytes[32 * MiB] = 27;
    bytes[bytes.length - 1] = 29;
    await client.asyncCall("writeFile", ["/large"], bytes);
    expect(await client.asyncCall("readFile", ["/large"])).toEqual(bytes);
    await client.asyncCall("writeFile", ["/large"], bytes.subarray(0, 1));
    expect(await client.asyncCall("readFile", ["/large"])).toEqual(new Uint8Array([17]));
    await client.asyncCall("writeFile", ["/large"], bytes);
    await client.asyncCall("remove", ["/large"]);
    expect(backend.shared.resources().usedBytes).toBe(0);
    expect(backend.shared.buffer.byteLength).toBeLessThanOrEqual(24 * MiB);
  } finally { client.dispose(); service.dispose(); }
});

test("oversized growth reaches the caller as EFBIG and leaves the file usable", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    await client.asyncCall("writeFile", ["/file"], new Uint8Array([7]));
    const root = await client.asyncCall("preopen", ["/"]);
    const path = await client.asyncCall("resolve", [root, "file"]);
    expect(await client.asyncCall("grow", [path.node, DEFAULT_SHARED_MAX_BYTES + 1]).catch(error => error)).toMatchObject({ errno: 22 });
    expect(await client.asyncCall("readFile", ["/file"])).toEqual(new Uint8Array([7]));
  } finally { client.dispose(); service.dispose(); }
});
