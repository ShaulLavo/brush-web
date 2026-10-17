import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rewriteInterrupts } from "../interrupt/rewriter.ts";

// Small binary fixtures keep the decoder tests independent of a WAT compiler.
const header = [0, 97, 115, 109, 1, 0, 0, 0];
function u(value: number): number[] {
  const result: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); result.push(byte | (value ? 128 : 0)); } while (value);
  return result;
}
function s(value: number): number[] {
  const result: number[] = [];
  for (;;) {
    const byte = value & 127;
    value >>= 7;
    const done = (value === 0 && !(byte & 64)) || (value === -1 && !!(byte & 64));
    result.push(byte | (done ? 0 : 128));
    if (done) return result;
  }
}
function name(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return u(bytes.length).concat(bytes);
}
const vec = (items: readonly (readonly number[])[]) => u(items.length).concat(...items);
const section = (id: number, bytes: readonly number[]) => [id].concat(u(bytes.length), bytes);
const binary = (...sections: readonly number[][]) => new Uint8Array(header.concat(...sections));
const type = (params: number[] = [], results: number[] = []) => [0x60].concat(vec(params.map(x => [x])), vec(results.map(x => [x])));
const types = (...items: number[][]) => section(1, vec(items));
const funcs = (...indices: number[]) => section(3, vec(indices.map(u)));
const code = (...bodies: number[][]) => section(10, vec(bodies.map(body => u(body.length + 1).concat([0], body))));
const exports = (...items: [string, number, number][]) => section(7, vec(items.map(([label, kind, index]) => name(label).concat([kind], u(index)))));
const simple = (body: number[]) => binary(types(type()), funcs(0), exports(["run", 0, 0]), code(body));
function instance(bytes: Uint8Array<ArrayBuffer>, interrupted: () => number = () => 0, imports: WebAssembly.Imports = {}) {
  expect(WebAssembly.validate(bytes)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { ...imports, runtime_proc: { interrupted } });
}
function run(guest: WebAssembly.Instance, ...args: number[]) {
  const fn = guest.exports.run;
  if (typeof fn !== "function") throw Error("Missing run export");
  return fn(...args);
}
function refused(bytes: Uint8Array, reason?: RegExp) {
  expect(() => rewriteInterrupts(bytes)).toThrow(reason);
}
function validRefused(bytes: Uint8Array, reason?: RegExp) {
  expect(WebAssembly.validate(bytes)).toBe(true);
  refused(bytes, reason);
}

test("validates the original, preserves the input, and validates the output", () => {
  const original = simple([0x0b]);
  const saved = original.slice();
  const output = rewriteInterrupts(original);
  expect(original).toEqual(saved);
  expect(WebAssembly.validate(output)).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(output))).toEqual([
    { module: "runtime_proc", name: "interrupted", kind: "function" },
  ]);
  refused(original.subarray(0, original.length - 1), /valid|truncat/i);
  refused(new Uint8Array(header.concat(section(1, [0x80, 0x80, 0x80, 0x80, 0x10]))), /valid|overflow/i);
  refused(new Uint8Array([1, 2, 3]), /valid|wasm/i);
});

test("runs under Node's native strip-only TypeScript and WebAssembly engine", () => {
  const source = `
    import { rewriteInterrupts } from ${JSON.stringify(new URL("../interrupt/rewriter.ts", import.meta.url).href)};
    const bytes = new Uint8Array(${JSON.stringify(Array.from(simple([0x03, 0x40, 0x0c, 0, 0x0b, 0x0b])))});
    let calls = 0;
    const output = rewriteInterrupts(bytes, { interval: 3 });
    const guest = new WebAssembly.Instance(new WebAssembly.Module(output), {
      runtime_proc: { interrupted() { return ++calls === 2 ? 15 : 0; } },
    });
    let trapped = false;
    try { guest.exports.run(); } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
      trapped = true;
    }
    if (!trapped || calls !== 2 || !WebAssembly.validate(output)) throw Error("Node interrupt smoke failed");
  `;
  const result = spawnSync("node", ["--input-type=module", "--eval", source], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("preserves leading BOM characters in length-delimited Wasm names", () => {
  const customName = "﻿linking";
  const custom = binary(section(0, name(customName)));
  expect(WebAssembly.validate(custom)).toBe(true);
  expect(WebAssembly.Module.customSections(new WebAssembly.Module(custom), customName)).toHaveLength(1);
  expect(WebAssembly.validate(rewriteInterrupts(custom))).toBe(true);

  const namespace = "﻿runtime_proc";
  const imported = binary(types(type()), section(2, vec([name(namespace).concat(name("run"), [0, 0])])));
  expect(WebAssembly.validate(imported)).toBe(true);
  const output = rewriteInterrupts(imported);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(output))).toEqual([
    { module: namespace, name: "run", kind: "function" },
    { module: "runtime_proc", name: "interrupted", kind: "function" },
  ]);
});

test("synthesizes missing type, import and global sections even for an empty module", () => {
  const output = rewriteInterrupts(binary());
  expect(WebAssembly.validate(output)).toBe(true);
  instance(output);
});

test("default countdown is shared across function invocations, not a per-entry host call", () => {
  let calls = 0;
  const guest = instance(rewriteInterrupts(simple([0x0b])), () => { calls++; return 0; });
  for (let i = 0; i < 4095; i++) run(guest);
  expect(calls).toBe(0);
  run(guest);
  expect(calls).toBe(1);
  for (let i = 0; i < 4096; i++) run(guest);
  expect(calls).toBe(2);
});

test("a signal traps at function entry, including a returning function with no loops", () => {
  const bytes = binary(types(type([], [0x7f])), funcs(0), exports(["run", 0, 0]), code([0x41, 42, 0x0b]));
  const guest = instance(rewriteInterrupts(bytes, { interval: 1 }), () => 15);
  expect(() => run(guest)).toThrow(WebAssembly.RuntimeError);
});

test("every loop header consumes countdown, including nested infinite loops", () => {
  const bodies = [
    [0x03, 0x40, 0x0c, 0, 0x0b, 0x0b],
    [0x02, 0x40, 0x03, 0x40, 0x03, 0x40, 0x0c, 0, 0x0b, 0x0b, 0x0b, 0x0b],
  ];
  for (const body of bodies) {
    let calls = 0;
    const guest = instance(rewriteInterrupts(simple(body), { interval: 7 }), () => ++calls === 3 ? 2 : 0);
    expect(() => run(guest)).toThrow(WebAssembly.RuntimeError);
    expect(calls).toBe(3);
  }
});

test("recursive calls and mutually recursive tail calls consume the shared counter", () => {
  for (const opcode of [0x10, 0x12]) {
    const bytes = binary(types(type()), funcs(0, 0), exports(["run", 0, 0]), code([opcode, 1, 0x0b], [opcode, 0, 0x0b]));
    let calls = 0;
    const guest = instance(rewriteInterrupts(bytes, { interval: 4 }), () => { calls++; return 9; });
    expect(() => run(guest)).toThrow(WebAssembly.RuntimeError);
    expect(calls).toBe(1);
  }
});

test("countdown spans caller and callee and restarts after a host callback reenters", () => {
  const bytes = binary(types(type()), funcs(0, 0), exports(["run", 0, 0], ["leaf", 0, 1]), code([0x10, 1, 0x0b], [0x0b]));
  let calls = 0;
  let guest: WebAssembly.Instance;
  guest = instance(rewriteInterrupts(bytes, { interval: 3 }), () => {
    calls++;
    const leaf = guest.exports.leaf;
    if (typeof leaf !== "function") throw Error("Missing leaf");
    leaf();
    return 0;
  });
  run(guest); // caller + leaf: counter 1
  expect(calls).toBe(0);
  run(guest); // caller resets before callback, callback's leaf consumes one
  expect(calls).toBe(1);
});

test("entry policy provides the benchmark baseline without removing loop checks", () => {
  let calls = 0;
  const guest = instance(rewriteInterrupts(simple([0x0b]), { policy: "entry" }), () => { calls++; return 0; });
  run(guest); run(guest);
  expect(calls).toBe(2);
  const loop = instance(rewriteInterrupts(simple([0x03, 0x40, 0x0c, 0, 0x0b, 0x0b]), { policy: "entry", interval: 3 }), () => ++calls === 4 ? 2 : 0);
  expect(() => run(loop)).toThrow(WebAssembly.RuntimeError);
  expect(calls).toBe(4);
});

test("remaps start, exports, direct/tail calls while imported function indices stay unchanged", () => {
  for (const opcode of [0x10, 0x12]) {
    let starts = 0;
    const bytes = binary(
      types(type(), type([], [0x7f])),
      section(2, vec([name("env").concat(name("start"), [0, 0])])),
      funcs(0, 1, 1),
      exports(["run", 0, 2]), section(8, [1]),
      code([0x10, 0, 0x0b], [opcode, 3, 0x0b], [0x41, 42, 0x0b]),
    );
    const guest = instance(rewriteInterrupts(bytes, { interval: 1 }), () => 0, { env: { start() { starts++; } } });
    expect(starts).toBe(1);
    expect(run(guest)).toBe(42);
  }
});

test("remaps all element forms, ref.func initializers, and indirect/tail-indirect calls", () => {
  for (let flag = 0; flag <= 7; flag++) {
    const element = u(flag);
    if (flag === 2 || flag === 6) element.push(0);
    if ([0, 2, 4, 6].includes(flag)) element.push(0x41, 0, 0x0b);
    if ([1, 2, 3].includes(flag)) element.push(0);
    if ([5, 6, 7].includes(flag)) element.push(0x70);
    element.push(1);
    element.push(...(flag < 4 ? [0] : [0xd2, 0, 0x0b]));
    const active = [0, 2, 4, 6].includes(flag);
    for (const call of [0x11, 0x13]) {
      const main = active ? [0x41, 0, call, 0, 0, 0x0b] : [0x41, 42, 0x0b];
      const bytes = binary(types(type([], [0x7f])), funcs(0, 0), section(4, [1, 0x70, 0, 1]),
        section(6, [1, 0x70, 0, 0xd2, 0, 0x0b]), exports(["run", 0, 1], ["table", 1, 0], ["ref", 3, 0]),
        section(9, [1].concat(element)), code([0x41, 42, 0x0b], main));
      const guest = instance(rewriteInterrupts(bytes));
      expect(run(guest)).toBe(42);
      const ref = guest.exports.ref;
      if (!(ref instanceof WebAssembly.Global)) throw Error("Missing ref global");
      expect(ref.value()).toBe(42);
      if (active) {
        const table = guest.exports.table;
        if (!(table instanceof WebAssembly.Table)) throw Error("Missing table");
        expect(table.get(0)()).toBe(42);
      }
    }
  }
});

test("existing imported/defined globals retain indices and the private countdown is not exported", () => {
  const bytes = binary(types(type([], [0x7f])), section(2, vec([name("env").concat(name("g"), [3, 0x7f, 0])])), funcs(0),
    section(6, [1, 0x7f, 1, 0x41, 7, 0x0b]), exports(["run", 0, 0], ["global", 3, 1]),
    code([0x23, 0, 0x23, 1, 0x6a, 0x0b]));
  const guest = instance(rewriteInterrupts(bytes, { interval: 1 }), () => 0, { env: { g: 35 } });
  expect(run(guest)).toBe(42);
  expect(Object.keys(guest.exports)).toEqual(["run", "global"]);
});

test("supports bulk memory/data count, passive data, and data offset expressions", () => {
  const bytes = binary(types(type()), funcs(0), section(5, [1, 0, 1]), exports(["run", 0, 0], ["memory", 2, 0]), section(12, [2]),
    code([0x41, 10, 0x41, 0, 0x41, 3, 0xfc, 8, 1, 0, 0xfc, 9, 1,
      0x41, 20, 0x41, 10, 0x41, 3, 0xfc, 10, 0, 0,
      0x41, 30, 0x41, 9, 0x41, 3, 0xfc, 11, 0, 0x0b]),
    section(11, [2, 0, 0x41, 0, 0x0b, 3, 1, 2, 3, 1, 3, 4, 5, 6]));
  const guest = instance(rewriteInterrupts(bytes));
  run(guest);
  const memory = guest.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw Error("Missing memory");
  const data = new Uint8Array(memory.buffer);
  expect(Array.from(data.subarray(0, 3))).toEqual([1, 2, 3]);
  expect(Array.from(data.subarray(10, 13))).toEqual([4, 5, 6]);
  expect(Array.from(data.subarray(20, 23))).toEqual([4, 5, 6]);
  expect(Array.from(data.subarray(30, 33))).toEqual([9, 9, 9]);
});

test("supports reference table operations and all table bulk instructions", () => {
  const bytes = binary(types(type(), type([], [0x7f])), funcs(1, 0), section(4, [2, 0x70, 0, 2, 0x70, 0, 2]), exports(["run", 0, 1], ["table", 1, 1]),
    section(9, [1, 1, 0, 1, 0]), code([0x41, 42, 0x0b], [
      0x41, 0, 0x41, 0, 0x41, 1, 0xfc, 12, 0, 0, 0xfc, 13, 0,
      0x41, 0, 0x41, 0, 0x41, 1, 0xfc, 14, 1, 0,
      0x41, 1, 0x41, 0, 0x25, 1, 0x26, 1,
      0xd0, 0x70, 0x41, 0, 0xfc, 15, 1, 0x1a,
      0xfc, 16, 1, 0x1a,
      0x41, 1, 0xd2, 0, 0x41, 1, 0xfc, 17, 1, 0x0b,
    ]));
  const guest = instance(rewriteInterrupts(bytes));
  run(guest);
  const table = guest.exports.table;
  if (!(table instanceof WebAssembly.Table)) throw Error("Missing table");
  expect(table.get(0)()).toBe(42);
  expect(table.get(1)()).toBe(42);
});

test("supports multi-value block signatures, numeric instructions and typed select", () => {
  const bytes = binary(types(type([], [0x7f, 0x7e]), type([], [0x7f])), funcs(1), exports(["run", 0, 0]),
    code([0x02, 0, 0x41, 42, 0x42, 1, 0x0b, 0x1a, 0x41, 2, 0x41, 1, 0x1c, 1, 0x7f, 0x0b]));
  expect(run(instance(rewriteInterrupts(bytes)))).toBe(42);
});

test("supports nonwaiting atomics, but refuses atomic.wait32 and atomic.wait64", () => {
  const make = (body: number[]) => binary(types(type()), funcs(0), section(5, [1, 3, 1, 1]), exports(["run", 0, 0]), code(body));
  run(instance(rewriteInterrupts(make([0x41, 0, 0x41, 1, 0xfe, 0x17, 2, 0, 0xfe, 3, 0, 0x0b]))));
  for (const [op, timeoutValue] of [[1, 0x41], [2, 0x42]]) {
    validRefused(make([0x41, 0, timeoutValue!, 0, 0x42, 0, 0xfe, op!, op === 1 ? 2 : 3, 0, 0x1a, 0x0b]), /wait|atomic/i);
  }
});

test("refuses SIMD, typed references, GC, exception handling and multi-memory", () => {
  validRefused(simple([0xfd, 12].concat(new Array<number>(16).fill(0), [0x1a, 0x0b])), /SIMD|opcode/i);
  validRefused(binary(types([0x60, 1, 0x7b, 0]), funcs(0), code([0x0b])), /type|SIMD/i);
  validRefused(binary(section(5, [2, 0, 1, 0, 1])), /memor/i);
  // Proposal availability varies by JS engine: rejection is required even when validation rejects first.
  const proposals = [
    binary(types([0x5f, 0])), // struct
    binary(types([0x60, 1, 0x63, 0x70, 0])), // nullable typed ref
    binary(section(5, [1, 4, 1])), // memory64
    binary(section(13, [0])), // tag section
    simple([0x06, 0x40, 0x0b, 0x0b]), // legacy try
    simple([0x1f, 0x40, 0, 0x0b, 0x0b]), // try_table
    simple([0x14, 0, 0x0b]), // call_ref
    simple([0xfb, 0, 0x0b]),
  ];
  for (const bytes of proposals) refused(bytes);
});

test("reserves the entire runtime_proc namespace, regardless of import kind or spelling", () => {
  for (const field of ["interrupted", "signal", "spawn"]) {
    validRefused(binary(types(type([], [0x7f])), section(2, vec([name("runtime_proc").concat(name(field), [0, 0])]))), /reserv|runtime_proc/i);
  }
  validRefused(binary(section(2, vec([name("runtime_proc").concat(name("memory"), [2, 0, 1])]))), /reserv|runtime_proc/i);
});

test("drops all custom metadata, including names/debug offsets, and refuses linker metadata", () => {
  const custom = (label: string) => section(0, name(label).concat([1, 2, 3]));
  const original = simple([0x0b]);
  for (const label of ["name", ".debug_info", "producers", "sourceMappingURL", "future-metadata"]) {
    const bytes = new Uint8Array(Array.from(original).concat(custom(label)));
    const module = new WebAssembly.Module(rewriteInterrupts(bytes));
    expect(WebAssembly.Module.customSections(module, label)).toEqual([]);
  }
  for (const label of ["linking", "dylink", "dylink.0", "reloc.CODE", "reloc.DATA"]) {
    validRefused(new Uint8Array(Array.from(original).concat(custom(label))), /link|reloc|metadata/i);
  }
});

test("fails closed on malformed sections, instructions, immediates and unknown proposals", () => {
  const malformed = [
    binary(section(14, [0])), binary(section(1, [0]), section(1, [0])),
    simple([0xff, 0x0b]), simple([0xfc, 18, 0x0b]), simple([0xfe, 0x4f, 0x0b]),
    simple([0x41, 0x80, 0x0b]), simple([0x02, 0x40, 0x0b]), simple([0x0b, 0x01]),
    binary(types(type()), funcs(0), section(10, [1, 3, 0, 0x0b])),
  ];
  for (const bytes of malformed) refused(bytes);
});

test("handles LEB index-width boundaries when an added import shifts function 127", () => {
  const count = 130;
  const bodies = Array.from({ length: count }, (_, i) => i === 0 ? [0x10].concat(u(127), [0x0b]) : [0x41].concat(s(i), [0x0b]));
  const bytes = binary(types(type([], [0x7f])), funcs(...new Array<number>(count).fill(0)), exports(["run", 0, 0]), code(...bodies));
  expect(run(instance(rewriteInterrupts(bytes)))).toBe(127);
});

test("checks every function body, including unreachable non-exported functions", () => {
  const bytes = binary(types(type()), funcs(0, 0), exports(["run", 0, 0]), code([0x0b], [0xfd, 12].concat(new Array<number>(16).fill(0), [0x1a, 0x0b])));
  validRefused(bytes, /SIMD|opcode/i);
});

test("loop checks are stack-neutral for multi-value loop parameters", () => {
  const bytes = binary(types(type([0x7f], [0x7f])), funcs(0), exports(["run", 0, 0]),
    code([0x20, 0, 0x03, 0, 0x21, 0, 0x20, 0, 0x41, 1, 0x6b, 0x22, 0, 0x20, 0, 0x0d, 0, 0x0b, 0x0b]));
  let calls = 0;
  const guest = instance(rewriteInterrupts(bytes, { interval: 2 }), () => { calls++; return 0; });
  expect(run(guest, 5)).toBe(0);
  expect(calls).toBe(3); // entry plus five backedges/header visits
});

test("both outer and inner loop headers consume ticks before executing their bodies", () => {
  let ticks = 0;
  let seen = -1;
  const bytes = binary(types(type()), section(2, vec([name("env").concat(name("tick"), [0, 0])])), funcs(0), exports(["run", 0, 1]),
    code([0x03, 0x40, 0x03, 0x40, 0x10, 0, 0x0c, 0, 0x0b, 0x0b, 0x0b]));
  const guest = instance(rewriteInterrupts(bytes, { interval: 3 }), () => { seen = ticks; return 2; }, { env: { tick() { ticks++; } } });
  expect(() => run(guest)).toThrow(WebAssembly.RuntimeError);
  expect(seen).toBe(0); // entry + outer + inner; no original instruction ran
});

test("preserves branch tables, alternate arms and raw float/integer immediates", () => {
  const bytes = binary(types(type([0x7f])), funcs(0), exports(["run", 0, 0]), code([
    0x02, 0x40, 0x02, 0x40, 0x20, 0, 0x0e, 2, 0, 1, 0, 0x0b, 0x0b,
    0x20, 0, 0x04, 0x40, 0x42, 0x7f, 0x1a, 0x05, 0x43, 0, 0, 0, 0x80, 0x1a, 0x0b,
    0x44, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f, 0x1a, 0x0b,
  ]));
  const guest = instance(rewriteInterrupts(bytes, { interval: 1 }));
  for (const index of [0, 1, 2, 3]) run(guest, index);
});

test("accepts imported table/memory limits, nonzero table indices and memory operands", () => {
  const imports = section(2, vec([
    name("env").concat(name("memory"), [2, 0, 1]),
    name("env").concat(name("table"), [1, 0x70, 1, 1, 2]),
  ]));
  const bytes = binary(types(type([], [0x7f])), imports, funcs(0, 0), section(4, [1, 0x70, 0, 1]),
    exports(["run", 0, 1]), section(9, [1, 2, 1, 0x41, 0, 0x0b, 0, 1, 0]), code([0x41, 42, 0x0b], [
      0x41, 0, 0x41, 42, 0x36, 2, 0, 0x41, 0, 0x28, 2, 0, 0x1a,
      0x3f, 0, 0x1a, 0x41, 0, 0x40, 0, 0x1a,
      0x41, 0, 0x13, 0, 1, 0x0b,
    ]));
  const guest = instance(rewriteInterrupts(bytes), () => 0, { env: {
    memory: new WebAssembly.Memory({ initial: 1 }),
    table: new WebAssembly.Table({ element: "anyfunc", initial: 1, maximum: 2 }),
  } });
  expect(run(guest)).toBe(42);
});

test("refuses unsupported types even when only a local or block mentions them", () => {
  validRefused(binary(types(type()), funcs(0), section(10, vec([[1, 1, 0x7b, 0x0b]].map(body => u(body.length).concat(body))))), /type|SIMD/i);
  validRefused(simple([0x02, 0x7b, 0x00, 0x0b, 0x1a, 0x0b]), /type|SIMD/i);
});

test("refuses extended constant expressions instead of assuming their instruction set", () => {
  refused(binary(section(6, [1, 0x7f, 0, 0x41, 1, 0x41, 2, 0x6a, 0x0b])));
});

test("supports padded signed ref.null heap types without accepting typed references", () => {
  // -16 in signed LEB33 (funcref), deliberately padded to two bytes.
  const bytes = simple([0xd0, 0xf0, 0x7f, 0xd1, 0x1a, 0x0b]);
  expect(WebAssembly.validate(bytes)).toBe(true);
  run(instance(rewriteInterrupts(bytes)));
});

test("supports saturating conversion opcodes and sign extension", () => {
  const operations = Array.from({ length: 8 }, (_, sub) => {
    const constant = sub % 4 < 2 ? [0x43, 0, 0, 0, 0] : [0x44, 0, 0, 0, 0, 0, 0, 0, 0];
    return constant.concat([0xfc, sub, 0x1a]);
  });
  const body = operations.flat().concat([0x41, 0x7f, 0xc0, 0x1a, 0x42, 0x7f, 0xc4, 0x1a, 0x0b]);
  run(instance(rewriteInterrupts(simple(body))));
});

test("accepts subarrays and shared-buffer inputs without leaking adjacent bytes", () => {
  const bytes = simple([0x0b]);
  const storage = new Uint8Array(bytes.length + 20);
  storage.set(bytes, 7);
  run(instance(rewriteInterrupts(storage.subarray(7, 7 + bytes.length))));
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
  shared.set(bytes);
  run(instance(rewriteInterrupts(shared)));
});

test("validates countdown options before writing bytes", () => {
  for (const interval of [0, -1, 1.5, NaN, Infinity, 0x80000000]) {
    expect(() => rewriteInterrupts(simple([0x0b]), { interval })).toThrow(/interval/i);
  }
  const bytes = simple([0x0b]);
  for (const interval of [1, 3, 4096, 0x7fffffff]) expect(WebAssembly.validate(rewriteInterrupts(bytes, { interval }))).toBe(true);
});
