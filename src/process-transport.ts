export const AGAIN = -2;
const PIPE_BYTES = 65536;
const RESULT_BYTES = 8 * 1024 * 1024;
export type ProcessTransport = {
  state: SharedArrayBuffer;
  stdin: SharedArrayBuffer;
  output: SharedArrayBuffer;
};
export function createTransport(): ProcessTransport {
  return {
    state: new SharedArrayBuffer(16 + RESULT_BYTES),
    stdin: new SharedArrayBuffer(16 + PIPE_BYTES),
    output: new SharedArrayBuffer(16 + PIPE_BYTES),
  };
}
export class ProcessPipe {
  private readonly state;
  private readonly bytes;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.state = new Int32Array(buffer, 0, 4);
    this.bytes = new Uint8Array(buffer, 16);
  }
  read(capacity: number): Uint8Array | number {
    if (!capacity) return 0;
    const read = Atomics.load(this.state, 0) >>> 0;
    const closed = Atomics.load(this.state, 2);
    const written = Atomics.load(this.state, 1) >>> 0;
    const count = Math.min((written - read) >>> 0, capacity);
    if (!count) return closed ? 0 : AGAIN;
    const start = read % PIPE_BYTES;
    const first = Math.min(count, PIPE_BYTES - start);
    const bytes = new Uint8Array(count);
    bytes.set(this.bytes.subarray(start, start + first));
    bytes.set(this.bytes.subarray(0, count - first), first);
    Atomics.store(this.state, 0, (read + count) | 0);
    this.wake();
    return bytes;
  }
  write(bytes: Uint8Array): number {
    if (Atomics.load(this.state, 2)) return -1;
    const read = Atomics.load(this.state, 0) >>> 0;
    const written = Atomics.load(this.state, 1) >>> 0;
    const count = Math.min(PIPE_BYTES - ((written - read) >>> 0), bytes.length);
    if (!count) return bytes.length ? AGAIN : 0;
    const start = written % PIPE_BYTES;
    const first = Math.min(count, PIPE_BYTES - start);
    this.bytes.set(bytes.subarray(0, first), start);
    this.bytes.set(bytes.subarray(first, count), 0);
    Atomics.store(this.state, 1, (written + count) | 0);
    this.wake();
    return count;
  }
  writeAll(bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.length) {
      const wake = Atomics.load(this.state, 3);
      const count = this.write(bytes.subarray(offset));
      if (count === AGAIN) Atomics.wait(this.state, 3, wake, 50);
      else if (count < 0) return;
      else offset += count;
    }
  }
  readBlocking(capacity: number): Uint8Array | number {
    for (;;) {
      const wake = Atomics.load(this.state, 3);
      const bytes = this.read(capacity);
      if (bytes !== AGAIN) return bytes;
      Atomics.wait(this.state, 3, wake, 50);
    }
  }
  get drained() {
    return (
      Boolean(Atomics.load(this.state, 2)) &&
      Atomics.load(this.state, 0) === Atomics.load(this.state, 1)
    );
  }
  close() {
    Atomics.store(this.state, 2, 1);
    this.wake();
  }
  private wake() {
    Atomics.add(this.state, 3, 1);
    Atomics.notify(this.state, 3);
  }
}
export class ProcessOutput {
  private readonly pipe;
  private readonly header = new Uint8Array(8);
  private headerBytes = 0;
  private fd: 1 | 2 = 1;
  private remaining = 0;
  constructor(buffer: SharedArrayBuffer) {
    this.pipe = new ProcessPipe(buffer);
  }
  writeAll(fd: 1 | 2, bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const chunk = bytes.subarray(offset, offset + 16384);
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint32(0, fd, true);
      view.setUint32(4, chunk.length, true);
      this.pipe.writeAll(header);
      this.pipe.writeAll(chunk);
    }
  }
  read(capacity: number): { fd: 1 | 2; bytes: Uint8Array } | number {
    if (!this.remaining) {
      const result = this.readHeader();
      if (result !== 1) return result;
    }
    const bytes = this.pipe.read(Math.min(capacity, this.remaining));
    if (typeof bytes === "number") return bytes;
    this.remaining -= bytes.length;
    return { fd: this.fd, bytes };
  }
  get drained() {
    return this.pipe.drained && !this.remaining && !this.headerBytes;
  }
  private readHeader(): number {
    while (this.headerBytes < 8) {
      const bytes = this.pipe.read(8 - this.headerBytes);
      if (typeof bytes === "number") return bytes;
      this.header.set(bytes, this.headerBytes);
      this.headerBytes += bytes.length;
    }
    const view = new DataView(this.header.buffer);
    const fd = view.getUint32(0, true);
    const count = view.getUint32(4, true);
    if ((fd !== 1 && fd !== 2) || !count || count > 16384)
      throw new Error("Invalid child output frame");
    this.fd = fd;
    this.remaining = count;
    this.headerBytes = 0;
    return 1;
  }
}
export function finishProcess(transport: ProcessTransport, status: number, changes = "") {
  const state = new Int32Array(transport.state, 0, 4);
  if (Atomics.load(state, 0)) return;
  const bytes = new TextEncoder().encode(changes);
  if (bytes.length > RESULT_BYTES) {
    new ProcessOutput(transport.output).writeAll(
      2,
      new TextEncoder().encode("Child filesystem changes exceed 8 MiB\n"),
    );
    status = 1;
  } else {
    new Uint8Array(transport.state, 16).set(bytes);
    Atomics.store(state, 2, bytes.length);
  }
  Atomics.store(state, 1, status);
  for (const pipe of [transport.stdin, transport.output]) new ProcessPipe(pipe).close();
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}
export function cancelProcess(transport: ProcessTransport) {
  Atomics.store(new Int32Array(transport.state, 0, 4), 3, 1);
  for (const pipe of [transport.stdin, transport.output]) new ProcessPipe(pipe).close();
}
