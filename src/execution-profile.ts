export const PROFILE_FLOATS = 12;
export const profileFields = {
  elapsedMs: 0,
  hostMs: 1,
  reads: 2,
  writes: 3,
  oneByteReads: 4,
  readBytes: 5,
  writeBytes: 6,
  fileAllocatedBytes: 7,
  fileCopiedBytes: 8,
  bufferedBytes: 9,
} as const;
export class ExecutionProfile {
  private readonly shared: Float64Array;
  private readonly generation: Int32Array;
  private readonly values = new Float64Array(PROFILE_FLOATS);
  private started = 0;
  active = false;
  constructor(readonly buffer: SharedArrayBuffer) {
    this.generation = new Int32Array(buffer, 0, 2);
    this.shared = new Float64Array(buffer, 8, PROFILE_FLOATS);
  }
  start() {
    this.values.fill(0);
    this.started = performance.now();
    this.active = true;
  }
  add(field: number, value = 1) {
    if (this.active) this.values[field] += value;
  }
  maximum(field: number, value: number) {
    if (this.active) this.values[field] = Math.max(this.values[field], value);
  }
  finish() {
    if (!this.active) return;
    this.values[profileFields.elapsedMs] = performance.now() - this.started;
    Atomics.add(this.generation, 0, 1);
    this.shared.set(this.values);
    Atomics.add(this.generation, 1, 1);
    Atomics.add(this.generation, 0, 1);
    this.active = false;
  }
  static createBuffer() {
    return new SharedArrayBuffer(8 + PROFILE_FLOATS * 8);
  }
  static read(buffer: SharedArrayBuffer) {
    const generation = new Int32Array(buffer, 0, 2);
    const before = Atomics.load(generation, 0);
    if (before % 2) return undefined;
    const values = Array.from(new Float64Array(buffer, 8, PROFILE_FLOATS));
    const sequence = Atomics.load(generation, 1);
    if (before !== Atomics.load(generation, 0)) return undefined;
    return {
      sequence,
      elapsedMs: values[0],
      hostMs: values[1],
      reads: values[2],
      writes: values[3],
      oneByteReads: values[4],
      readBytes: values[5],
      writeBytes: values[6],
      fileAllocatedBytes: values[7],
      fileCopiedBytes: values[8],
      bufferedBytes: values[9],
    };
  }
}
