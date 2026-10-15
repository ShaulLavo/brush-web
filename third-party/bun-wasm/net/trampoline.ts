// Installs JS functions into bun.wasm's `bun_wasm` host slots (docs/host-abi.md).
//
// A function table only holds wasm functions, and `WebAssembly.Function` (which would wrap a JS
// function directly) is not available in Safari. So we hand-encode a tiny module that imports each JS
// function with its exact `(i32 × n) -> i32` signature and exports a wasm function that calls it.
// Those exports are real wasm functions, which `table.grow(1, f)` accepts in every engine.

/** Slot names in ABI order; the index is the slot number. */
export const SLOT_NAMES = [
  "poll",
  "fetch",
  "fetch_head",
  "read",
  "write",
  "close",
  "listen",
  "local_port",
  "accept",
  "connect",
  "error",
  "peer_addr",
  "spawn",
  "child_wait",
  "child_pipe",
  "child_kill",
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** Number of i32 parameters of each slot (every slot returns one i32). */
const ARITY: Record<SlotName, number> = {
  poll: 1,
  fetch: 4,
  fetch_head: 3,
  read: 3,
  write: 3,
  close: 1,
  listen: 3,
  local_port: 1,
  accept: 1,
  connect: 3,
  error: 3,
  peer_addr: 3,
  spawn: 2,
  child_wait: 1,
  child_pipe: 2,
  child_kill: 2,
};

export type SlotFunction = (...args: number[]) => number;
export type SlotImpls = Partial<Record<SlotName, SlotFunction>>;

const ABI_VERSION = 1;

/** Unsigned LEB128. */
function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

const name = (s: string) => uleb(s.length).concat(Array.from(s, (c) => c.charCodeAt(0)));
const vec = (items: number[][]) => uleb(items.length).concat(items.flat());
const section = (id: number, body: number[]) => [id].concat(uleb(body.length), body);

const I32 = 0x7f;

/**
 * Encodes a module importing `h.f<i>` with `arities[i]` i32 params and exporting `f<i>`, a wasm
 * function forwarding its params to the import.
 */
export function trampolineModule(arities: readonly number[]): Uint8Array<ArrayBuffer> {
  const distinct = Array.from(new Set(arities));
  const typeOf = (arity: number) => distinct.indexOf(arity);
  const types = distinct.map((arity) => [0x60].concat(uleb(arity), new Array<number>(arity).fill(I32), [1, I32]));
  const imports = arities.map((arity, i) => name("h").concat(name(`f${i}`), [0x00], uleb(typeOf(arity))));
  const funcs = arities.map((arity) => uleb(typeOf(arity)));
  // Defined functions come after the imports in the function index space.
  const exports = arities.map((_, i) => name(`f${i}`).concat([0x00], uleb(arities.length + i)));
  const bodies = arities.map((arity, i) => {
    const code: number[] = [0x00]; // no locals
    for (let p = 0; p < arity; p++) code.push(0x20, ...uleb(p)); // local.get p
    code.push(0x10, ...uleb(i), 0x0b); // call import i; end
    return uleb(code.length).concat(code);
  });
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // "\0asm", version 1
  return new Uint8Array(
    header.concat(
      section(1, vec(types)),
      section(2, vec(imports)),
      section(3, vec(funcs)),
      section(7, vec(exports)),
      section(10, vec(bodies)),
    ),
  );
}

/** Slot value telling the guest to call through `sock_send` instead of the table (host.rs). */
const VIA_IMPORT = 0xffffffff;
/** The fd of those `sock_send` calls (host.rs `HOST_CALL_FD`). */
export const HOST_CALL_FD = 0x7fffb0b0;

/** The guest's slot table, or null when the module has none (another program). */
function slotTable(instance: WebAssembly.Instance): { view: DataView; ptr: number; count: number } | null {
  const exports = instance.exports;
  const slots = exports.bun_wasm_host_slots;
  const memory = exports.memory;
  if (typeof slots !== "function" || !(memory instanceof WebAssembly.Memory)) return null;
  const ptr = (slots as () => number)() >>> 0;
  const view = new DataView(memory.buffer);
  if (view.getUint32(ptr, true) !== ABI_VERSION) return null;
  return { view, ptr, count: view.getUint32(ptr + 4, true) };
}

/**
 * Like `installHostSlots`, without putting functions into the guest's table: each provided slot is
 * marked "call through an import", and the guest then calls WASI `sock_send` on HOST_CALL_FD with
 * `[slot, a, b, c, d]`. Returns the dispatcher for the WASI shim's `sock_send` (Wasi.hostCall), or
 * null when the module has no slot table. For engines where a cross-module function in the table
 * traps on call_indirect (`?slots=imports` in the playground).
 */
export function installHostSlotsViaImport(instance: WebAssembly.Instance, impls: SlotImpls): ((slot: number, args: number[]) => number) | null {
  const table = slotTable(instance);
  if (!table) return null;
  const fns: (SlotFunction | undefined)[] = SLOT_NAMES.map((slot) => impls[slot]);
  fns.forEach((fn, index) => {
    if (fn && index < table.count) table.view.setUint32(table.ptr + 8 + 4 * index, VIA_IMPORT, true);
  });
  return (slot, args) => {
    const fn = fns[slot];
    const name = SLOT_NAMES[slot];
    return fn && name ? fn(...args.slice(0, ARITY[name])) : -4;
  };
}

/**
 * Writes table indices of `impls` into the guest's host slots. Call after instantiation, before
 * `_start`. Returns the names of the installed slots, or [] when the module has no slot table
 * (an older bun.wasm, or another program).
 */
export function installHostSlots(instance: WebAssembly.Instance, impls: SlotImpls): SlotName[] {
  const exports = instance.exports;
  const table = exports.__indirect_function_table;
  const slots = exports.bun_wasm_host_slots;
  const memory = exports.memory;
  if (!(table instanceof WebAssembly.Table) || typeof slots !== "function" || !(memory instanceof WebAssembly.Memory)) return [];

  const ptr = (slots as () => number)() >>> 0;
  const view = new DataView(memory.buffer);
  const version = view.getUint32(ptr, true);
  const count = view.getUint32(ptr + 4, true);
  if (version !== ABI_VERSION) return [];

  const wanted = SLOT_NAMES.map((slot, index) => ({ slot, index, fn: impls[slot] })).filter(
    (s): s is { slot: SlotName; index: number; fn: SlotFunction } => s.fn !== undefined && s.index < count,
  );
  if (wanted.length === 0) return [];

  const module = new WebAssembly.Module(trampolineModule(wanted.map((s) => ARITY[s.slot])));
  const h = Object.fromEntries(wanted.map((s, i) => [`f${i}`, s.fn]));
  const trampolines = new WebAssembly.Instance(module, { h }).exports;
  wanted.forEach((s, i) => {
    const index = table.grow(1, trampolines[`f${i}`] as never);
    view.setUint32(ptr + 8 + 4 * s.index, index, true);
  });
  return wanted.map((s) => s.slot);
}
