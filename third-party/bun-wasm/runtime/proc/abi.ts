import { MAX_DESCRIPTOR, type Descriptor, type DescriptorTable, type Readiness, type Stream } from "../core/descriptors";
import type { FileSystem } from "../core/filesystem";
import { withFileOffset } from "../core/open-file";
import { PipeController } from "./pipes";
import { readOutcome } from "./outcome";
import { checkedSignalNumber, requestSignal, setSignalDisposition, SIGNAL_PENDING, takeSignal, type SignalTransport } from "./signals";
import { ProcessErrno, ProcessError, Signal, type ProcessExit, type SpawnRequest } from "./types";

/** Synchronous control plane. Implementations reserve/retain before returning from spawn;
 * module loading and guest startup happen elsewhere, never on this import's stack. */
export interface ProcessService {
  spawn(parentPid: number, request: SpawnRequest): number;
  wait(parentPid: number, pid: number): ProcessExit | null;
  kill(pid: number, signal: number): void;
  killJob(job: number, signal: number): void;
  jobOf(pid: number): number;
  defaultSignal(pid: number, signal: number): void;
  /** Privileged local services check guest authority; broker clients are already caller-bound. */
  canSignal?(callerPid: number, targetPid: number): boolean;
  canSignalJob?(callerPid: number, job: number): boolean;
  filesystemReady?(pid: number, request: number): boolean;
  registerRevocation?(pid: number, hook: () => void): () => void;
}

interface NonblockingFileSystem extends FileSystem {
  tryRead?(handle: number, chunks: readonly Uint8Array[], offset: number): number;
  tryWrite?(handle: number, chunks: readonly Uint8Array[], offset: number): number;
  tryAppend?(handle: number, chunks: readonly Uint8Array[]): { written: number; offset: number } | number;
  ioReadiness?(handle: number, writing: boolean): Readiness;
  readiness?(request: number): { ready: boolean } | undefined;
}
interface NonblockingStream extends Stream {
  readonly notification?: Int32Array;
  tryRead?(chunks: readonly Uint8Array[]): number;
  tryWrite?(chunks: readonly Uint8Array[]): number;
  registerWake?(wake: Int32Array): (() => void) | void;
}
export interface ProcessABIOptions {
  memory: WebAssembly.Memory | (() => WebAssembly.Memory);
  descriptors: DescriptorTable;
  fs: FileSystem;
  pid: number;
  service: ProcessService;
  signals: SignalTransport;
  pipeCapacity?: number;
  /** Workers inject broker-owned endpoints; the default is an in-process controller. */
  createPipe?(): readonly [Stream, Stream];
  /** One shared readiness sequence. Publishers increment and notify after publishing state. */
  wake?: Int32Array;
  /** Synchronous wait hook, primarily for embedders and deterministic tests. Only poll calls it. */
  wait?(milliseconds: number, word: Int32Array, expected: number): void;
  now?(): number;
}

/** Explicit default-action unwind; an unrelated WASM trap must never be treated as a signal. */
export class ProcessSignalExit extends Error {
  readonly status: number;
  constructor(readonly signal: number) {
    super(`default action for signal ${signal}`);
    this.name = "ProcessSignalExit";
    this.status = 128 + signal;
  }
}

const READ = 1n << 1n, WRITE = 1n << 6n, POLL = 1n << 27n;
const FAULT = 21, ISDIR = 31, NOSYS = 52, NOTCAPABLE = 76;
const decode = new TextDecoder("utf-8", { fatal: true });
const clock = performance.now.bind(performance);
type Subscription = { kind: number; id: number; userdata: bigint };

/** Guest adapter for the runtime_proc WASM namespace. No operation except poll waits.
 * FileSystem must provide immediate I/O; worker-backed services supply nonblocking file I/O.
 * Streams with potentially blocking read/write must expose tryRead/tryWrite. */
export class ProcessABI {
  readonly imports: Record<string, (...args: number[]) => number>;
  private readonly now: () => number;
  constructor(private readonly options: ProcessABIOptions) {
    if (options.wake && (!(options.wake.buffer instanceof SharedArrayBuffer) || options.wake.length !== 1)) {
      throw new TypeError("poll wake must be one shared int32");
    }
    this.now = options.now ?? clock;
    this.imports = {
      spawn: (ptr, length) => this.result(() => options.service.spawn(options.pid, this.spawnRequest(ptr!, length!))),
      job_of: pid => this.result(() => options.service.jobOf(pid!)),
      pipe: ptr => this.result(() => this.pipe(ptr!)),
      dup: fd => options.descriptors.dup(fd! >>> 0),
      read: (fd, ptr, length) => this.result(() => this.io(false, fd!, ptr!, length!)),
      write: (fd, ptr, length) => this.result(() => this.io(true, fd!, ptr!, length!)),
      wait: (pid, ptr) => this.result(() => this.wait(pid!, ptr!)),
      kill: (pid, signal) => this.result(() => {
        if (options.service.canSignal?.(options.pid, pid!) === false) return -63;
        options.service.kill(pid!, signal!); return 0;
      }),
      kill_job: (job, signal) => this.result(() => {
        if (options.service.canSignalJob?.(options.pid, job!) === false) return -63;
        options.service.killJob(job!, signal!); return 0;
      }),
      poll: (ptr, count, timeout, out) => this.result(() => this.poll(ptr!, count!, timeout!, out!)),
      interrupted: () => this.interrupted(),
      signal: (signal, mode) => this.signal(signal!, mode!),
      default_signal: signal => this.defaultSignal(signal!),
    };
  }
  private result(operation: () => number): number {
    try { return operation(); }
    catch (error) {
      if (error instanceof ProcessError) return -error.errno;
      throw error;
    }
  }
  private memory(): WebAssembly.Memory {
    return typeof this.options.memory === "function" ? this.options.memory() : this.options.memory;
  }
  private span(ptr: number, length: number): Uint8Array {
    ptr >>>= 0; length >>>= 0;
    const memory = this.memory();
    if (length > memory.buffer.byteLength - ptr) throw new ProcessError(FAULT, "guest memory out of bounds");
    return new Uint8Array(memory.buffer, ptr, length);
  }
  private view(ptr: number, length: number): DataView {
    const bytes = this.span(ptr, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private spawnRequest(ptr: number, length: number): SpawnRequest {
    // Guest memory may be resizable; TextDecoder's WebIDL input requires a fixed buffer.
    const bytes = this.span(ptr, length).slice();
    let request: unknown;
    try { request = JSON.parse(decode.decode(bytes)); }
    catch { throw new ProcessError(ProcessErrno.INVAL, "invalid spawn JSON"); }
    const object = request as Partial<SpawnRequest> | null;
    const fd = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DESCRIPTOR;
    if (!object || typeof object !== "object" || typeof object.executable !== "string" || !object.executable ||
      !Array.isArray(object.argv) || !object.argv.every(value => typeof value === "string") ||
      !object.env || typeof object.env !== "object" || Array.isArray(object.env) || !Object.values(object.env).every(value => typeof value === "string") ||
      typeof object.cwd !== "string" || !object.cwd || !Number.isInteger(object.job) || object.job! < -1 ||
      !Array.isArray(object.fds) || !object.fds.every(binding => binding && typeof binding === "object" && fd(binding.child) && fd(binding.parent))) {
      throw new ProcessError(ProcessErrno.INVAL, "invalid spawn description");
    }
    return object as SpawnRequest;
  }
  private pipe(ptr: number): number {
    // Validate before retaining endpoints or mutating the descriptor namespace.
    this.span(ptr, 8);
    const endpoints = this.options.createPipe?.() ?? this.localPipe();
    let read: number | undefined, write: number | undefined;
    try {
      read = this.options.descriptors.open(endpoints[0], READ | POLL, 0n);
      write = this.options.descriptors.open(endpoints[1], WRITE | POLL, 0n);
      const output = this.view(ptr, 8);
      output.setUint32(0, read, true); output.setUint32(4, write, true);
      return 0;
    } catch (error) {
      if (read !== undefined) this.options.descriptors.close(read); else endpoints[0].close?.();
      if (write !== undefined) this.options.descriptors.close(write); else endpoints[1].close?.();
      throw error;
    }
  }
  private localPipe(): readonly [Stream, Stream] {
    const controller = new PipeController({ capacity: this.options.pipeCapacity, wake: this.options.wake });
    const read = controller.retain(this.options.pid, "read");
    let write: Stream;
    try { write = controller.retain(this.options.pid, "write"); }
    catch (error) { read.close?.(); throw error; }
    const unregister = this.options.service.registerRevocation?.(this.options.pid, () => controller.revoke(this.options.pid));
    if (unregister) {
      let remaining = 2;
      for (const endpoint of [read, write]) {
        const close = endpoint.close?.bind(endpoint);
        let closed = false;
        endpoint.close = () => {
          if (closed) return;
          closed = true;
          try { close?.(); } finally { if (--remaining === 0) unregister(); }
        };
      }
    }
    return [read, write];
  }
  private descriptor(fd: number, rights: bigint): Descriptor {
    const entry = this.options.descriptors.get(fd >>> 0);
    if (!entry) throw new ProcessError(ProcessErrno.BADF, `missing descriptor ${fd}`);
    if ((entry.rightsBase & rights) !== rights) throw new ProcessError(NOTCAPABLE, "descriptor rights denied");
    return entry;
  }
  private io(write: boolean, fd: number, ptr: number, length: number): number {
    const entry = this.descriptor(fd, write ? WRITE : READ), resource = entry.resource;
    if (resource.kind === "directory") return -ISDIR;
    const bytes = this.span(ptr, length);
    if (bytes.length === 0) return 0;
    if (resource.kind === "file") {
      const fs: NonblockingFileSystem = this.options.fs;
      return withFileOffset(resource, () => {
        if (write && resource.append) {
          const result = fs.tryAppend ? fs.tryAppend(resource.handle, [bytes]) : fs.append(resource.handle, [bytes]);
          if (typeof result === "number") return result;
          resource.offset = result.offset;
          return result.written;
        }
        const position = resource.offset;
        const count = write
          ? fs.tryWrite ? fs.tryWrite(resource.handle, [bytes], position) : fs.write(resource.handle, [bytes], position)
          : fs.tryRead ? fs.tryRead(resource.handle, [bytes], position) : fs.read(resource.handle, [bytes], position);
        if (count >= 0) resource.offset = position + count;
        return count;
      }, true);
    }
    const stream: NonblockingStream = resource;
    if (write && stream.tryWrite) return stream.tryWrite([bytes]);
    if (!write && stream.tryRead) return stream.tryRead([bytes]);
    // readiness describes availability, not whether read/write may enter a blocking callback.
    // A terminal backed only by preview1 stdin must opt into the immediate I/O contract.
    return stream.kind === "terminal" ? -ProcessErrno.AGAIN : -NOSYS;
  }
  private wait(pid: number, ptr: number): number {
    this.span(ptr, 8);
    const result = this.options.service.wait(this.options.pid, pid);
    if (!result) return -ProcessErrno.AGAIN;
    const output = this.view(ptr, 8);
    output.setUint32(0, result.kind === "exited" ? 0 : 1, true);
    output.setInt32(4, result.code, true);
    return 0;
  }
  private pending(): boolean {
    for (let signal = 1; signal <= 64; signal++) {
      if (Atomics.load(this.options.signals.signalState, signal) & SIGNAL_PENDING) return true;
    }
    return false;
  }
  private interrupted(): number {
    // Fatal outcomes are not handled deliveries. Stop before user code can run another handler.
    const fatal = readOutcome(this.options.signals.outcome);
    if (fatal?.kind === "signaled") throw new ProcessSignalExit(fatal.code);
    // Clear before dequeue: a racing publisher either leaves a wake or a pending signal.
    Atomics.exchange(this.options.signals.interrupt, 0, 0);
    const signal = takeSignal(this.options.signals.signalState);
    const raced = readOutcome(this.options.signals.outcome);
    if (raced?.kind === "signaled") throw new ProcessSignalExit(raced.code);
    return signal;
  }
  private signal(signal: number, mode: number): number {
    if (signal === 0 && mode === 0) return this.interrupted();
    try {
      checkedSignalNumber(signal);
      if (!Number.isInteger(mode) || mode < 0 || mode > 3 || (signal === Signal.SIGKILL && mode !== 3)) return -22;
      if (mode === 3) {
        const result = requestSignal(this.options.signals, signal);
        if (result.action === "default" && result.outcome?.kind === "signaled") this.defaultSignal(result.outcome.code);
      } else if (setSignalDisposition(this.options.signals.signalState, signal, mode)) this.defaultSignal(signal);
      return 0;
    } catch (error) {
      if (error instanceof ProcessError) return -22;
      throw error;
    }
  }
  private defaultSignal(signal: number): never {
    checkedSignalNumber(signal);
    this.options.service.defaultSignal(this.options.pid, signal);
    throw new ProcessSignalExit(signal);
  }
  private readiness(sub: Subscription): Readiness | null {
    if (sub.kind === 2) return this.options.service.wait(this.options.pid, sub.id) ? { readable: true, writable: false, hangup: false } : null;
    const fs: NonblockingFileSystem = this.options.fs;
    if (sub.kind === 3) {
      const ready = this.options.service.filesystemReady
        ? this.options.service.filesystemReady(this.options.pid, sub.id)
        : fs.readiness?.(sub.id)?.ready;
      if (ready === undefined) throw new ProcessError(NOSYS, "filesystem completion service is unavailable");
      return ready ? { readable: true, writable: false, hangup: false } : null;
    }
    const resource = this.descriptor(sub.id, POLL).resource;
    if (resource.kind === "file") {
      let state: Readiness = { readable: false, writable: false, hangup: false };
      const result = withFileOffset(resource, () => {
        state = fs.ioReadiness?.(resource.handle, sub.kind === 1) ?? { readable: true, writable: true, hangup: false };
        return 0;
      }, true);
      return result < 0 && result !== -ProcessErrno.AGAIN ? { ...state, hangup: true } : state;
    }
    if (resource.kind === "directory") return { readable: true, writable: true, hangup: false };
    // Preview1 terminal callbacks may block. Availability there is not immediate ABI I/O:
    // an unsupported direction must not report ready (including hangup) forever after EAGAIN.
    if (resource.kind === "terminal" && !(sub.kind === 1 ? resource.tryWrite : resource.tryRead)) {
      return { readable: false, writable: false, hangup: false };
    }
    return resource.readiness();
  }
  private poll(ptr: number, count: number, timeout: number, out: number): number {
    count >>>= 0;
    if (!Number.isInteger(timeout) || timeout < -1) return -ProcessErrno.INVAL;
    if (count > Math.floor(this.memory().buffer.byteLength / 16)) return -FAULT;
    const input = this.view(ptr, count * 16);
    this.span(out, count * 16);
    const subscriptions: Subscription[] = [];
    for (let index = 0; index < count; index++) {
      const at = index * 16;
      const sub = { kind: input.getUint32(at, true), id: input.getUint32(at + 4, true), userdata: input.getBigUint64(at + 8, true) };
      if (sub.kind > 3) return -ProcessErrno.INVAL;
      subscriptions.push(sub);
    }
    if (Atomics.load(this.options.signals.interrupt, 0) !== 0 || this.pending()) return 0;
    const unregister: (() => void)[] = [];
    const wake = this.options.wake;
    try {
      if (wake) {
        const resources = new Set<Stream>();
        for (const sub of subscriptions) {
          if (sub.kind > 1) continue;
          const resource = this.descriptor(sub.id, POLL).resource;
          if (resource.kind === "file" || resource.kind === "directory") continue;
          if (!resources.has(resource)) {
            resources.add(resource);
            const stream: NonblockingStream = resource;
            const release = stream.registerWake?.(wake);
            if (release) unregister.push(release);
          }
        }
      }
      const deadline = timeout === -1 ? Infinity : this.now() + timeout;
      for (;;) {
        // Observe sequence before state; publication racing scan makes Atomics.wait return immediately.
        const sequence = wake ? Atomics.load(wake, 0) : 0;
        if (Atomics.load(this.options.signals.interrupt, 0) !== 0 || this.pending()) return 0;
        const ready: { sub: Subscription; flags: number }[] = [];
        for (const sub of subscriptions) {
          const state = this.readiness(sub);
          if (state && ((sub.kind === 1 ? state.writable : state.readable) || state.hangup)) ready.push({ sub, flags: state.hangup ? 1 : 0 });
        }
        if (ready.length) {
          // Waiting/host services can grow memory; never retain a DataView across them.
          const output = this.view(out, ready.length * 16);
          ready.forEach(({ sub, flags }, index) => {
            const at = index * 16;
            output.setBigUint64(at, sub.userdata, true);
            output.setUint32(at + 8, sub.kind, true);
            output.setUint32(at + 12, flags, true);
          });
          return ready.length;
        }
        if (Atomics.load(this.options.signals.interrupt, 0) !== 0 || this.pending()) return 0;
        const remaining = deadline - this.now();
        if (remaining <= 0) return 0;
        // Signals, local child exits and filesystem locks may publish on independent cells.
        // Until every source guarantees this common wake, rescan within 10 ms even when pipe
        // readiness uses it. Pipe publications still wake this wait immediately.
        const milliseconds = Math.min(remaining, 10);
        const word = wake ?? this.options.signals.interrupt;
        const expected = wake ? sequence : 0;
        if (this.options.wait) this.options.wait(milliseconds, word, expected);
        else Atomics.wait(word, 0, expected, milliseconds);
      }
    } finally { for (const release of unregister.reverse()) release(); }
  }
}
