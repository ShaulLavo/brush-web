import { expect, test } from "bun:test";
import { Wasi } from "../core";
import { MemFS } from "../fs/memory";
import { CHILD_FINAL_SIGNAL, SubprocessHost, childTransport, type ChildTransport } from "../../web/src/subprocess";

function signedLeb(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 127;
    value >>= 7;
    const done = (value === 0 && (byte & 64) === 0) || (value === -1 && (byte & 64) !== 0);
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
}

function name(value: string): number[] {
  return [value.length].concat(Array.from(new TextEncoder().encode(value)));
}
function section(id: number, bytes: number[]): number[] { return [id, bytes.length].concat(bytes); }

/** Original tiny guest: export memory and _start, which calls the actual WASI proc_exit import. */
function exitGuest(code: number): WebAssembly.Module {
  const body = [0, 0x41].concat(signedLeb(code), [0x10, 0, 0x0b]);
  return new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
    section(2, [1].concat(name("wasi_snapshot_preview1"), name("proc_exit"), [0, 0])),
    section(3, [1, 1]), section(5, [1, 0, 1]),
    section(7, [2].concat(name("memory"), [2, 0], name("_start"), [0, 1])),
    section(10, [1, body.length].concat(body)),
  )));
}

for (const [input, expected] of [
  [0, 0], [23, 23], [126, 126], [143, 143], [255, 255],
  [-1, 255], [-2, 254], [-3, 253], [256, 0], [257, 1],
  [-2147483648, 0], [2147483647, 255],
] as const) {
  test(`real WASI proc_exit(${input}) publishes ordinary byte-sized exit ${expected}`, () => {
    const errors: string[] = [];
    const wasi = new Wasi({
      args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, sleep() {},
      stderr(bytes) { errors.push(new TextDecoder().decode(bytes)); },
    });
    const module = exitGuest(input);
    const status = wasi.start(new WebAssembly.Instance(module, wasi.imports(module)));
    for (const fd of [0, 1, 2]) expect(wasi.descriptors.get(fd)).toBeUndefined();
    expect(errors).toEqual([]);

    let transport: ChildTransport | undefined;
    const host = new SubprocessHost({
      output() {}, launch(_metadata, reserved) { transport = reserved; return { terminate() {} }; },
    });
    try {
      const pid = host.spawn(JSON.stringify({ executable: "fixture", argv: ["fixture"] }));
      childTransport(transport!).finish(status);
      expect(host.wait(pid)).toBe(expected);
      expect(status).toBe(expected);
      expect(host.pipe(pid, CHILD_FINAL_SIGNAL)).toBe(0);
    } finally { host.dispose(); }
  });
}
