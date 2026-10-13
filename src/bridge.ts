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
  drain(limit = 32768): Uint8Array {
    const read = Atomics.load(this.state, control.outputRead);
    const available = (Atomics.load(this.state, control.outputWrite) - read) >>> 0;
    const bytes = copyFromRing(this.output, read, Math.min(limit, available));
    Atomics.store(this.state, control.outputRead, read + bytes.length);
    if (bytes.length) Atomics.notify(this.state, control.outputRead);
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
      Atomics.wait(this.state, control.outputRead, read, 100);
      return 0;
    }
    const length = Math.min(free, bytes.length);
    copyIntoRing(this.output, write, bytes.subarray(0, length));
    Atomics.store(this.state, control.outputWrite, write + length);
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
