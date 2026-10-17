import { ExecutionProfile, profileFields } from "./execution-profile";
export const control = {
  inputWrite: 0,
  inputRead: 1,
  outputWrite: 2,
  outputRead: 3,
  wake: 4,
  cancel: 5,
  closed: 6,
  cols: 7,
  rows: 8,
  resize: 9,
  raw: 10,
  phase: 11,
  status: 12,
  memory: 13,
  inputLock: 14,
  outputLock: 15,
} as const;
export const INPUT_CAPACITY = 65536;
export const OUTPUT_CAPACITY = 262144;
const HEADER_BYTES = 64;
export class SharedBridge {
  readonly state: Int32Array;
  readonly input: Uint8Array;
  readonly output: Uint8Array;
  constructor(
    readonly buffer = new SharedArrayBuffer(HEADER_BYTES + INPUT_CAPACITY + OUTPUT_CAPACITY),
    private readonly profile?: ExecutionProfile,
  ) {
    this.state = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.input = new Uint8Array(buffer, HEADER_BYTES, INPUT_CAPACITY);
    this.output = new Uint8Array(buffer, HEADER_BYTES + INPUT_CAPACITY, OUTPUT_CAPACITY);
  }
  signal() {
    Atomics.add(this.state, control.wake, 1);
    Atomics.notify(this.state, control.wake);
    Atomics.notify(this.state, control.outputRead);
  }
  interrupt() {
    Atomics.store(this.state, control.cancel, 1);
    this.signal();
  }
  close() {
    Atomics.store(this.state, control.closed, 1);
    this.signal();
  }
  cancelled() {
    return Atomics.load(this.state, control.cancel) !== 0;
  }
  closed() {
    return Atomics.load(this.state, control.closed) !== 0;
  }
  availableInput() {
    return (
      (Atomics.load(this.state, control.inputWrite) -
        Atomics.load(this.state, control.inputRead)) >>>
      0
    );
  }
  send(bytes: Uint8Array): boolean {
    const write = Atomics.load(this.state, control.inputWrite);
    if (bytes.length > this.input.length - this.availableInput()) return false;
    copyIntoRing(this.input, write, bytes);
    Atomics.store(this.state, control.inputWrite, write + bytes.length);
    this.signal();
    return true;
  }
  receive(limit: number): Uint8Array {
    const read = Atomics.load(this.state, control.inputRead);
    const bytes = copyFromRing(this.input, read, Math.min(limit, this.availableInput()));
    Atomics.store(this.state, control.inputRead, read + bytes.length);
    return bytes;
  }
  // Immediate, bounded I/O for runtime_proc. Multiple guest processes can inherit this terminal.
  // A contended endpoint returns EAGAIN rather than waiting on the page or another guest.
  tryRead(chunks: readonly Uint8Array[]): number {
    if (!chunks.some((chunk) => chunk.length)) return 0;
    if (Atomics.compareExchange(this.state, control.inputLock, 0, 1) !== 0) return -6;
    try {
      let read = Atomics.load(this.state, control.inputRead);
      let available = this.availableInput();
      if (!available) return this.closed() ? 0 : -6;
      let total = 0;
      for (const chunk of chunks) {
        const count = Math.min(chunk.length, available);
        if (count) chunk.set(copyFromRing(this.input, read, count));
        read += count;
        available -= count;
        total += count;
        if (!available) break;
      }
      Atomics.store(this.state, control.inputRead, read);
      this.signal();
      return total;
    } finally {
      Atomics.store(this.state, control.inputLock, 0);
    }
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    if (!chunks.some((chunk) => chunk.length)) return 0;
    if (this.closed()) return -29;
    if (Atomics.compareExchange(this.state, control.outputLock, 0, 1) !== 0) return -6;
    try {
      let write = Atomics.load(this.state, control.outputWrite);
      let free =
        this.output.length - ((write - Atomics.load(this.state, control.outputRead)) >>> 0);
      if (!free) return -6;
      let total = 0;
      for (const chunk of chunks) {
        const count = Math.min(chunk.length, free);
        copyIntoRing(this.output, write, chunk.subarray(0, count));
        write += count;
        free -= count;
        total += count;
        if (!free) break;
      }
      Atomics.store(this.state, control.outputWrite, write);
      this.signal();
      return total;
    } finally {
      Atomics.store(this.state, control.outputLock, 0);
    }
  }
  drain(limit = 32768): Uint8Array {
    const read = Atomics.load(this.state, control.outputRead);
    const available = (Atomics.load(this.state, control.outputWrite) - read) >>> 0;
    const bytes = copyFromRing(this.output, read, Math.min(limit, available));
    Atomics.store(this.state, control.outputRead, read + bytes.length);
    if (bytes.length) this.signal();
    return bytes;
  }
  // Only the shell worker calls this. The main thread drains instead of waiting.
  write(bytes: Uint8Array): number {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.closed()) return offset;
      const count = this.writeChunk(bytes.subarray(offset));
      if (count < 0) return offset;
      offset += count;
    }
    return offset;
  }
  private writeChunk(bytes: Uint8Array): number {
    const read = Atomics.load(this.state, control.outputRead);
    const write = Atomics.load(this.state, control.outputWrite);
    const free = this.output.length - ((write - read) >>> 0);
    if (!free && this.cancelled()) return -1;
    if (!free) {
      const started = this.profile?.collecting ? performance.now() : undefined;
      Atomics.wait(this.state, control.outputRead, read, 100);
      if (started !== undefined)
        this.profile?.add(profileFields.backpressureMs, performance.now() - started);
      return 0;
    }
    const length = Math.min(free, bytes.length);
    const started = this.profile?.collecting ? performance.now() : undefined;
    copyIntoRing(this.output, write, bytes.subarray(0, length));
    Atomics.store(this.state, control.outputWrite, write + length);
    if (started !== undefined) this.profile?.output(length, started);
    this.profile?.maximum(profileFields.bufferedBytes, (write + length - read) >>> 0);
    return length;
  }
}
function copyIntoRing(ring: Uint8Array, index: number, bytes: Uint8Array) {
  const start = (index >>> 0) % ring.length;
  const first = Math.min(bytes.length, ring.length - start);
  ring.set(bytes.subarray(0, first), start);
  ring.set(bytes.subarray(first), 0);
}
function copyFromRing(ring: Uint8Array, index: number, length: number): Uint8Array {
  const result = new Uint8Array(length);
  const start = (index >>> 0) % ring.length;
  const first = Math.min(length, ring.length - start);
  result.set(ring.subarray(start, start + first));
  result.set(ring.subarray(0, length - first), first);
  return result;
}
