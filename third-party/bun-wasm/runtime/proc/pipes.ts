import type { Readiness, Stream } from "../core/descriptors";
import { ProcessError } from "./types";

export const PipeErrno = Object.freeze({ AGAIN: 6, BADF: 8, INVAL: 28, NFILE: 41, PIPE: 64 });
export type PipeMode = "read" | "write";
export interface PipeOptions {
  /** Each process owns one bounded ring. Capacity must be a power of two. */
  capacity?: number;
  maxWriters?: number;
  maxReaders?: number;
  /** Share this word across a process service so one poll can wait on unrelated descriptors. */
  wake?: Int32Array;
  /** Worker-created pipes leave relay ownership to the supervisor. */
  relay?: "auto" | "manual";
  /** Service-wide canonical cursors let an authorized killer revoke unknown descendant pipes. */
  registry?: PipePublicationRegistry;
  /** Supervisor lifecycle callback after every reference/reservation is gone. */
  onClosed?(): void;
}
export interface PipePublicationRegistryHandle {
  buffer: SharedArrayBuffer;
  processCapacity: number;
  /** Initial allocation hint, not a per-process lifetime limit. */
  cellsPerProcess: number;
  wake: Int32Array;
}
/** Structured-cloneable capability. Transfer preserves one reference; forProcess/duplicate
 * reserve new references. None of these buffers may be recycled after revocation.
 */
export interface PipeEndpointHandle {
  /** SAB wrappers change identity when cloned; this stable id identifies the underlying pipe. */
  id: string;
  buffer: SharedArrayBuffer;
  capacity: number;
  maxWriters: number;
  maxReaders: number;
  wake: Int32Array;
  pid: number;
  mode: PipeMode;
  slot: number;
  lifetime: SharedArrayBuffer;
  registry?: PipePublicationRegistryHandle;
}

// The ring wrap/copy/notification scheme is adapted from web/src/subprocess.ts SharedPipe.
// Unlike SharedPipe, the committed cursor and its permanent close flag are ONE atomic value.
// Revocation freezes the committed watermark with atomic OR. A producer paused after copying
// cannot publish over that watermark: its compareExchange necessarily loses to revocation.
const STOP = 1n << 32n;
const MASK = STOP - 1n;
const ALLOCATED = 1n << 33n;
const RECORD_SHIFT = 34n;
const RECORD_MASK = (1n << 29n) - 1n;
const INFLIGHT = 1 << 30;
const RELAY_SELECTION = 1n << 62n;
const HEADER = 40;
const RING_HEADER = 40;
function records(capacity: number): number { return Math.min(capacity, 1024); }
function stride(capacity: number): number { return RING_HEADER + capacity + records(capacity) * 16; }
function recordCounter(value: bigint): number { return Number((value >> RECORD_SHIFT) & RECORD_MASK); }
function advance(value: bigint, bytes: number, record: number): bigint {
  return (value & (STOP | ALLOCATED)) | BigInt(bytes >>> 0) | (BigInt(record & Number(RECORD_MASK)) << RECORD_SHIFT);
}
let defaultWake: Int32Array | undefined;
type AsyncAtomics = { waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> } };
function waitChanged(word: Int32Array, observed: number): Promise<unknown> {
  const result = (Atomics as unknown as AsyncAtomics).waitAsync(word, 0, observed);
  return Promise.resolve(result.value);
}
function notify(word: Int32Array): void { Atomics.add(word, 0, 1); Atomics.notify(word, 0); }
function length(chunks: readonly Uint8Array[]): number { return chunks.reduce((total, chunk) => total + chunk.length, 0); }
function counter(value: bigint): number { return Number(value & MASK); }
function distance(written: bigint, read: bigint): number { return (counter(written) - counter(read)) >>> 0; }
function validLimit(value: number): boolean { return Number.isInteger(value) && value > 0 && value <= 65536; }

/** Host-only service capability: never expose this control buffer as guest WASM memory.
 * Authorization (parent chain/job ownership) belongs to the process service, BEFORE revoke.
 * Each process gets a permanent row. Canonical cells have append-only global indices in a
 * growable SAB: neither live-process pipe churn nor delayed calls can reuse a frozen cell.
 * A cell is initialized and linked BEFORE allocation's final revoked check. Killing marks
 * the row revoked before walking its immutable list; late-linked cells self-freeze before
 * mapping exposure. Abandoned allocations may leave holes but never block another process.
 * No guest holds a lock. This requires modern growable SharedArrayBuffer support.
 * Lifetime bounds: 1024 distinct pids by default; 16777216 global cells (256 MiB maximum
 * committed cell storage), about 4194304 simple pipes at four cells/pipe. Exhaustion is
 * ENFILE, never recycling or an unbounded allocation. Default initial storage is ~2 MiB.
 */
export class PipePublicationRegistry {
  readonly wake: Int32Array;
  private readonly owners: Int32Array;
  private readonly revoked: Int32Array;
  private readonly heads: Int32Array;
  private readonly allocated: Int32Array;
  private readonly cellBase: number;
  private readonly maxCells: number;
  private readonly data: PipePublicationRegistryHandle;
  constructor(options: { processCapacity?: number; cellsPerProcess?: number; maxCells?: number; wake?: Int32Array } = {}, attached?: PipePublicationRegistryHandle) {
    const processCapacity = attached?.processCapacity ?? options.processCapacity ?? 1024;
    const cellsPerProcess = attached?.cellsPerProcess ?? options.cellsPerProcess ?? 128;
    if (!validLimit(processCapacity) || !validLimit(cellsPerProcess)) throw new RangeError("invalid pipe registry capacity");
    this.wake = attached?.wake ?? options.wake ?? (defaultWake ??= new Int32Array(new SharedArrayBuffer(4)));
    if (!(this.wake.buffer instanceof SharedArrayBuffer) || this.wake.length !== 1) throw new TypeError("registry wake must be one shared int32");
    this.cellBase = 16 + processCapacity * 16;
    this.maxCells = attached ? ((attached.buffer as SharedArrayBuffer & { readonly maxByteLength: number }).maxByteLength - this.cellBase) / 16 : options.maxCells ?? 1 << 24;
    if (!Number.isInteger(this.maxCells) || this.maxCells <= 0 || this.maxCells > 1 << 24) throw new RangeError("invalid pipe registry cell limit");
    const initialCells = Math.min(processCapacity * cellsPerProcess, this.maxCells);
    // ES2022's declarations predate growable SABs; the host must implement the modern API.
    const SharedBuffer = SharedArrayBuffer as unknown as { new(length: number, options: { maxByteLength: number }): SharedArrayBuffer };
    const buffer = attached?.buffer ?? new SharedBuffer(this.cellBase + initialCells * 16, { maxByteLength: this.cellBase + this.maxCells * 16 });
    this.data = { buffer, processCapacity, cellsPerProcess, wake: this.wake };
    this.allocated = new Int32Array(buffer, 0, 1);
    this.owners = new Int32Array(buffer, 16, processCapacity);
    this.revoked = new Int32Array(buffer, 16 + processCapacity * 4, processCapacity);
    this.heads = new Int32Array(buffer, 16 + processCapacity * 8, processCapacity);
  }
  handle(): PipePublicationRegistryHandle { return { ...this.data }; }
  private process(pid: number, create: boolean): number {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error("invalid registry process");
    for (let probe = 0; probe < this.owners.length; probe++) {
      const slot = (pid + probe) % this.owners.length;
      let owner = Atomics.load(this.owners, slot);
      if (owner === pid) return slot;
      if (!owner && create) owner = Atomics.compareExchange(this.owners, slot, 0, pid);
      if (!owner) return create ? slot : -1;
      if (owner === pid) return slot;
    }
    if (create) throw new ProcessError(PipeErrno.NFILE, "pipe process registry is full");
    return -1;
  }
  isRevoked(pid: number): boolean {
    const slot = this.process(pid, false);
    return slot >= 0 && Atomics.load(this.revoked, slot) !== 0;
  }
  private reserveCell(): number {
    for (;;) {
      const index = Atomics.load(this.allocated, 0);
      if (index >= this.maxCells) throw new ProcessError(PipeErrno.NFILE, "pipe cursor registry limit reached");
      if (Atomics.compareExchange(this.allocated, 0, index, index + 1) === index) return index;
    }
  }
  private ensureCell(index: number): void {
    const buffer = this.data.buffer as SharedArrayBuffer & { grow(length: number): void; readonly maxByteLength: number };
    const needed = this.cellBase + (index + 1) * 16;
    if (buffer.byteLength >= needed) return;
    const target = Math.min(buffer.maxByteLength, Math.max(needed, buffer.byteLength * 2));
    try { buffer.grow(target); }
    catch (error) {
      // Another allocator can grow beyond our target between reading length and grow().
      // That operation cannot shrink the buffer, but its RangeError is not an allocation
      // failure if the cell we actually need is already available.
      if (!(error instanceof RangeError) || buffer.byteLength < needed) throw error;
    }
  }
  /** Internal registration; the returned global cell never moves or gets recycled. */
  allocate(pid: number): number {
    const slot = this.process(pid, true);
    if (Atomics.load(this.revoked, slot)) throw new Error("pipe process is revoked");
    const index = this.reserveCell();
    this.ensureCell(index);
    const entry = new Int32Array(this.data.buffer, this.cellBase + index * 16, 2);
    Atomics.store(entry, 0, pid);
    Atomics.store(this.canonical(index), 0, ALLOCATED);
    for (;;) {
      const head = Atomics.load(this.heads, slot);
      Atomics.store(entry, 1, head);
      if (Atomics.compareExchange(this.heads, slot, head, index + 1) === head) break;
    }
    // The next pointer is immutable from the successful head CAS onwards. Revocation
    // either sees this linked cell or won before linking and is observed here.
    if (Atomics.load(this.revoked, slot)) {
      Atomics.or(this.canonical(index), 0, STOP);
      throw new Error("pipe process is revoked");
    }
    return index;
  }
  canonical(index: number): BigInt64Array {
    const offset = this.cellBase + index * 16 + 8;
    if (!Number.isInteger(index) || index < 0 || index >= Atomics.load(this.allocated, 0) || offset + 8 > this.data.buffer.byteLength) throw new RangeError("invalid pipe cursor");
    // Per-cell views remain valid after growth, including in a handle cloned before growth.
    return new BigInt64Array(this.data.buffer, offset, 1);
  }
  revoke(pid: number): void {
    const slot = this.process(pid, true);
    Atomics.store(this.revoked, slot, 1);
    let link = Atomics.load(this.heads, slot);
    while (link) {
      const index = link - 1;
      Atomics.or(this.canonical(index), 0, STOP);
      link = Atomics.load(new Int32Array(this.data.buffer, this.cellBase + index * 16 + 4, 1), 0);
    }
    notify(this.wake);
  }
}
export function attachPipePublicationRegistry(handle: PipePublicationRegistryHandle): PipePublicationRegistry {
  return new PipePublicationRegistry({}, handle);
}

/** Single producer and one leased consumer. In relay mode only the supervisor consumes source
 * rings; workers consume their own delivery ring. No guest owns a lock another guest needs.
 */
interface PipeRecord { ticket: bigint; end: number; index: number; remaining: number }
class Ring {
  readonly refs: Int32Array;
  readonly pid: Int32Array;
  readonly demand: Int32Array;
  private readonly localPublished: BigInt64Array;
  private readonly localConsumed: BigInt64Array;
  private readonly mapping: Int32Array;
  private publication?: { index: number; cell: BigInt64Array };
  private consumption?: { index: number; cell: BigInt64Array };
  readonly bytes: Uint8Array;
  private readonly metadata: DataView;
  private readonly metadataWords: BigInt64Array;
  private readonly recordCapacity: number;
  constructor(buffer: SharedArrayBuffer, offset: number, readonly capacity: number, private readonly registry?: PipePublicationRegistry) {
    this.pid = new Int32Array(buffer, offset, 1);
    this.refs = new Int32Array(buffer, offset + 4, 1);
    this.localPublished = new BigInt64Array(buffer, offset + 8, 1);
    this.localConsumed = new BigInt64Array(buffer, offset + 16, 1);
    this.mapping = new Int32Array(buffer, offset + 24, 2);
    this.demand = new Int32Array(buffer, offset + 32, 1);
    this.bytes = new Uint8Array(buffer, offset + RING_HEADER, capacity);
    this.recordCapacity = records(capacity);
    this.metadata = new DataView(buffer, offset + RING_HEADER + capacity, this.recordCapacity * 16);
    this.metadataWords = new BigInt64Array(buffer, offset + RING_HEADER + capacity, this.recordCapacity * 2);
  }
  get published(): BigInt64Array {
    const index = Atomics.load(this.mapping, 0);
    if (!index) return this.localPublished;
    if (this.publication?.index !== index) this.publication = { index, cell: this.registry!.canonical(index - 1) };
    return this.publication.cell;
  }
  get consumed(): BigInt64Array {
    const index = Atomics.load(this.mapping, 1);
    if (!index) return this.localConsumed;
    if (this.consumption?.index !== index) this.consumption = { index, cell: this.registry!.canonical(index - 1) };
    return this.consumption.cell;
  }
  bind(pid: number, kind: "published" | "consumed"): void {
    if (!this.registry) return;
    const at = kind === "published" ? 0 : 1;
    if (Atomics.load(this.mapping, at)) return;
    let index: number;
    try { index = this.registry.allocate(pid); }
    catch (error) {
      if (kind === "consumed" && this.registry.isRevoked(pid)) { this.freezeReader(); return; }
      throw error;
    }
    const local = kind === "published" ? this.localPublished : this.localConsumed;
    Atomics.or(this.registry.canonical(index), 0, Atomics.load(local, 0));
    Atomics.compareExchange(this.mapping, at, 0, index + 1);
    Atomics.or(this.registry.canonical(index), 0, Atomics.load(local, 0));
  }
  get owner(): number { return Atomics.load(this.pid, 0); }
  get references(): number { return Atomics.load(this.refs, 0); }
  get closed(): boolean { return (Atomics.load(this.published, 0) & STOP) !== 0n; }
  get available(): number {
    const consumed = Atomics.load(this.consumed, 0);
    return Math.min(this.capacity, distance(Atomics.load(this.published, 0), consumed));
  }
  get free(): number { return this.capacity - this.available; }
  get writable(): boolean {
    const consumed = Atomics.load(this.consumed, 0), published = Atomics.load(this.published, 0);
    return this.free > 0 && ((recordCounter(published) - recordCounter(consumed)) & Number(RECORD_MASK)) < this.recordCapacity;
  }
  freezeWriter(): void { Atomics.or(this.localPublished, 0, STOP); Atomics.or(this.published, 0, STOP); }
  freezeReader(): void { Atomics.or(this.localConsumed, 0, STOP); Atomics.or(this.consumed, 0, STOP); }
  request(count: number): boolean { return Atomics.compareExchange(this.demand, 0, 0, Math.min(count, this.capacity)) === 0; }
  head(): PipeRecord | undefined {
    const consumed = Atomics.load(this.consumed, 0), published = Atomics.load(this.published, 0);
    if (recordCounter(consumed) === recordCounter(published)) return undefined;
    const index = recordCounter(consumed), slot = index % this.recordCapacity;
    const end = this.metadata.getUint32(slot * 16 + 8, true);
    return { index, end, remaining: (end - counter(consumed)) >>> 0, ticket: Atomics.load(this.metadataWords, slot * 2) };
  }
  write(chunks: readonly Uint8Array[], valid: () => boolean, ticket: bigint, atomic = true): number {
    const published = Atomics.load(this.published, 0);
    if ((published & STOP) !== 0n || !valid()) return -PipeErrno.BADF;
    const consumed = Atomics.load(this.consumed, 0);
    const free = this.capacity - distance(published, consumed), requested = length(chunks);
    const usedRecords = (recordCounter(published) - recordCounter(consumed)) & Number(RECORD_MASK);
    if (usedRecords >= this.recordCapacity || (atomic && requested <= Math.min(4096, this.capacity) && free < requested)) return -PipeErrno.AGAIN;
    const count = Math.min(requested, free);
    if (!count) return -PipeErrno.AGAIN;
    let copied = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, count - copied);
      if (!take) continue;
      const start = (counter(published) + copied) % this.capacity, first = Math.min(take, this.capacity - start);
      this.bytes.set(chunk.subarray(0, first), start);
      if (take > first) this.bytes.set(chunk.subarray(first, take), 0);
      copied += take;
      if (copied === count) break;
    }
    const end = (counter(published) + count) >>> 0, record = recordCounter(published), slot = record % this.recordCapacity;
    Atomics.store(this.metadataWords, slot * 2, ticket);
    this.metadata.setUint32(slot * 16 + 8, end, true);
    if (!valid()) return -PipeErrno.BADF;
    // Payload AND record metadata become visible in one canonical CAS. Revocation captures
    // precisely this committed prefix; unused tickets never block readers behind a zombie.
    const next = advance(published, end, record + 1);
    return Atomics.compareExchange(this.published, 0, published, next) === published ? count : -PipeErrno.BADF;
  }
  read(chunks: readonly Uint8Array[], supervisor = false): number {
    const consumed = Atomics.load(this.consumed, 0);
    if (!supervisor && (consumed & STOP) !== 0n) return -PipeErrno.AGAIN;
    const published = Atomics.load(this.published, 0);
    if (recordCounter(consumed) === recordCounter(published)) return (published & STOP) !== 0n ? 0 : -PipeErrno.AGAIN;
    const record = recordCounter(consumed), slot = record % this.recordCapacity;
    const end = this.metadata.getUint32(slot * 16 + 8, true), remaining = (end - counter(consumed)) >>> 0;
    const count = Math.min(length(chunks), remaining);
    const copy = new Uint8Array(count), start = counter(consumed) % this.capacity, first = Math.min(count, this.capacity - start);
    copy.set(this.bytes.subarray(start, start + first));
    if (count > first) copy.set(this.bytes.subarray(0, count - first), first);
    const next = advance(consumed, counter(consumed) + count, record + (count === remaining ? 1 : 0));
    if (Atomics.compareExchange(this.consumed, 0, consumed, next) !== consumed) return -PipeErrno.AGAIN;
    let at = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, count - at);
      chunk.set(copy.subarray(at, at + take));
      at += take;
      if (at === count) break;
    }
    return count;
  }
}

class PipeState {
  readonly control: Int32Array;
  readonly sequence: BigInt64Array;
  readonly selection: BigInt64Array;
  readonly changed: Int32Array;
  readonly writers: Ring[];
  readonly readers: Ring[];
  readonly capacity: number;
  readonly maxWriters: number;
  readonly maxReaders: number;
  readonly buffer: SharedArrayBuffer;
  readonly id: string;
  readonly wake: Int32Array;
  readonly registry?: PipePublicationRegistry;
  constructor(handle: Pick<PipeEndpointHandle, "id" | "buffer" | "capacity" | "maxWriters" | "maxReaders" | "wake" | "registry">) {
    this.buffer = handle.buffer;
    this.id = handle.id;
    this.registry = handle.registry ? attachPipePublicationRegistry(handle.registry) : undefined;
    this.capacity = handle.capacity;
    this.maxWriters = handle.maxWriters;
    this.maxReaders = handle.maxReaders;
    this.wake = handle.wake;
    this.control = new Int32Array(this.buffer, 0, 6);
    this.sequence = new BigInt64Array(this.buffer, 24, 1);
    this.selection = new BigInt64Array(this.buffer, 32, 1);
    this.changed = new Int32Array(this.buffer, 4, 1);
    const ringStride = stride(this.capacity);
    this.writers = Array.from({ length: this.maxWriters }, (_, slot) => new Ring(this.buffer, HEADER + slot * ringStride, this.capacity, this.registry));
    this.readers = Array.from({ length: this.maxReaders }, (_, slot) => new Ring(this.buffer, HEADER + (this.maxWriters + slot) * ringStride, this.capacity, this.registry));
  }
  get relay(): boolean { return Atomics.load(this.control, 0) !== 0; }
  get disposed(): boolean { return Atomics.load(this.control, 3) !== 0; }
  get closed(): boolean {
    const generation = Atomics.load(this.control, 5);
    if (this.disposed || generation === -1) return true;
    if (generation === 0) return false;
    const alive = this.writers.concat(this.readers).some(ring => {
      const pid = ring.owner;
      if (!pid || this.registry?.isRevoked(Math.abs(pid))) return false;
      return pid < 0 ? !ring.closed : ring.references > 0;
    });
    if (alive) return false;
    // A new reservation changes the generation AFTER publishing its negative owner but
    // BEFORE publishing references. A scan that passed that slot cannot retire the pipe.
    return Atomics.compareExchange(this.control, 5, generation, -1) === generation;
  }
  private admit(): void {
    for (;;) {
      const generation = Atomics.load(this.control, 5);
      if (generation === -1 || this.disposed) throw new Error("pipe endpoint is closed");
      const next = generation === -2 ? 1 : (generation + 1) | 0;
      if (Atomics.compareExchange(this.control, 5, generation, next) === generation) return;
    }
  }
  signal(): void { notify(this.changed); notify(this.wake); }
  readerAlive(ring: Ring): boolean { return ring.owner > 0 && ring.references > 0 && !this.registry?.isRevoked(ring.owner); }
  hasReaders(): boolean { return this.readers.some(ring => this.readerAlive(ring)); }
  eof(): boolean { return this.writers.every(ring => ring.owner === 0 || ring.closed); }
  queued(): number { return this.writers.reduce((total, ring) => total + (ring.owner > 0 ? ring.available : 0), 0); }
  relayAvailable(): number {
    return this.queued() + Math.max(0, Atomics.load(this.control, 4)) + this.readers.reduce((total, ring) => total + (ring.owner > 0 ? ring.available : 0), 0);
  }
  nextTicket(): bigint { return BigInt.asIntN(64, Atomics.add(this.sequence, 0, 1n) + 1n); }
  source(supervisor: boolean): { ring: Ring; record: PipeRecord; pin: bigint } | undefined {
    const selection = Atomics.load(this.selection, 0), relay = selection & RELAY_SELECTION;
    if (!supervisor && relay) return undefined;
    const selected = Number(selection & 0x1ffffn) - 1;
    if (selected >= 0) {
      const ring = this.writers[selected]!, record = ring.head();
      if (record?.index === Number((selection >> 17n) & RECORD_MASK)) return { ring, record, pin: selection };
      // A reader may die after consuming the last byte but before releasing its pin.
      // Canonical consumption makes stale pins helpable without that reader's cleanup.
      if (Atomics.compareExchange(this.selection, 0, selection, relay) === selection) return this.source(supervisor);
      return undefined;
    }
    // Exclude tickets issued after the scan begins: otherwise an earlier slot scanned empty
    // could commit A before B starts, but the same scan would incorrectly choose later B.
    const ceiling = Atomics.load(this.sequence, 0);
    let chosen: { ring: Ring; record: PipeRecord; pin: bigint } | undefined;
    for (let index = 0; index < this.writers.length; index++) {
      const ring = this.writers[index]!;
      if (ring.owner <= 0) continue;
      const record = ring.head();
      if (!record || BigInt.asIntN(64, record.ticket - ceiling) > 0n) continue;
      if (chosen && BigInt.asIntN(64, record.ticket - chosen.record.ticket) >= 0n) continue;
      chosen = { ring, record, pin: relay | BigInt(index + 1) | (BigInt(record.index) << 17n) };
    }
    if (!chosen || Atomics.compareExchange(this.selection, 0, relay, chosen.pin) !== relay) return undefined;
    return chosen;
  }
  consume(source: { ring: Ring; record: PipeRecord; pin: bigint }, chunks: readonly Uint8Array[], supervisor: boolean): number {
    const result = source.ring.read(chunks, supervisor);
    if (source.ring.head()?.index !== source.record.index) Atomics.compareExchange(this.selection, 0, source.pin, source.pin & RELAY_SELECTION);
    return result;
  }
  switchToRelay(): void {
    Atomics.or(this.selection, 0, RELAY_SELECTION);
    // Revoke the old direct consumer's lease BEFORE publishing relay mode. A delayed direct
    // read cannot advance a ring's cursor after the supervisor takes over consumption.
    for (const ring of this.writers) ring.freezeReader();
    Atomics.store(this.control, 0, 1);
    this.signal();
  }
  retain(pid: number, mode: PipeMode): PipeEndpoint {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || this.closed) throw new Error("invalid pipe process");
    if (this.registry?.isRevoked(pid) || this.writers.concat(this.readers).some(ring => ring.owner === pid && ring.references < 0)) throw new Error("pipe process is revoked");
    const rings = mode === "write" ? this.writers : this.readers;
    // Deterministic probing makes simultaneous reservation of the SAME pid contend on the
    // same slot. Negative owner is an unpublished reservation, never a live writer/reader.
    let selected = -1;
    for (let probe = 0; probe < rings.length; probe++) {
      const slot = (pid + probe) % rings.length;
      const ring = rings[slot]!;
      const owner = ring.owner;
      if (owner === -pid) throw new Error("pipe process reservation is in progress");
      if (owner === pid) {
        for (;;) {
          const refs = ring.references;
          if (refs <= 0) throw new Error("pipe endpoint is closed");
          if (Atomics.compareExchange(ring.refs, 0, refs, refs + 1) === refs) break;
        }
        selected = slot;
        break;
      }
      if (owner !== 0 || Atomics.compareExchange(ring.pid, 0, 0, -pid) !== 0) continue;
      try {
        this.admit();
        ring.bind(pid, "published");
        if (mode === "read") ring.bind(pid, "consumed");
        else if (!this.relay) {
          const reader = this.readers.find(candidate => this.readerAlive(candidate));
          if (reader) ring.bind(reader.owner, "consumed");
        }
        if (this.registry?.isRevoked(pid)) throw new Error("pipe process is revoked");
        if (Atomics.compareExchange(ring.refs, 0, 0, 1) !== 0) throw new Error("pipe process is revoked");
      } catch (error) {
        ring.freezeWriter();
        Atomics.store(ring.refs, 0, -1);
        Atomics.store(ring.pid, 0, pid);
        this.signal();
        throw error;
      }
      Atomics.store(ring.pid, 0, pid);
      selected = slot;
      break;
    }
    if (selected < 0) throw new Error(`pipe ${mode} process limit reached`);
    const endpoint = new PipeEndpoint(this, pid, mode, selected, new SharedArrayBuffer(4));
    try {
      // Both sides publish identity before checking the other side. Concurrent first reader
      // and writer reservations cannot both miss registering the direct consumer's lease.
      // No producer can publish bytes until its reservation has returned the endpoint.
      if (mode === "write" && !this.relay) {
        const reader = this.readers.find(candidate => this.readerAlive(candidate));
        if (reader) rings[selected]!.bind(reader.owner, "consumed");
      }
      if (mode === "read") {
        if (this.readers.some(ring => ring.owner > 0 && ring.owner !== pid)) this.switchToRelay();
        else if (!this.relay) for (const source of this.writers) if (source.owner > 0) source.bind(pid, "consumed");
      }
      this.signal();
      return endpoint;
    } catch (error) { endpoint.close(); throw error; }
  }
  revoke(pid: number, mode?: PipeMode): void {
    const groups = mode === "read" ? [this.readers] : mode === "write" ? [this.writers] : [this.writers, this.readers];
    for (const rings of groups) {
      for (const ring of rings) {
        if (Math.abs(ring.owner) !== pid || ring.references < 0) continue;
        ring.freezeWriter();
        if (rings === this.readers) {
          ring.freezeReader();
          if (!this.relay) for (const source of this.writers) source.freezeReader();
        }
        Atomics.exchange(ring.refs, 0, -1);
      }
    }
    this.signal();
  }
}

/** A reference to one reading/writing process's endpoint, usable directly or after cloning its
 * handle into a worker. Duplicated descriptors should share one OpenDescription as usual.
 */
export class PipeEndpoint implements Stream {
  readonly kind = "pipe" as const;
  readonly notification: Int32Array;
  private readonly lifetime: Int32Array;
  constructor(private readonly state: PipeState, readonly pid: number, readonly mode: PipeMode, readonly slot: number, lifetime: SharedArrayBuffer) {
    this.notification = state.wake;
    this.lifetime = new Int32Array(lifetime);
  }
  private get ring(): Ring { return (this.mode === "write" ? this.state.writers : this.state.readers)[this.slot]!; }
  private get live(): boolean { return !this.state.disposed && Atomics.load(this.lifetime, 0) === 0 && this.ring.references > 0 && !this.state.registry?.isRevoked(this.pid); }
  handle(): PipeEndpointHandle {
    return {
      id: this.state.id, buffer: this.state.buffer, capacity: this.state.capacity, maxWriters: this.state.maxWriters, maxReaders: this.state.maxReaders,
      wake: this.notification, pid: this.pid, mode: this.mode, slot: this.slot, lifetime: this.lifetime.buffer as SharedArrayBuffer,
      registry: this.state.registry?.handle(),
    };
  }
  forProcess(pid: number): PipeEndpoint {
    if (!this.live) throw new Error("pipe endpoint is closed");
    return pid === this.pid ? this : this.state.retain(pid, this.mode);
  }
  inherit(pid: number): PipeEndpoint { return this.forProcess(pid); }
  revoke(): void { this.state.registry?.revoke(this.pid); this.state.revoke(this.pid, this.mode); }
  close(): void {
    if (Atomics.compareExchange(this.lifetime, 0, 0, 1) !== 0) return;
    for (;;) {
      const refs = this.ring.references;
      if (refs <= 0) break;
      if (Atomics.compareExchange(this.ring.refs, 0, refs, refs - 1) !== refs) continue;
      if (refs === 1) {
        this.ring.freezeWriter();
        if (this.mode === "read") {
          this.ring.freezeReader();
          if (!this.state.relay) for (const source of this.state.writers) source.freezeReader();
        }
      }
      break;
    }
    this.state.signal();
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    if (this.mode !== "write" || !this.live) return -PipeErrno.BADF;
    if (!length(chunks)) return 0;
    if (!this.state.hasReaders()) return -PipeErrno.PIPE;
    const result = this.ring.write(chunks, () => this.live, this.state.nextTicket());
    if (result > 0) this.state.signal();
    return result;
  }
  tryRead(chunks: readonly Uint8Array[]): number {
    if (this.mode !== "read" || !this.live) return -PipeErrno.BADF;
    if (!length(chunks)) return 0;
    if (this.state.relay) {
      const result = this.ring.read(chunks);
      if (result > 0) this.state.signal();
      else if (result === -PipeErrno.AGAIN && this.ring.request(length(chunks))) this.state.signal();
      return result;
    }
    const source = this.state.source(false);
    if (source) {
      const result = this.state.consume(source, chunks, false);
      if (result > 0) { this.state.signal(); return result; }
    }
    if (this.state.relay) return this.tryRead(chunks);
    return this.state.eof() && this.state.queued() === 0 ? 0 : -PipeErrno.AGAIN;
  }

  read(chunks: readonly Uint8Array[]): number { return this.block(() => this.tryRead(chunks)); }
  write(chunks: readonly Uint8Array[]): number { return this.block(() => this.tryWrite(chunks)); }
  private block(operation: () => number): number {
    for (;;) {
      const observed = Atomics.load(this.notification, 0);
      const result = operation();
      if (result !== -PipeErrno.AGAIN) return result;
      Atomics.wait(this.notification, 0, observed);
    }
  }
  readiness(): Readiness {
    if (!this.live) return { readable: this.mode === "read", writable: false, hangup: true, nbytes: 0 };
    if (this.mode === "write") {
      const hangup = !this.state.hasReaders();
      return { readable: false, writable: !hangup && this.ring.writable, hangup, nbytes: 0 };
    }
    const nbytes = this.state.relay ? this.state.relayAvailable() : this.state.queued();
    const hangup = this.state.relay ? this.ring.closed : this.state.eof();
    return { readable: nbytes > 0 || hangup, writable: false, hangup, nbytes };
  }
  waitReadable(): Promise<void> { return this.wait("readable"); }
  waitWritable(): Promise<void> { return this.wait("writable"); }
  private async wait(key: "readable" | "writable"): Promise<void> {
    for (;;) {
      const observed = Atomics.load(this.notification, 0);
      const state = this.readiness();
      if (state[key] || state.hangup) {
        // An earlier EAGAIN may have posted relay demand while bytes are still staged for a
        // different reader. Yield an actual task before retrying; resolved-promise polling
        // must not starve the supervisor's bounded relay task.
        if (key === "readable" && this.mode === "read" && this.state.relay && !this.ring.available && Atomics.load(this.ring.demand, 0) > 0 && !state.hangup) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        return;
      }
      await waitChanged(this.notification, observed);
    }
  }
}

/** Supervisor control plane. Source and delivery rings are in a bounded shared directory, so
 * synchronous fd_read sees newly inherited writers without needing MessagePort dispatch.
 * Defaults reserve about 2.5 MiB per pipe, including bounded write-record metadata.
 * Atomic writes are <=4096 bytes (or capacity in tiny configured rings); no slot is reused.
 */
export class PipeController {
  private readonly state: PipeState;
  private stopped = false;
  private ownsRelay = false;
  private runningRelay = false;
  private readerCursor = 0;
  private pending?: Uint8Array;
  private pendingAt = 0;
  private pendingTicket = 0n;
  private delivery?: Ring;
  private readonly onClosed?: () => void;
  private reportedClosed = false;
  constructor(options: PipeOptions = {}, attached?: PipeEndpointHandle) {
    this.onClosed = options.onClosed;
    if (attached) this.state = new PipeState(attached);
    else {
      const capacity = options.capacity ?? 65536;
      const maxWriters = options.maxWriters ?? 16, maxReaders = options.maxReaders ?? 16;
      if (!Number.isInteger(capacity) || capacity < 8 || capacity > 1 << 24 || (capacity & (capacity - 1)) !== 0) throw new RangeError("pipe capacity must be a power of two between 8 and 16777216");
      if (!validLimit(maxWriters) || !validLimit(maxReaders)) throw new RangeError("invalid pipe process limit");
      const wake = options.registry?.wake ?? options.wake ?? (defaultWake ??= new Int32Array(new SharedArrayBuffer(4)));
      if (!(wake.buffer instanceof SharedArrayBuffer) || wake.length !== 1) throw new TypeError("pipe wake must be one shared int32");
      this.state = new PipeState({ id: crypto.randomUUID(), buffer: new SharedArrayBuffer(HEADER + (maxWriters + maxReaders) * stride(capacity)), capacity, maxWriters, maxReaders, wake, registry: options.registry?.handle() });
    }
    if (options.relay !== "manual") this.startRelay();
  }
  get closed(): boolean { return this.state.closed; }
  get mode(): "direct" | "relay" { return this.state.relay ? "relay" : "direct"; }
  get notification(): Int32Array { return this.state.wake; }
  retain(pid: number, mode: PipeMode): PipeEndpoint { return this.state.retain(pid, mode); }
  duplicate(endpoint: PipeEndpoint): PipeEndpoint {
    if (endpoint.handle().id !== this.state.id) throw new Error("endpoint belongs to another pipe");
    if (Atomics.load(new Int32Array(endpoint.handle().lifetime), 0) !== 0) throw new Error("pipe endpoint is closed");
    return this.state.retain(endpoint.pid, endpoint.mode);
  }
  revoke(pid: number): void { this.state.registry?.revoke(pid); this.state.revoke(pid); }
  /** Bounded supervisor batch. Only an actual empty read posts demand; readiness never
   * reserves bytes. One outstanding delivery keeps a source record's unread tail ahead of
   * later writes. Its canonical consumption cursor decides the guest/reclaimer CAS winner.
   */
  pumpRelay(): void {
    if (this.stopped || !this.state.relay || this.state.disposed) return;
    this.claimRelay();
    for (let step = 0; step < 64; step++) {
      if (this.delivery) {
        const ring = this.delivery;
        if (!ring.available) this.delivery = undefined;
        else {
          const alive = this.state.readerAlive(ring);
          const otherDemand = this.state.readers.some(candidate => candidate !== ring && this.state.readerAlive(candidate) && Atomics.load(candidate.demand, 0) > 0);
          if (alive && !otherDemand) break;
          if (!alive) { ring.freezeWriter(); ring.freezeReader(); }
          const head = ring.head();
          if (!head) { this.delivery = undefined; continue; }
          const copy = new Uint8Array(Math.min(head.remaining, 65536));
          const count = ring.read([copy], true);
          if (count <= 0) continue;
          const tail = this.pending?.subarray(this.pendingAt) ?? new Uint8Array();
          const recovered = new Uint8Array(count + tail.length);
          recovered.set(copy.subarray(0, count));
          recovered.set(tail, count);
          this.pending = recovered;
          this.pendingAt = 0;
          this.pendingTicket = head.ticket;
          Atomics.store(this.state.control, 4, recovered.length);
          if (!ring.available) this.delivery = undefined;
          this.state.signal();
          // A live reader can abandon an EAGAIN request. Reclaiming with the SAME consumed
          // CAS safely reroutes its unread bytes, rather than waiting for it to close or die.
          continue;
        }
      }
      let destination: Ring | undefined;
      let budget = 0;
      for (let visited = 0; visited < this.state.readers.length; visited++) {
        const index = (this.readerCursor + visited) % this.state.readers.length, ring = this.state.readers[index]!;
        const demand = Atomics.load(ring.demand, 0);
        if (!this.state.readerAlive(ring) || ring.closed || ring.available || demand <= 0 || (demand & INFLIGHT)) continue;
        if (Atomics.compareExchange(ring.demand, 0, demand, demand | INFLIGHT) !== demand) continue;
        destination = ring;
        budget = demand;
        this.readerCursor = (index + 1) % this.state.readers.length;
        break;
      }
      if (!destination) break;
      if (!this.pending) {
        const source = this.state.source(true);
        if (!source) { Atomics.store(destination.demand, 0, budget); break; }
        const chunk = new Uint8Array(Math.min(source.record.remaining, budget, 65536));
        const count = this.state.consume(source, [chunk], true);
        if (count <= 0) { Atomics.store(destination.demand, 0, budget); break; }
        this.pending = chunk.subarray(0, count);
        this.pendingAt = 0;
        this.pendingTicket = source.record.ticket;
        Atomics.store(this.state.control, 4, count);
        this.state.signal();
      }
      const piece = this.pending.subarray(this.pendingAt, this.pendingAt + Math.min(budget, 65536));
      const delivered = destination.write([piece], () => this.state.readerAlive(destination!), this.pendingTicket, false);
      // INFLIGHT prevents a guest racing publication from accidentally posting ghost demand.
      Atomics.store(destination.demand, 0, 0);
      if (delivered > 0) {
        this.pendingAt += delivered;
        Atomics.store(this.state.control, 4, this.pending.length - this.pendingAt);
        if (this.pendingAt === this.pending.length) this.pending = undefined;
        this.delivery = destination;
        this.state.signal();
      } else if (delivered === -PipeErrno.AGAIN) break;
    }
    if (!this.pending && this.state.eof() && this.state.relayAvailable() === 0) {
      let changed = false;
      for (const ring of this.state.readers) {
        if (ring.owner <= 0 || ring.closed) continue;
        ring.freezeWriter();
        changed = true;
      }
      if (changed) this.state.signal();
    }
  }

  private claimRelay(): void {
    if (this.ownsRelay) return;
    if (Atomics.compareExchange(this.state.control, 2, 0, 1) !== 0) throw new Error("pipe already has a relay supervisor");
    this.ownsRelay = true;
  }
  startRelay(): void {
    if (this.runningRelay || this.stopped) return;
    this.claimRelay();
    this.runningRelay = true;
    void this.serviceRelay();
  }
  private async serviceRelay(): Promise<void> {
    const signal = this.state.registry ? this.state.wake : this.state.changed;
    while (!this.stopped && !this.closed) {
      const observed = Atomics.load(signal, 0);
      this.pumpRelay();
      if (this.stopped || this.closed) break;
      // Our own progress causes one extra pass, then the fixed-point pump emits no changes.
      // Registry revocation has no pipe address, so registry-backed relays use the service word.
      if (Atomics.load(signal, 0) !== observed) {
        // A microtask-only loop starves kill/exit MessagePort tasks under continuous traffic.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        continue;
      }
      await waitChanged(signal, observed);
    }
    this.reportClosed();
  }
  private reportClosed(): void {
    if (!this.closed || this.reportedClosed) return;
    this.reportedClosed = true;
    this.onClosed?.();
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = undefined;
    this.delivery = undefined;
    Atomics.store(this.state.control, 4, 0);
    Atomics.store(this.state.control, 3, 1);
    for (const ring of this.state.writers.concat(this.state.readers)) {
      const pid = ring.owner;
      if (pid > 0) this.state.revoke(pid);
    }
    this.state.signal();
    this.reportClosed();
  }
}

export function attachPipeEndpoint(handle: PipeEndpointHandle): PipeEndpoint {
  const state = new PipeState(handle);
  const limit = handle.mode === "write" ? state.maxWriters : state.maxReaders;
  if (!Number.isInteger(handle.slot) || handle.slot < 0 || handle.slot >= limit) throw new RangeError("invalid pipe slot");
  return new PipeEndpoint(state, handle.pid, handle.mode, handle.slot, handle.lifetime);
}
export function attachPipeController(handle: PipeEndpointHandle, options: Pick<PipeOptions, "relay" | "onClosed"> = {}): PipeController {
  return new PipeController(options, handle);
}
