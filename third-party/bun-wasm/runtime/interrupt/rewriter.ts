/**
 * Fail-closed core-Wasm interrupt instrumentation. Supported features are MVP,
 * multi-value, sign extension, saturating conversions, bulk memory, untyped
 * reference tables, tail calls, and non-waiting threads instructions.
 *
 * Every defined-function entry and loop header consumes one module-wide tick.
 * The host is called only when the countdown reaches zero. Resetting BEFORE the
 * call makes synchronous reentry safe. A nonzero host result traps in Wasm;
 * interrupt delivery must not depend on Worker.terminate() stopping a host call.
 *
 * All custom sections are discarded: their names/offsets can become stale.
 * Relocation/linking/dynamic-linking metadata is instead refused, not silently
 * turned from an object/shared library into an executable module.
 */
export interface InterruptRewriteOptions {
  /** Positive i32 countdown; production uses 4096. */
  interval?: number;
  /** Benchmark baseline: always check at entries, countdown at loop headers. */
  policy?: "countdown" | "entry";
}

const encoder = new TextEncoder();
// Wasm names are length-delimited: a leading U+FEFF is content, not a BOM.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const HEADER = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const SECTION_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11];

function fail(reason: string): never {
  throw new Error(`Cannot instrument WebAssembly: ${reason}`);
}

class Reader {
  position = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  byte(): number {
    const value = this.bytes[this.position++];
    if (value === undefined) fail("truncated binary");
    return value;
  }
  u32(): number {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      if (i === 4 && byte > 15) fail("u32 LEB overflow");
      result += (byte & 127) * multiplier;
      if (!(byte & 128)) return result;
      multiplier *= 128;
    }
    return fail("u32 LEB overflow");
  }
  signed(maxBytes: number): number {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < maxBytes; i++) {
      const byte = this.byte();
      result += (byte & 127) * multiplier;
      multiplier *= 128;
      if (!(byte & 128)) return byte & 64 ? result - multiplier : result;
    }
    return fail("signed LEB overflow");
  }
  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.position) fail("truncated binary");
    const result = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }
  name(): string { return decoder.decode(this.take(this.u32())); }
  done(): void {
    if (this.position !== this.bytes.length) fail("unconsumed section or function body");
  }
}

/** Grow geometrically, and copy whole unchanged instruction spans, not opcodes. */
class Writer {
  private buffer: Uint8Array;
  private length = 0;
  constructor(capacity = 128) { this.buffer = new Uint8Array(capacity); }
  bytes(bytes: Uint8Array): void {
    const required = this.length + bytes.length;
    if (required > this.buffer.length) {
      const buffer = new Uint8Array(Math.max(required, this.buffer.length * 2));
      buffer.set(this.buffer.subarray(0, this.length));
      this.buffer = buffer;
    }
    this.buffer.set(bytes, this.length);
    this.length = required;
  }
  byte(byte: number): void {
    if (this.length === this.buffer.length) {
      const buffer = new Uint8Array(Math.max(16, this.length * 2));
      buffer.set(this.buffer);
      this.buffer = buffer;
    }
    this.buffer[this.length++] = byte;
  }
  u32(value: number): void {
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      this.byte(byte | (value ? 128 : 0));
    } while (value);
  }
  i32(value: number): void {
    for (;;) {
      const byte = value & 127;
      value >>= 7;
      const done = (value === 0 && !(byte & 64)) || (value === -1 && !!(byte & 64));
      this.byte(byte | (done ? 0 : 128));
      if (done) return;
    }
  }
  name(value: string): void {
    const bytes = encoder.encode(value);
    this.u32(bytes.length);
    this.bytes(bytes);
  }
  finish(): Uint8Array<ArrayBuffer> { return this.buffer.slice(0, this.length); }
}

function valueType(reader: Reader): void {
  switch (reader.byte()) {
    case 0x7f: case 0x7e: case 0x7d: case 0x7c: // numeric
    case 0x70: case 0x6f: // untyped funcref/externref
      return;
    default: fail("unsupported value type (SIMD, GC or typed reference)");
  }
}
function referenceType(reader: Reader): void {
  const type = reader.byte();
  if (type !== 0x70 && type !== 0x6f) fail("unsupported typed reference or GC heap type");
}
function blockType(reader: Reader): void {
  const type = reader.signed(5);
  if (type >= 0 || [-64, -1, -2, -3, -4, -16, -17].includes(type)) return;
  fail("unsupported block type (SIMD, GC or typed reference)");
}
function limits(reader: Reader, memory: boolean): void {
  const flags = reader.u32();
  // Threads are supported only for memories. No memory64, table64, custom
  // pages, shared-everything tables, or future limits flags.
  if (flags > (memory ? 3 : 1)) fail("unsupported memory64/table64/shared-table limits");
  reader.u32();
  if (flags & 1) reader.u32();
}
function memoryIndex(reader: Reader): void {
  if (reader.u32() !== 0) fail("multi-memory is unsupported");
}
function memoryArgument(reader: Reader): void {
  if (reader.u32() >= 64) fail("multi-memory or unknown memory argument flags");
  reader.u32();
}

interface InstructionContext {
  importedFunctions: number;
  checkpoint: Uint8Array;
}
function shifted(index: number, importedFunctions: number): number {
  return index < importedFunctions ? index : index + 1;
}

/** Parse one complete expression. Validation has already checked its typing. */
function instructions(reader: Reader, writer: Writer, context: InstructionContext, constant: boolean): void {
  let depth = 0;
  let copiedFrom = reader.position;
  const flush = (end: number) => writer.bytes(reader.bytes.subarray(copiedFrom, end));
  for (;;) {
    const start = reader.position;
    const opcode = reader.byte();
    if (constant && ![0x0b, 0x23, 0x41, 0x42, 0x43, 0x44, 0xd0, 0xd2].includes(opcode)) {
      fail("unsupported constant-expression instruction");
    }
    switch (opcode) {
      case 0x02: case 0x03: case 0x04:
        blockType(reader);
        depth++;
        if (opcode === 0x03) {
          flush(reader.position);
          writer.bytes(context.checkpoint);
          copiedFrom = reader.position;
        }
        break;
      case 0x0b:
        if (depth === 0) {
          flush(reader.position);
          return;
        }
        depth--;
        break;
      case 0x0c: case 0x0d: // branches
      case 0x20: case 0x21: case 0x22: // locals
      case 0x23: case 0x24: // globals
      case 0x25: case 0x26: // tables
        reader.u32();
        break;
      case 0x0e: {
        const count = reader.u32();
        for (let i = 0; i <= count; i++) reader.u32();
        break;
      }
      case 0x10: case 0x12: case 0xd2: { // call, return_call, ref.func
        const index = reader.u32();
        flush(start);
        writer.byte(opcode);
        writer.u32(shifted(index, context.importedFunctions));
        copiedFrom = reader.position;
        break;
      }
      case 0x11: case 0x13: // indirect calls: type index, table index
        reader.u32(); reader.u32();
        break;
      case 0x1c: {
        const count = reader.u32();
        for (let i = 0; i < count; i++) valueType(reader);
        break;
      }
      case 0x3f: case 0x40: memoryIndex(reader); break;
      case 0x41: reader.signed(5); break;
      case 0x42: reader.signed(10); break; // value unused; no lossy re-encoding
      case 0x43: reader.take(4); break;
      case 0x44: reader.take(8); break;
      case 0xd0: {
        // Unlike a table's reftype byte, ref.null carries signed LEB33.
        // Accept its legal padded encodings, but never concrete/GC heap types.
        const heapType = reader.signed(5);
        if (heapType !== -16 && heapType !== -17) fail("unsupported typed reference or GC heap type");
        break;
      }
      case 0xfc: {
        const sub = reader.u32();
        switch (sub) {
          case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: break; // trunc_sat
          case 8: reader.u32(); memoryIndex(reader); break; // memory.init
          case 9: case 13: reader.u32(); break; // data.drop, elem.drop
          case 10: memoryIndex(reader); memoryIndex(reader); break;
          case 11: memoryIndex(reader); break;
          case 12: case 14: reader.u32(); reader.u32(); break; // table.init/copy
          case 15: case 16: case 17: reader.u32(); break; // table.grow/size/fill
          default: fail(`unsupported bulk/numeric opcode 0xfc:${sub}`);
        }
        break;
      }
      case 0xfe: {
        const sub = reader.u32();
        if (sub === 1 || sub === 2) fail("atomic.wait is unbounded and unsupported");
        if (sub === 3) {
          if (reader.byte() !== 0) fail("unknown atomic.fence flags");
        } else if (sub === 0 || (sub >= 0x10 && sub <= 0x4e)) {
          memoryArgument(reader);
        } else fail(`unsupported atomic opcode 0xfe:${sub}`);
        break;
      }
      // Exact no-immediate core instructions. Numeric 0x45..0xc4 is the
      // contiguous MVP + sign-extension range; no proposal prefixes live here.
      case 0x00: case 0x01: case 0x05: case 0x0f: case 0x1a: case 0x1b: case 0xd1:
        break;
      default:
        if (opcode >= 0x28 && opcode <= 0x3e) memoryArgument(reader);
        else if (opcode < 0x45 || opcode > 0xc4) {
          fail(`unsupported opcode 0x${opcode.toString(16)} (SIMD/GC/EH/typed calls or unknown proposal)`);
        }
    }
  }
}

function checkpoint(global: number, hostFunction: number, interval: number): Uint8Array {
  const writer = new Writer();
  writer.byte(0x23); writer.u32(global); // global.get counter
  writer.byte(0x41); writer.i32(1);
  writer.byte(0x6b); // i32.sub
  writer.byte(0x24); writer.u32(global);
  writer.byte(0x23); writer.u32(global);
  writer.byte(0x45); // i32.eqz
  writer.byte(0x04); writer.byte(0x40); // if void
  writer.byte(0x41); writer.i32(interval);
  writer.byte(0x24); writer.u32(global); // reset before reentrant host call
  writer.bytes(hostCheck(hostFunction));
  writer.byte(0x0b);
  return writer.finish();
}
function hostCheck(hostFunction: number): Uint8Array {
  const writer = new Writer();
  writer.byte(0x10); writer.u32(hostFunction);
  writer.byte(0x04); writer.byte(0x40); // if returned signal != 0
  writer.byte(0x00); // unreachable
  writer.byte(0x0b);
  return writer.finish();
}

/** Instrument validated source bytes; compiled modules cannot be made safe here. */
export function rewriteInterrupts(input: Uint8Array, options: InterruptRewriteOptions = {}): Uint8Array<ArrayBuffer> {
  const interval = options.interval ?? 4096;
  const policy = options.policy ?? "countdown";
  if (!Number.isInteger(interval) || interval < 1 || interval > 0x7fffffff) fail("interval must be a positive i32");
  if (policy !== "countdown" && policy !== "entry") fail("unknown checkpoint policy");
  // Own the bytes: parser and validators must see the same snapshot, including
  // when the caller supplied a SharedArrayBuffer or a subarray of a larger file.
  const bytes = new Uint8Array(input);
  if (!WebAssembly.validate(bytes)) fail("original module is not valid WebAssembly");
  const reader = new Reader(bytes);
  const header = reader.take(8);
  if (!header.every((byte, i) => byte === HEADER[i])) fail("not a core Wasm version 1 module");
  const sections = new Map<number, Uint8Array>();
  while (reader.position < bytes.length) {
    const id = reader.byte();
    const data = reader.take(reader.u32());
    if (id === 0) {
      const name = new Reader(data).name();
      if (name === "linking" || name === "dylink" || name.startsWith("dylink.") || name.startsWith("reloc.")) {
        fail(`linker metadata ${name} is unsupported`);
      }
      continue;
    }
    if (!SECTION_ORDER.includes(id) || sections.has(id)) fail(`unsupported or duplicate section ${id}`);
    sections.set(id, data);
  }
  const get = (id: number) => new Reader(sections.get(id) ?? new Uint8Array([0]));
  let importedFunctions = 0;
  let globals = 0;
  let memories = 0;

  const typeReader = get(1);
  const typeCount = typeReader.u32();
  const typeStart = typeReader.position;
  for (let i = 0; i < typeCount; i++) {
    if (typeReader.byte() !== 0x60) fail("unsupported GC recursive/subtype definition");
    for (let vector = 0; vector < 2; vector++) {
      const count = typeReader.u32();
      for (let j = 0; j < count; j++) valueType(typeReader);
    }
  }
  typeReader.done();
  const typeWriter = new Writer();
  typeWriter.u32(typeCount + 1);
  typeWriter.bytes(typeReader.bytes.subarray(typeStart));
  typeWriter.bytes(new Uint8Array([0x60, 0, 1, 0x7f]));
  sections.set(1, typeWriter.finish());

  const importReader = get(2);
  const importCount = importReader.u32();
  const importStart = importReader.position;
  for (let i = 0; i < importCount; i++) {
    const namespace = importReader.name();
    importReader.name();
    // Third-party guests cannot register handled signals: the injected check
    // uses fatal outcomes only. Cooperative own guests bypass this rewriter.
    if (namespace === "runtime_proc") fail("reserved import namespace runtime_proc");
    switch (importReader.byte()) {
      case 0: importReader.u32(); importedFunctions++; break;
      case 1: referenceType(importReader); limits(importReader, false); break;
      case 2: limits(importReader, true); memories++; break;
      case 3:
        valueType(importReader);
        if (importReader.byte() > 1) fail("unsupported global mutability");
        globals++;
        break;
      default: fail("unsupported import kind (tags or unknown proposal)");
    }
  }
  importReader.done();
  const importWriter = new Writer();
  importWriter.u32(importCount + 1);
  importWriter.bytes(importReader.bytes.subarray(importStart));
  importWriter.name("runtime_proc"); importWriter.name("interrupted");
  importWriter.byte(0); importWriter.u32(typeCount);
  sections.set(2, importWriter.finish());

  const functionReader = get(3);
  const functionCount = functionReader.u32();
  for (let i = 0; i < functionCount; i++) functionReader.u32();
  functionReader.done();

  const tableReader = get(4);
  const tables = tableReader.u32();
  for (let i = 0; i < tables; i++) {
    referenceType(tableReader); limits(tableReader, false);
  }
  tableReader.done();
  const memoryReader = get(5);
  const memoryCount = memoryReader.u32();
  memories += memoryCount;
  if (memories > 1) fail("multi-memory is unsupported");
  for (let i = 0; i < memoryCount; i++) limits(memoryReader, true);
  memoryReader.done();

  const globalReader = get(6);
  const definedGlobals = globalReader.u32();
  globals += definedGlobals;
  const context: InstructionContext = { importedFunctions, checkpoint: checkpoint(globals, importedFunctions, interval) };
  const globalWriter = new Writer();
  globalWriter.u32(definedGlobals + 1);
  for (let i = 0; i < definedGlobals; i++) {
    const start = globalReader.position;
    valueType(globalReader);
    if (globalReader.byte() > 1) fail("unsupported global mutability");
    globalWriter.bytes(globalReader.bytes.subarray(start, globalReader.position));
    instructions(globalReader, globalWriter, context, true);
  }
  globalReader.done();
  globalWriter.byte(0x7f); globalWriter.byte(1); // private mutable i32
  globalWriter.byte(0x41); globalWriter.i32(interval); globalWriter.byte(0x0b);
  sections.set(6, globalWriter.finish());

  const exportReader = get(7);
  const exportWriter = new Writer();
  const exportCount = exportReader.u32();
  exportWriter.u32(exportCount);
  for (let i = 0; i < exportCount; i++) {
    const start = exportReader.position;
    exportReader.name();
    const kind = exportReader.byte();
    if (kind > 3) fail("unsupported export kind");
    exportWriter.bytes(exportReader.bytes.subarray(start, exportReader.position));
    const index = exportReader.u32();
    exportWriter.u32(kind === 0 ? shifted(index, importedFunctions) : index);
  }
  exportReader.done();
  if (sections.has(7)) sections.set(7, exportWriter.finish());
  const start = sections.get(8);
  if (start) {
    const reader = new Reader(start);
    const writer = new Writer();
    writer.u32(shifted(reader.u32(), importedFunctions));
    reader.done();
    sections.set(8, writer.finish());
  }

  const elementReader = get(9);
  const elementWriter = new Writer();
  const elementCount = elementReader.u32();
  elementWriter.u32(elementCount);
  for (let i = 0; i < elementCount; i++) {
    const flags = elementReader.u32();
    if (flags > 7) fail("unsupported element segment flags");
    elementWriter.u32(flags);
    if (flags === 2 || flags === 6) elementWriter.u32(elementReader.u32());
    if (flags === 0 || flags === 2 || flags === 4 || flags === 6) instructions(elementReader, elementWriter, context, true);
    if (flags === 1 || flags === 2 || flags === 3) {
      if (elementReader.byte() !== 0) fail("unsupported element kind");
      elementWriter.byte(0);
    }
    if (flags === 5 || flags === 6 || flags === 7) {
      const start = elementReader.position;
      referenceType(elementReader);
      elementWriter.bytes(elementReader.bytes.subarray(start, elementReader.position));
    }
    const count = elementReader.u32();
    elementWriter.u32(count);
    for (let j = 0; j < count; j++) {
      if (flags < 4) elementWriter.u32(shifted(elementReader.u32(), importedFunctions));
      else instructions(elementReader, elementWriter, context, true);
    }
  }
  elementReader.done();
  if (sections.has(9)) sections.set(9, elementWriter.finish());

  const codeReader = get(10);
  const codeWriter = new Writer(sections.get(10)?.length);
  const bodies = codeReader.u32();
  if (bodies !== functionCount) fail("function/code count mismatch");
  codeWriter.u32(bodies);
  const entry = policy === "entry" ? hostCheck(importedFunctions) : context.checkpoint;
  for (let i = 0; i < bodies; i++) {
    const body = new Reader(codeReader.take(codeReader.u32()));
    const writer = new Writer(body.bytes.length + entry.length + 32);
    const locals = body.u32();
    for (let j = 0; j < locals; j++) { body.u32(); valueType(body); }
    writer.bytes(body.bytes.subarray(0, body.position));
    writer.bytes(entry);
    instructions(body, writer, context, false);
    body.done();
    const result = writer.finish();
    codeWriter.u32(result.length);
    codeWriter.bytes(result);
  }
  codeReader.done();
  if (sections.has(10)) sections.set(10, codeWriter.finish());

  const dataReader = get(11);
  const dataWriter = new Writer();
  const segments = dataReader.u32();
  dataWriter.u32(segments);
  for (let i = 0; i < segments; i++) {
    const flags = dataReader.u32();
    if (flags > 2) fail("unsupported data segment flags");
    dataWriter.u32(flags);
    if (flags === 2) { memoryIndex(dataReader); dataWriter.u32(0); }
    if (flags !== 1) instructions(dataReader, dataWriter, context, true);
    const length = dataReader.u32();
    dataWriter.u32(length);
    dataWriter.bytes(dataReader.take(length));
  }
  dataReader.done();
  if (sections.has(11)) sections.set(11, dataWriter.finish());
  const count = sections.get(12);
  if (count) {
    const reader = new Reader(count);
    if (reader.u32() !== segments) fail("data count mismatch");
    reader.done();
  }
  const output = new Writer(bytes.length + 256);
  output.bytes(HEADER);
  for (const id of SECTION_ORDER) {
    const data = sections.get(id);
    if (!data) continue;
    output.byte(id); output.u32(data.length); output.bytes(data);
  }
  const result = output.finish();
  if (!WebAssembly.validate(result)) fail("rewritten module failed validation");
  return result;
}
