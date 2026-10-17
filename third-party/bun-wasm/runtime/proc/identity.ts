/** Two independent, monotonic namespaces shared by synchronous guest spawn stubs.
 * This module has no supervisor/worker imports, so a guest can reserve before proc loads.
 */
export class ProcessIdentityAllocator {
  readonly buffer: SharedArrayBuffer;
  private readonly counters: Int32Array;
  constructor(buffer = new SharedArrayBuffer(8)) {
    if (buffer.byteLength !== 8) throw new RangeError("process identity buffer must contain two words");
    this.buffer = buffer;
    this.counters = new Int32Array(buffer);
  }
  pid(): number { return this.allocate(0); }
  job(): number { return this.allocate(1); }
  observePid(id: number): void { this.observe(0, id); }
  observeJob(id: number): void { this.observe(1, id); }
  private allocate(index: number): number {
    for (;;) {
      const current = Atomics.load(this.counters, index);
      if (current < 0 || current === 0x7fffffff) throw new RangeError("process identity namespace exhausted");
      if (Atomics.compareExchange(this.counters, index, current, current + 1) === current) return current + 1;
    }
  }
  private observe(index: number, id: number): void {
    if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff) throw new RangeError("invalid process identity");
    for (;;) {
      const current = Atomics.load(this.counters, index);
      if (current < 0) throw new RangeError("invalid process identity counter");
      if (current >= id || Atomics.compareExchange(this.counters, index, current, id) === current) return;
    }
  }
}
