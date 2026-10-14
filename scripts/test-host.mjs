Error.stackTraceLimit = 0;
import { build } from "esbuild";
import assert from "node:assert/strict";
const compiled = await build({
  stdin: {
    contents: `export { BrowserHost } from './src/wasi-host'; export { SharedBridge } from './src/bridge'; export { wasi } from '@bjorn3/browser_wasi_shim';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { BrowserHost, SharedBridge, wasi } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].contents).toString("base64")
);
const host = new BrowserHost(new SharedBridge());
const memory = new WebAssembly.Memory({ initial: 2 });
host.attach(memory, () => 1);
host.wasi.initialize({ exports: { memory } });
const bytes = new Uint8Array(memory.buffer),
  view = new DataView(memory.buffer),
  api = host.wasi.wasiImport,
  encoder = new TextEncoder();
function path(name) {
  const data = encoder.encode("home/guest/" + name);
  bytes.set(data, 4096);
  return data.length;
}
function open(name, flags = wasi.OFLAGS_CREAT, append = false) {
  const length = path(name);
  const status = api.path_open(
    3,
    0,
    4096,
    length,
    flags,
    BigInt(wasi.RIGHTS_FD_READ) | BigInt(wasi.RIGHTS_FD_WRITE),
    0n,
    append ? wasi.FDFLAGS_APPEND : 0,
    1024,
  );
  assert.equal(status, 0);
  return view.getUint32(1024, true);
}
function write(fd, value) {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  bytes.set(data, 8192);
  view.setUint32(256, 8192, true);
  view.setUint32(260, data.length, true);
  assert.equal(api.fd_write(fd, 256, 1, 1024), 0);
  assert.equal(view.getUint32(1024, true), data.length);
}
function read(fd, count) {
  view.setUint32(256, 8192, true);
  view.setUint32(260, count, true);
  assert.equal(api.fd_read(fd, 256, 1, 1024), 0);
  return bytes.slice(8192, 8192 + view.getUint32(1024, true));
}
function seek(fd, offset) {
  assert.equal(api.fd_seek(fd, BigInt(offset), wasi.WHENCE_SET, 1024), 0);
}
function unlink(name) {
  const length = path(name);
  assert.equal(api.path_unlink_file(3, 4096, length), 0);
}
const fd = open("host-test");
write(fd, "abcdef");
seek(fd, 2);
write(fd, "XY");
seek(fd, 0);
assert.equal(new TextDecoder().decode(read(fd, 6)), "abXYef");
assert.equal(api.fd_filestat_set_size(fd, 3n), 0);
assert.equal(api.fd_filestat_set_size(fd, 6n), 0);
seek(fd, 0);
assert.deepEqual(Array.from(read(fd, 6)), [97, 98, 88, 0, 0, 0]);
const append = open("host-test", 0, true);
seek(append, 0);
write(append, "tail");
seek(fd, 0);
assert.deepEqual(Array.from(read(fd, 10)), [97, 98, 88, 0, 0, 0, 116, 97, 105, 108]);
seek(fd, 100);
write(fd, new Uint8Array());
assert.equal(host.wasi.fds[fd].file.size, 10n);
assert.equal(api.fd_close(append), 0);
unlink("host-test");
seek(fd, 0);
assert.equal(read(fd, 10).length, 10);
assert.equal(api.fd_close(fd), 0);
for (let round = 0; round < 24; round++) {
  const file = open("reclaimed");
  const data = new Uint8Array(65536);
  for (let i = 0; i < 16; i++) write(file, data);
  assert.equal(api.fd_close(file), 0);
  unlink("reclaimed");
}
const quota = open("quota");
assert.equal(api.fd_filestat_set_size(quota, 8388608n), wasi.ERRNO_NOSPC);
assert.equal(api.fd_filestat_set_size(quota, 8388609n), wasi.ERRNO_NOSPC);
assert.equal(api.fd_close(quota), 0);
unlink("quota");
let created = 0;
for (; created < 1024; created++) {
  const length = path("object-" + created);
  const status = api.path_open(
    3,
    0,
    4096,
    length,
    wasi.OFLAGS_CREAT,
    BigInt(wasi.RIGHTS_FD_WRITE),
    0n,
    0,
    1024,
  );
  if (status === wasi.ERRNO_NOSPC) break;
  assert.equal(status, 0);
  assert.equal(api.fd_close(view.getUint32(1024, true)), 0);
}
assert.ok(created > 0 && created < 1024);
const existing = open("object-0", wasi.OFLAGS_CREAT, true);
write(existing, "existing-still-writable");
assert.equal(api.fd_close(existing), 0);
process.stdout.write(
  "WASI file overwrite, truncate/regrow, append, zero write, unlinked handles, capacity reclamation and quota checks passed.\n",
);
