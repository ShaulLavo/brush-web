import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({
  stdin: {
    contents: `export * from './src/process-transport'; export * from './src/process-filesystem'; export * from './src/process-wasi'; export { Wasi } from './third-party/bun-wasm/wasi'; export * from './third-party/bun-wasm/subprocess-fs'; export { MemFS } from './third-party/bun-wasm/fs'; export { Directory, File } from '@bjorn3/browser_wasi_shim';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const {
  ProcessPipe,
  Wasi,
  pipeStdio,
  ProcessOutput,
  AGAIN,
  createTransport,
  Directory,
  File,
  MemFS,
  snapshotFilesystem,
  filesystemChanges,
  applyFilesystemChanges,
} = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].contents).toString("base64")
);
const zeroRead = new ProcessPipe(createTransport().stdin);
assert.equal(zeroRead.read(0), 0, "empty open pipe accepts a zero-byte read");
assert.equal(zeroRead.readBlocking(0), 0);
assert.equal(zeroRead.write(Uint8Array.of(42)), 1);
assert.equal(zeroRead.read(0), 0, "nonempty pipe accepts a zero-byte read");
assert.equal(zeroRead.readBlocking(0), 0);
assert.deepEqual(zeroRead.read(1), Uint8Array.of(42), "zero-byte reads preserve input");
zeroRead.close();
assert.equal(zeroRead.read(0), 0);
const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
const pipe = new ProcessPipe(createTransport().stdin);
assert.equal(pipe.write(bytes), 65536);
assert.equal(pipe.write(bytes.subarray(65536)), AGAIN);
assert.deepEqual(pipe.read(16384), bytes.slice(0, 16384));
assert.equal(pipe.write(bytes.subarray(65536)), 4464);
pipe.close();
assert.deepEqual(pipe.read(70000), bytes.slice(16384));
assert.equal(pipe.read(1), 0);
assert.equal(pipe.write(Uint8Array.of(1)), -1);
const wrap = new ProcessPipe(createTransport().stdin);
const positions = new Int32Array(wrap.buffer, 0, 4);
Atomics.store(positions, 0, -16);
Atomics.store(positions, 1, -16);
assert.equal(wrap.write(bytes.slice(0, 32)), 32);
wrap.close();
assert.deepEqual(wrap.read(32), bytes.slice(0, 32));
assert.equal(wrap.read(1), 0);
const transport = createTransport();
const writer = new ProcessOutput(transport.output);
const reader = new ProcessOutput(transport.output);
for (const [fd, text] of [
  [1, "a"],
  [2, "b"],
  [1, "c"],
])
  writer.writeAll(fd, new TextEncoder().encode(text));
new ProcessPipe(transport.output).close();
const events = [];
for (;;) {
  const frame = reader.read(16384);
  if (frame === 0) break;
  assert.equal(typeof frame, "object");
  events.push([frame.fd, new TextDecoder().decode(frame.bytes)]);
}
assert.deepEqual(events, [
  [1, "a"],
  [2, "b"],
  [1, "c"],
]);
assert.equal(reader.drained, true);
const encode = (value) => new TextEncoder().encode(value);
const file = new File(encode("before"));
const redirected = new File([]);
const root = new Directory([
  ["file", file],
  ["redirected", redirected],
  ["deleted", new File([])],
]);
const initial = snapshotFilesystem(root);
const child = new MemFS(structuredClone(initial));
child.writeFile("/file", "after");
child.remove("/deleted");
redirected.data = encode("during child");
applyFilesystemChanges(root, filesystemChanges(initial, child.root));
assert.equal(root.contents.get("file"), file);
assert.equal(new TextDecoder().decode(file.data), "after");
assert.equal(new TextDecoder().decode(redirected.data), "during child");
assert.equal(root.contents.has("deleted"), false);
const tooMany = new MemFS(snapshotFilesystem(root));
for (let i = 0; i < 1025; i++) tooMany.mkdirp(`/dir-${i}`);
assert.throws(
  () => applyFilesystemChanges(root, filesystemChanges(snapshotFilesystem(root), tooMany.root)),
  /quota/,
);
assert.equal(root.contents.size, 2);
console.log(
  "Process pipes, counter wrap, output order, file identity, delta merge, and transactional quota checks passed.",
);

const wasmString = (value) => [value.length].concat(Array.from(encode(value)));
const importsPayload = [2].concat(
  ["fd_fdstat_get", "fd_filestat_get"].flatMap((name) =>
    wasmString("wasi_snapshot_preview1").concat(wasmString(name), [0, 0]),
  ),
);
const stdioModule = new WebAssembly.Module(
  new Uint8Array(
    [
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      7,
      1,
      96,
      2,
      127,
      127,
      1,
      127,
      2,
      importsPayload.length,
    ].concat(importsPayload),
  ),
);
const guest = new Wasi({
  args: [],
  env: {},
  fs: new MemFS(),
  preopens: { "/": "/" },
  stdout() {},
  stderr() {},
  sleep() {},
});
const stdioImports = guest.imports(stdioModule);
const memory = new WebAssembly.Memory({ initial: 1 });
pipeStdio(stdioImports, () => memory);
guest.start({
  exports: {
    memory,
    _start() {
      for (const fd of [0, 1, 2]) {
        assert.equal(stdioImports.wasi_snapshot_preview1.fd_fdstat_get(fd, 0), 0);
        assert.equal(new DataView(memory.buffer).getUint8(0), 0);
        assert.equal(stdioImports.wasi_snapshot_preview1.fd_filestat_get(fd, 64), 0);
        assert.equal(new DataView(memory.buffer).getUint8(80), 0);
      }
      assert.equal(stdioImports.wasi_snapshot_preview1.fd_fdstat_get(3, 0), 0);
      assert.equal(new DataView(memory.buffer).getUint8(0), 3);
    },
  },
});
console.log("Child stdio reports pipes while preopened directories keep their file type.");
