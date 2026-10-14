export const PROFILE_FLOATS = 25;
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
  startedAt: 10,
  finishedAt: 11,
  wasiCalls: 12,
  browserCalls: 13,
  browserMs: 14,
  normalizeMs: 15,
  ringCopyMs: 16,
  ringCopyBytes: 17,
  backpressureMs: 18,
  baselineExecMs: 19,
  hostCopyMs: 20,
  hostCopyBytes: 21,
  firstOutputAt: 22,
  lastOutputAt: 23,
  initialQueuedBytes: 24,
} as const;
export class ExecutionProfile {
  private readonly shared: Float64Array;
  private readonly generation: Int32Array;
  private readonly values = new Float64Array(PROFILE_FLOATS);
  private started = 0;
  active = false;
  constructor(
    readonly buffer: SharedArrayBuffer,
    readonly costs = true,
  ) {
    this.generation = new Int32Array(buffer, 0, 2);
    this.shared = new Float64Array(buffer, 8, PROFILE_FLOATS);
  }
  get collecting() {
    return this.active && this.costs;
  }
  start(queuedBytes = 0) {
    this.values.fill(0);
    this.started = performance.now();
    this.values[profileFields.startedAt] = performance.timeOrigin + this.started;
    this.values[profileFields.initialQueuedBytes] = queuedBytes;
    this.active = true;
  }
  add(field: number, value = 1) {
    if (this.collecting) this.values[field] += value;
  }
  maximum(field: number, value: number) {
    if (this.collecting) this.values[field] = Math.max(this.values[field], value);
  }
  output(bytes: number, started: number) {
    if (!this.collecting) return;
    const now = performance.now();
    this.add(profileFields.ringCopyMs, now - started);
    this.add(profileFields.ringCopyBytes, bytes);
    if (!this.values[profileFields.firstOutputAt])
      this.values[profileFields.firstOutputAt] = performance.timeOrigin + now;
    this.values[profileFields.lastOutputAt] = performance.timeOrigin + now;
  }
  browser<Args extends number[], Result>(operation: (...args: Args) => Result) {
    return (...args: Args): Result => {
      if (!this.collecting) return operation(...args);
      const started = performance.now();
      this.add(profileFields.browserCalls);
      try {
        return operation(...args);
      } finally {
        this.add(profileFields.browserMs, performance.now() - started);
      }
    };
  }
  finish() {
    if (!this.active) return;
    this.values[profileFields.elapsedMs] = performance.now() - this.started;
    this.values[profileFields.finishedAt] = performance.timeOrigin + performance.now();
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
      startedAt: values[10],
      finishedAt: values[11],
      wasiCalls: values[12],
      browserCalls: values[13],
      browserMs: values[14],
      normalizeMs: values[15],
      ringCopyMs: values[16],
      ringCopyBytes: values[17],
      backpressureMs: values[18],
      baselineExecMs: values[19],
      hostCopyMs: values[20],
      hostCopyBytes: values[21],
      firstOutputAt: values[22],
      lastOutputAt: values[23],
      initialQueuedBytes: values[24],
    };
  }
}
