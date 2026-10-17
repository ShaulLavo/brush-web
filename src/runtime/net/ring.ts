// Adapted from bun-wasm web/src/net/ring.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
// A single-producer, single-consumer byte ring in a SharedArrayBuffer.
// Producer: the helper (async; it waits for space without blocking its thread).
// Consumer: the bun worker (sync; it drains on every host call and sleeps in `poll` with Atomics.wait).
//
// Layout: a 32-byte header of Int32 cells, then CAPACITY bytes of data.
//   GEN    bumped after every record; the consumer waits on it in `poll`
//   WRITE  bytes written so far (wrapping u32)
//   READ   bytes consumed so far (wrapping u32)
//   SPACE  bumped by the consumer after draining; the producer waits on it when the ring is full
// Record: [handle i32][kind i32][len i32][payload, padded to 4 bytes]. Records may wrap around the end.

import { MAX_RECORD } from "./protocol";

const GEN = 0;
const WRITE = 1;
const READ = 2;
const SPACE = 3;
const HEADER_BYTES = 32;
const RECORD_HEADER = 12;
/** Must be a power of two and comfortably larger than MAX_RECORD. */
export const CAPACITY = 1 << 20;

export function createRing(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
}

type WaitAsync = (
  cells: Int32Array,
  index: number,
  value: number,
  timeoutMs: number,
) => { async: false; value: string } | { async: true; value: Promise<string> };

const align4 = (n: number) => (n + 3) & ~3;

class RingBase {
  protected cells: Int32Array;
  protected data: Uint8Array;

  constructor(sab: SharedArrayBuffer) {
    this.cells = new Int32Array(sab, 0, HEADER_BYTES / 4);
    this.data = new Uint8Array(sab, HEADER_BYTES, CAPACITY);
  }

  protected used(): number {
    return (Atomics.load(this.cells, WRITE) - Atomics.load(this.cells, READ)) >>> 0;
  }
}

export class RingWriter extends RingBase {
  private header = new Uint8Array(RECORD_HEADER);
  private headerView = new DataView(this.header.buffer);

  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  /**
   * Appends one record, waiting while the ring is full. Records land in call order (writes are
   * queued), so callers may fire and forget.
   */
  write(handle: number, kind: number, payload: Uint8Array = new Uint8Array()): Promise<void> {
    if (payload.length > MAX_RECORD)
      return Promise.reject(new RangeError(`ring record too large: ${payload.length}`));
    this.queue = this.queue.then(() => this.append(handle, kind, payload));
    return this.queue;
  }

  /** The consumer stopped: release blocked producers and discard queued records. */
  dispose(): void {
    this.disposed = true;
    Atomics.add(this.cells, SPACE, 1);
    Atomics.notify(this.cells, SPACE);
  }

  private async append(handle: number, kind: number, payload: Uint8Array): Promise<void> {
    const size = align4(RECORD_HEADER + payload.length);
    while (!this.disposed && CAPACITY - this.used() < size) await this.waitForSpace();
    if (this.disposed) return;
    this.headerView.setInt32(0, handle, true);
    this.headerView.setInt32(4, kind, true);
    this.headerView.setInt32(8, payload.length, true);
    const at = Atomics.load(this.cells, WRITE) >>> 0;
    this.copyIn(at, this.header);
    this.copyIn(at + RECORD_HEADER, payload);
    // The Atomics store publishes the plain byte writes above to the consumer.
    Atomics.store(this.cells, WRITE, (at + size) | 0);
    Atomics.add(this.cells, GEN, 1);
    Atomics.notify(this.cells, GEN);
  }

  private copyIn(at: number, bytes: Uint8Array): void {
    const start = at & (CAPACITY - 1);
    const first = Math.min(bytes.length, CAPACITY - start);
    this.data.set(bytes.subarray(0, first), start);
    if (first < bytes.length) this.data.set(bytes.subarray(first), 0);
  }

  private async waitForSpace(): Promise<void> {
    const seen = Atomics.load(this.cells, SPACE);
    // Atomics.waitAsync is missing in some engines; a short timer works everywhere.
    const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;
    if (waitAsync) {
      const result = waitAsync(this.cells, SPACE, seen, 100);
      if (result.async) await result.value;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export interface RingRecord {
  handle: number;
  kind: number;
  payload: Uint8Array;
}

export class RingReader extends RingBase {
  private view: DataView;

  constructor(sab: SharedArrayBuffer) {
    super(sab);
    this.view = new DataView(sab, HEADER_BYTES, CAPACITY);
  }

  /** The generation counter: changes whenever a record is written. */
  generation(): number {
    return Atomics.load(this.cells, GEN);
  }

  /** Sleeps until the generation differs from `seen` or `timeoutMs` passes (negative: forever). */
  wait(seen: number, timeoutMs: number): "ok" | "not-equal" | "timed-out" {
    return Atomics.wait(this.cells, GEN, seen, timeoutMs < 0 ? Infinity : timeoutMs);
  }

  /** Resolves once the generation differs from `seen`; null where Atomics.waitAsync is missing. */
  waitAsync(seen: number): Promise<unknown> | null {
    const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;
    if (!waitAsync) return null;
    const result = waitAsync(this.cells, GEN, seen, Infinity);
    return result.async ? result.value : Promise.resolve(result.value);
  }

  /** Takes every complete record out of the ring. Payloads are copies the caller owns. */
  drain(): RingRecord[] {
    const records: RingRecord[] = [];
    let at = Atomics.load(this.cells, READ) >>> 0;
    const end = Atomics.load(this.cells, WRITE) >>> 0;
    while (at !== end) {
      const handle = this.int32(at);
      const kind = this.int32(at + 4);
      const len = this.int32(at + 8);
      records.push({ handle, kind, payload: this.copyOut(at + RECORD_HEADER, len) });
      at = (at + align4(RECORD_HEADER + len)) >>> 0;
    }
    if (records.length === 0) return records;
    Atomics.store(this.cells, READ, at | 0);
    Atomics.add(this.cells, SPACE, 1);
    Atomics.notify(this.cells, SPACE);
    return records;
  }

  private int32(at: number): number {
    const pos = at & (CAPACITY - 1);
    // Record headers are 4-byte aligned, so an i32 never straddles the wrap point.
    return this.view.getInt32(pos, true);
  }

  private copyOut(at: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    const start = at & (CAPACITY - 1);
    const first = Math.min(len, CAPACITY - start);
    out.set(this.data.subarray(start, start + first));
    if (first < len) out.set(this.data.subarray(0, len - first), first);
    return out;
  }
}
