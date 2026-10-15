import { wrap, releaseProxy } from "comlink";
import { SharedBridge, control } from "./bridge";
import { ExecutionProfile } from "./execution-profile";
import type { WorkerControl } from "./shell.worker";
import type { StartupTimeline } from "./startup";
export type Engine = "brush" | "just-bash" | "bashkit" | "bashkit-terminal";
export type SessionOptions = {
  engine: Engine;
  cols: number;
  rows: number;
  onOutput: (bytes: Uint8Array) => void;
  onState: (state: string) => void;
  baselineState?: "isolated" | "carry";
  profile?: "phase" | "cost";
  trace?: boolean;
  startupTimeoutMs?: number;
};
type DeliverySpan = {
  startedAt: number;
  drainedAt: number;
  finishedAt: number;
  bytes: number;
  queuedBytes: number;
};
type FramePoint = { at: number; outputBytes: number };
type SessionMetrics = {
  startupMs: number;
  outputBytes: number;
  inputBytes: number;
  inputLatenciesMs: number[];
  outputFrames: number;
  wasmBytes: number;
  memoryBytes: number;
  lastExecution: ReturnType<typeof ExecutionProfile.read>;
  deliveries: DeliverySpan[];
  frames: FramePoint[];
  traceDropped: number;
  startup: StartupTimeline | undefined;
};
export class BrowserSession {
  private readonly bridge = new SharedBridge();
  private readonly worker: Worker;
  private readonly profileBuffer;
  private readonly api;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private phase = -1;
  private disposed = false;
  private failed = false;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private pendingInputTime = 0;
  private renderPending = false;
  private startupReject: ((reason: unknown) => void) | undefined;
  readonly metrics: SessionMetrics = {
    startupMs: 0,
    outputBytes: 0,
    inputBytes: 0,
    inputLatenciesMs: new Array<number>(),
    outputFrames: 0,
    wasmBytes: 0,
    memoryBytes: 0,
    lastExecution: undefined,
    deliveries: [],
    frames: [],
    traceDropped: 0,
    startup: undefined,
  };
  private constructor(private readonly options: SessionOptions) {
    this.profileBuffer = options.profile ? ExecutionProfile.createBuffer() : undefined;
    this.worker = new Worker(new URL("./shell.worker.ts", import.meta.url), { type: "module" });
    this.api = wrap<WorkerControl>(this.worker);
    this.worker.addEventListener("error", (event) =>
      this.fail(`Worker failed: ${event.message}. Restart the session to recover.`),
    );
    this.worker.addEventListener("messageerror", () =>
      this.fail("Worker messages could not be read. Restart the session."),
    );
  }
  static async create(options: SessionOptions): Promise<BrowserSession> {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "Shared memory requires HTTPS or localhost and COOP: same-origin / COEP: require-corp headers.",
      );
    }
    const session = new BrowserSession(options);
    session.resize(options.cols, options.rows);
    options.onState("starting");
    const start = performance.now();
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const failure = new Promise<never>((_resolve, reject) => {
        session.startupReject = reject;
        const limit = options.startupTimeoutMs ?? 60000;
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Shell startup exceeded ${limit / 1000} seconds. Check the WASM asset and restart.`,
              ),
            ),
          limit,
        );
      });
      try {
        const result = await Promise.race([
          session.api.initialize(
            session.bridge.buffer,
            options.engine,
            new URL("brush/brush-browser.wasm", document.baseURI).href,
            options.baselineState ?? "isolated",
            session.profileBuffer,
            options.profile === "cost",
          ),
          failure,
        ]);
        session.metrics.wasmBytes = result.wasmBytes;
        session.metrics.startup = result.startup;
      } finally {
        clearTimeout(timeout);
        session.startupReject = undefined;
      }
      session.metrics.startupMs = performance.now() - start;
      session.pump();
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
  input(bytes: Uint8Array) {
    if (this.disposed || this.failed) return;
    if (bytes.length === 1 && bytes[0] === 3) {
      this.queued = [];
      this.queuedBytes = 0;
      this.pendingInputTime = 0;
      this.renderPending = false;
      this.bridge.interrupt();
      this.phase = -1;
      this.options.onState("interrupting");
      return;
    }
    if (bytes.length + this.queuedBytes > 262144) {
      this.options.onState(
        "warning: Input exceeds the 256 KiB paste queue. Paste a smaller selection.",
      );
      return;
    }
    this.pendingInputTime = performance.now();
    this.metrics.inputBytes += bytes.length;
    this.queued.push(bytes.slice());
    this.queuedBytes += bytes.length;
    this.flushInput();
  }
  resize(cols: number, rows: number) {
    Atomics.store(this.bridge.state, control.cols, Math.max(2, cols));
    Atomics.store(this.bridge.state, control.rows, Math.max(2, rows));
    Atomics.add(this.bridge.state, control.resize, 1);
    this.bridge.signal();
  }
  crash() {
    this.worker.terminate();
    this.fail("Worker stopped unexpectedly. Restart the session to recover.");
  }
  dispose() {
    if (this.disposed) return;
    this.startupReject?.(new Error("Shell startup was cancelled."));
    this.disposed = true;
    this.bridge.close();
    clearTimeout(this.timer);
    this.worker.terminate();
    this.api[releaseProxy]();
    this.queued = [];
    this.queuedBytes = 0;
  }
  markRendered() {
    if (this.options.trace && !this.disposed) {
      if (this.metrics.frames.length < 512)
        this.metrics.frames.push({
          at: performance.timeOrigin + performance.now(),
          outputBytes: this.metrics.outputBytes,
        });
      else this.metrics.traceDropped++;
    }
    if (!this.renderPending || !this.pendingInputTime || this.disposed) return;
    const samples = this.metrics.inputLatenciesMs;
    if (samples.length === 256) samples.shift();
    samples.push(performance.now() - this.pendingInputTime);
    this.pendingInputTime = 0;
    this.renderPending = false;
  }
  private fail(message: string) {
    this.startupReject?.(new Error(message));
    this.failed = true;
    this.bridge.close();
    clearTimeout(this.timer);
    this.options.onState(`failed: ${message}`);
    this.dispose();
  }
  private flushInput() {
    if (this.bridge.cancelled()) return;
    while (this.queued.length) {
      const bytes = this.queued[0];
      const chunk = bytes.subarray(0, 65536);
      if (!this.bridge.send(chunk)) return;
      this.queuedBytes -= chunk.length;
      if (chunk.length === bytes.length) {
        this.queued.shift();
        continue;
      }
      this.queued[0] = bytes.subarray(chunk.length);
    }
  }
  private pump() {
    if (this.disposed || this.failed) return;
    this.flushInput();
    const startedAt = this.options.trace ? performance.timeOrigin + performance.now() : 0;
    const queuedBytes = this.options.trace
      ? (Atomics.load(this.bridge.state, control.outputWrite) -
          Atomics.load(this.bridge.state, control.outputRead)) >>>
        0
      : 0;
    const output = this.bridge.drain();
    const drainedAt = this.options.trace ? performance.timeOrigin + performance.now() : 0;
    if (output.length) this.deliver(output);
    if (this.options.trace && output.length) {
      if (this.metrics.deliveries.length < 512)
        this.metrics.deliveries.push({
          startedAt,
          drainedAt,
          finishedAt: performance.timeOrigin + performance.now(),
          bytes: output.length,
          queuedBytes,
        });
      else this.metrics.traceDropped++;
    }
    if (this.disposed || this.failed) return;
    if (this.profileBuffer) this.metrics.lastExecution = ExecutionProfile.read(this.profileBuffer);
    this.metrics.memoryBytes = Atomics.load(this.bridge.state, control.memory);
    const phase = Atomics.load(this.bridge.state, control.phase);
    if (phase !== this.phase && !this.bridge.cancelled()) {
      this.phase = phase;
      this.options.onState(
        ["starting", "ready", "running", "exited"][phase] ?? "Worker failed. Restart the session.",
      );
    }
    if (this.disposed || this.failed) return;
    if (
      phase === 3 &&
      Atomics.load(this.bridge.state, control.outputWrite) ===
        Atomics.load(this.bridge.state, control.outputRead)
    ) {
      this.dispose();
      return;
    }
    this.timer = setTimeout(() => this.pump(), 8);
  }
  private deliver(bytes: Uint8Array) {
    this.metrics.outputBytes += bytes.length;
    this.metrics.outputFrames++;
    if (this.pendingInputTime) this.renderPending = true;
    this.options.onOutput(bytes);
  }
}
