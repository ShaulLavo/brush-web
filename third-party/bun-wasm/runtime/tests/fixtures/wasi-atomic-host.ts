import { Wasi, type FileSystem } from "../../core";

const encoder = new TextEncoder();
const ALL = (1n << 29n) - 1n;
const signatures: Record<string, string> = {
  path_open: "iiiiijjii", fd_read: "iiii", fd_write: "iiii", fd_pwrite: "iiiji", fd_pread: "iiiji", fd_tell: "ii", fd_fdstat_set_flags: "ii",
};
function leb(value: number): number[] {
  const bytes: number[] = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
  return bytes;
}
function string(value: string): number[] { return leb(value.length).concat(Array.from(encoder.encode(value))); }
function section(id: number, payload: number[]): number[] { return [id].concat(leb(payload.length), payload); }
const names = Object.keys(signatures);
const types = names.flatMap(name => {
  const parameters = Array.from(signatures[name]!, type => type === "j" ? 0x7e : 0x7f);
  return [0x60].concat(leb(parameters.length), parameters, [1, 0x7f]);
});
const imports = names.flatMap((name, index) => string("wasi_snapshot_preview1").concat(string(name), [0], leb(index)));
const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
  section(1, leb(names.length).concat(types)), section(2, leb(names.length).concat(imports)),
)));

/** Use imports(), not private functions(): errno wrapping and memory refresh are part of the test. */
export function atomicHost(fs: FileSystem, preopens: Record<string, string> = { "/": "/" }) {
  const errors: string[] = [];
  const wasi = new Wasi({ args: [], env: {}, fs, preopens, stdout() {}, stderr(bytes) { errors.push(new TextDecoder().decode(bytes)); }, sleep() {} });
  const memory = new WebAssembly.Memory({ initial: 4 });
  Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
  wasi.start({ exports: { memory, _start() {} } } as unknown as WebAssembly.Instance);
  const calls = wasi.imports(module).wasi_snapshot_preview1 as Record<string, (...args: any[]) => number>;
  function view() { return new DataView(memory.buffer); }
  function open(path: string, flags = 0, fdflags = 0) {
    const bytes = encoder.encode(path);
    new Uint8Array(memory.buffer, 256, bytes.length).set(bytes);
    view().setUint32(1024, 0xdeadbeef, true);
    const error = calls.path_open!(3, 0, 256, bytes.length, flags, ALL, ALL, fdflags, 1024);
    return { error, fd: view().getUint32(1024, true) };
  }
  function iovecs(chunks: readonly Uint8Array[]) {
    let offset = 2048;
    for (let i = 0; i < chunks.length; i++) {
      view().setUint32(i * 8, offset, true);
      view().setUint32(i * 8 + 4, chunks[i]!.length, true);
      new Uint8Array(memory.buffer, offset, chunks[i]!.length).set(chunks[i]!);
      offset += chunks[i]!.length;
    }
  }
  function tell(fd: number) {
    const error = calls.fd_tell!(fd, 1040);
    if (error) throw new Error(`fd_tell failed: ${error}`);
    return Number(view().getBigUint64(1040, true));
  }
  return { wasi, memory, calls, errors, view, open, iovecs, tell };
}
