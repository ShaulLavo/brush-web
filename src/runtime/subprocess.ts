// Adapted from bun-wasm web/src/subprocess.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
import type { Stream } from "@bun-wasm/runtime/core";
import { attachPipeEndpoint, type PipeEndpointHandle } from "@bun-wasm/runtime/proc/pipes";
import type { EngineNet } from "./net/host";
import type { SlotImpls } from "./net/trampoline";
import { ProcessIdentityAllocator } from "@bun-wasm/runtime/proc/identity";
import { claimOutcome, outcomeWord, readOutcome } from "@bun-wasm/runtime/proc/outcome";
import {
  createSignalState,
  publishSignal,
  requestSignal,
  setSignalDisposition,
  takeSignal,
} from "@bun-wasm/runtime/proc/signals";
import { memoryViews } from "@bun-wasm/runtime/core/memory-views.js";
import { InheritedWorkerPipes, workerBuffers } from "./worker-pipes";

export interface SpawnMeta {
  executable?: string;
  worker?: {
    memoryLimitMb?: number;
    resourceLimits?: {
      maxOldGenerationSizeMb?: number;
      maxYoungGenerationSizeMb?: number;
      codeRangeSizeMb?: number;
      stackSizeMb?: number;
    };
  };
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  job?: number;
  stdin?: "pipe" | "inherit" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
}
export interface ChildTransport {
  pid: number;
  parentPid: number;
  jobId: number;
  identity: SharedArrayBuffer;
  interrupt: SharedArrayBuffer;
  requestedSignal: SharedArrayBuffer;
  signalState: SharedArrayBuffer;
  outcome: SharedArrayBuffer;
  budget: SharedArrayBuffer;
  slot: number;
  token: number;
  inheritedStdin?: boolean;
  /** Retained generic pipe reader when Bun.spawn inherits a runtime_proc pipeline. */
  runtimeStdin?: PipeEndpointHandle;
  pipes: SharedArrayBuffer[];
  control: SharedArrayBuffer;
}
export interface ChildWorker {
  /** Revoke access before requesting physical worker termination. */
  revoke?(): void;
  terminate(): unknown;
}
export interface SubprocessOptions {
  budget?: SharedArrayBuffer;
  identity?: SharedArrayBuffer;
  pid?: number;
  jobId?: number;
  slot?: number;
  token?: number;
  stdin?: SharedArrayBuffer;
  readInput?(capacity: number): Uint8Array | number;
  inheritStdinPipe?(pid: number): PipeEndpointHandle | undefined;
  workerTransport?: ChildTransport;
  /** Current process dispositions and pending signals; never inherited by a new child. */
  signalState?: Int32Array | SharedArrayBuffer;
  /** Adopt the current process's existing terminal decision for signal-entry checkpoints. */
  outcome?: BigInt64Array | SharedArrayBuffer;
  /** Synchronously apply a raised, selected, or newly unhandled fatal signal. */
  defaultSignal?(signal: number): void;
  /** Shared process capability revocation, including roots without a budget slot. */
  revoked?(): boolean;
  onChildClose?(pid: number): void;
  launch(
    meta: SpawnMeta,
    transport: ChildTransport,
    onError: (error: unknown) => void,
  ): ChildWorker;
  /** Return false when the inherited reader has closed. */
  output(fd: number, bytes: Uint8Array): void | boolean;
}

// Shared transport for browser and Node workers. No native executables are launched.
const NativeEncoder = TextEncoder;
const NativeDecoder = TextDecoder;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const encode = new NativeEncoder();
const decode = new NativeDecoder();
const AGAIN = -2;
const BADF = -3;
const PIPE_SIZE = 1 << 20;
// Bun's numeric slot ABI shares close/read/write with network handles. Keep actual PIDs and
// pipe handles in disjoint high ranges; generic runtime_proc identities have no such restriction.
const FIRST_PROCESS = 0x60000000;
const FIRST_HANDLE = 0x70000000;
// Higher handles are reserved for the current worker's inherited message channels.
const HANDLE_LIMIT = 0x7fff0000;
export const MAX_CHILDREN = 4;
// Slot 14 selectors: 0..2 stdio, 3 immutable final signal, 4/5 worker message channels.
export const CHILD_FINAL_SIGNAL = 3;

export function createProcessBudget() {
  return new SharedArrayBuffer(8 + MAX_CHILDREN * 4);
}

function wake(budget?: SharedArrayBuffer) {
  if (budget === undefined) return;
  const cells = new Int32Array(budget);
  Atomics.add(cells, 1, 1);
  Atomics.notify(cells, 1);
}

export class SharedPipe {
  buffer: SharedArrayBuffer;
  cells: Int32Array;
  bytes: Uint8Array;
  budget?: SharedArrayBuffer;
  constructor(buffer = new SharedArrayBuffer(16 + PIPE_SIZE), budget?: SharedArrayBuffer) {
    this.buffer = buffer;
    this.cells = new Int32Array(buffer, 0, 4);
    this.bytes = new Uint8Array(buffer, 16);
    this.budget = budget;
  }
  readiness() {
    const closed = Atomics.load(this.cells, 2) !== 0;
    const read = Atomics.load(this.cells, 0) >>> 0;
    const written = Atomics.load(this.cells, 1) >>> 0;
    const nbytes = (written - read) >>> 0;
    return {
      readable: nbytes > 0 || closed,
      writable: !closed && nbytes < PIPE_SIZE,
      hangup: closed,
      nbytes,
    };
  }
  read(cap = 65536) {
    if (cap === 0) return 0;
    const read = Atomics.load(this.cells, 0) >>> 0;
    // Observing EOF must also observe every write published before close().
    const closed = Atomics.load(this.cells, 2);
    const written = Atomics.load(this.cells, 1) >>> 0;
    const size = Math.min((written - read) >>> 0, cap);
    if (!size) return closed ? 0 : AGAIN;
    const start = read % PIPE_SIZE;
    const first = Math.min(size, PIPE_SIZE - start);
    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(start, start + first));
    if (first < size) out.set(this.bytes.subarray(0, size - first), first);
    Atomics.store(this.cells, 0, (read + size) | 0);
    Atomics.add(this.cells, 3, 1);
    Atomics.notify(this.cells, 3);
    return out;
  }
  write(bytes: Uint8Array) {
    if (Atomics.load(this.cells, 2)) return -1;
    const read = Atomics.load(this.cells, 0) >>> 0;
    const written = Atomics.load(this.cells, 1) >>> 0;
    const size = Math.min(PIPE_SIZE - ((written - read) >>> 0), bytes.length);
    if (!size) return bytes.length ? AGAIN : 0;
    const start = written % PIPE_SIZE;
    const first = Math.min(size, PIPE_SIZE - start);
    this.bytes.set(bytes.subarray(0, first), start);
    if (first < size) this.bytes.set(bytes.subarray(first, size), 0);
    Atomics.store(this.cells, 1, (written + size) | 0);
    Atomics.add(this.cells, 3, 1);
    Atomics.notify(this.cells, 3);
    wake(this.budget);
    return size;
  }
  writeAll(bytes: Uint8Array) {
    let at = 0;
    while (at < bytes.length) {
      const seen = Atomics.load(this.cells, 3);
      const n = this.write(bytes.subarray(at));
      if (n === AGAIN) Atomics.wait(this.cells, 3, seen, 100);
      else if (n < 0) return;
      else at += n;
    }
  }
  readBlocking(cap: number) {
    for (;;) {
      const seen = Atomics.load(this.cells, 3);
      const value = this.read(cap);
      if (value !== AGAIN) return value;
      Atomics.wait(this.cells, 3, seen, 100);
    }
  }
  close() {
    Atomics.store(this.cells, 2, 1);
    Atomics.add(this.cells, 3, 1);
    Atomics.notify(this.cells, 3);
    wake(this.budget);
  }
}

/** Original adapter from the existing Bun pipe transport to runtime descriptors. */
export function wasiPipe(pipe: SharedPipe, mode: "read" | "write"): Stream {
  return {
    kind: "pipe",
    read(chunks) {
      if (mode !== "read") return -8;
      const size = chunks.reduce((n, chunk) => n + chunk.length, 0);
      if (size === 0) return 0;
      const value = pipe.readBlocking(size);
      if (typeof value === "number") return value;
      let at = 0;
      for (const chunk of chunks) {
        const count = Math.min(chunk.length, value.length - at);
        chunk.set(value.subarray(at, at + count));
        at += count;
      }
      return at;
    },
    write(chunks) {
      if (mode !== "write") return -8;
      let written = 0;
      for (const chunk of chunks) {
        let at = 0;
        while (at < chunk.length) {
          const seen = Atomics.load(pipe.cells, 3);
          const n = pipe.write(chunk.subarray(at));
          if (n === AGAIN) Atomics.wait(pipe.cells, 3, seen, 100);
          else if (n < 0) return written || -64;
          else {
            at += n;
            written += n;
          }
        }
      }
      return written;
    },
    readiness() {
      const state = pipe.readiness();
      return {
        ...state,
        readable: mode === "read" && state.readable,
        writable: mode === "write" && state.writable,
      };
    },
    // ChildTransport.finish owns closure until the process layer gains inherited endpoint refs.
  };
}

/** Release active-process capacity independently of the parent's wait/close lifetime. */
export function releaseProcessSlot(
  transport: Pick<ChildTransport, "budget" | "slot" | "token">,
): void {
  const cells = new Int32Array(transport.budget);
  const index = transport.slot + 2;
  const state = Atomics.load(cells, index);
  if (state > 0 && Math.floor(state / 8) === transport.token)
    Atomics.compareExchange(cells, index, state, 0);
}

export function childTransport(transport: ChildTransport) {
  return {
    stdin: new SharedPipe(transport.pipes[0], transport.budget),
    stdout: new SharedPipe(transport.pipes[1], transport.budget),
    stderr: new SharedPipe(transport.pipes[2], transport.budget),
    finish(code: number, signal?: number) {
      const result = claimOutcome(
        outcomeWord(transport.outcome),
        signal === undefined ? { kind: "exited", code } : { kind: "signaled", code: signal },
      );
      const cells = new Int32Array(transport.control, 0, 4);
      if (Atomics.load(cells, 0)) return;
      Atomics.store(cells, 1, result.status);
      if (transport.runtimeStdin) {
        const input = attachPipeEndpoint(transport.runtimeStdin);
        input.revoke();
        input.close();
      }
      for (const [fd, pipe] of transport.pipes.entries()) {
        if (fd === 0 && transport.inheritedStdin) continue;
        new SharedPipe(pipe, transport.budget).close();
      }
      releaseProcessSlot(transport);
      Atomics.store(cells, 0, 1);
      Atomics.notify(cells, 0);
      wake(transport.budget);
    },
  };
}

type Child = {
  transport: ChildTransport;
  pipes: SharedPipe[];
  handles: number[];
  modes: string[];
  worker: ChildWorker | null;
  ended: boolean;
};

export class SubprocessHost {
  options: SubprocessOptions;
  budget: SharedArrayBuffer;
  identity: SharedArrayBuffer;
  signalState: Int32Array;
  identities: ProcessIdentityAllocator;
  children: Map<number, Child>;
  handles: Map<number, { pipe: SharedPipe; fd: number; child: number }>;
  pipeErrors: Map<number, string>;
  nextHandle: number;
  lastError: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  notify: () => void;
  memory: ReturnType<typeof memoryViews> | null;
  stdin: SharedPipe | null;
  workerPipes: InheritedWorkerPipes;
  stdinWaiting: boolean;
  private detached = false;
  constructor(options: SubprocessOptions) {
    this.options = options;
    this.signalState = createSignalState(options.signalState);
    this.budget = options.budget || createProcessBudget();
    this.workerPipes = new InheritedWorkerPipes(options.workerTransport);
    this.identities = new ProcessIdentityAllocator(options.identity);
    this.identity = this.identities.buffer;
    this.identities.observePid(Math.max(FIRST_PROCESS, options.pid ?? 1));
    this.identities.observeJob(options.jobId ?? 1);
    this.children = new Map();
    this.handles = new Map();
    this.pipeErrors = new Map();
    this.nextHandle = FIRST_HANDLE;
    this.lastError = null;
    this.timer = null;
    this.notify = () => {};
    this.memory = null;
    this.stdin = options.stdin ? new SharedPipe(options.stdin, this.budget) : null;
    this.stdinWaiting = false;
  }
  attach(memory: WebAssembly.Memory) {
    this.memory = memoryViews(memory);
  }
  private fatalSignal(): number {
    const outcome = this.options.outcome;
    const winner = outcome === undefined ? null : readOutcome(outcomeWord(outcome));
    return winner?.kind === "signaled" ? winner.code : 0;
  }
  /** Admit guest capability use against the existing current-process terminal decision. */
  private admit(): boolean {
    const signal = this.fatalSignal();
    if (signal === 0) return true;
    // Keep the default callback outside guest-input catches; production callbacks terminate.
    this.options.defaultSignal?.(signal);
    return false;
  }
  fail(message: string, code: string) {
    this.lastError = JSON.stringify({ name: "Error", message, code });
    return -1;
  }
  parentActive(cells: Int32Array) {
    if (this.detached || this.options.revoked?.()) return false;
    const slot = this.options.slot;
    if (slot === undefined) return true;
    const state = Atomics.load(cells, slot + 2);
    return state > 0 && Math.floor(state / 8) === this.options.token;
  }
  reserve() {
    const cells = new Int32Array(this.budget);
    if (!this.parentActive(cells)) return null;
    const token = Atomics.add(cells, 0, 1) + 1;
    if (token <= 0 || token > 0x0fffffff) return null;
    const parent = this.options.slot;
    // One atomic word carries both generation and parent link; checking a separate token races reuse.
    const state = token * 8 + (parent === undefined ? 1 : parent + 2);
    for (let slot = 0; slot < MAX_CHILDREN; slot++) {
      if (Atomics.compareExchange(cells, slot + 2, 0, state) !== 0) continue;
      if (this.parentActive(cells)) return { slot, token };
      this.releaseSlot(slot, token);
      return null;
    }
    return null;
  }
  releaseSlot(slot: number, token: number) {
    releaseProcessSlot({ budget: this.budget, slot, token });
  }
  spawn(text: string) {
    if (!this.admit()) return -1;
    let meta: SpawnMeta;
    try {
      meta = JSON.parse(text);
    } catch {
      return this.fail("spawn: invalid metadata", "EINVAL");
    }
    if (!meta || typeof meta !== "object") return this.fail("spawn: invalid metadata", "EINVAL");
    if (
      !Array.isArray(meta.argv) ||
      !meta.argv.length ||
      meta.argv.some((v) => typeof v !== "string")
    )
      return this.fail("spawn: invalid argv", "EINVAL");
    const executable = meta.executable === undefined ? meta.argv[0] : meta.executable;
    if (
      typeof executable !== "string" ||
      !executable ||
      executable.includes("\0") ||
      meta.argv.some((value) => value.includes("\0"))
    )
      return this.fail("spawn: invalid executable", "EINVAL");
    if (meta.job !== undefined && (!Number.isInteger(meta.job) || meta.job < -1))
      return this.fail("spawn: invalid job", "EINVAL");
    meta.executable = executable;
    if (meta.cwd !== undefined && typeof meta.cwd !== "string")
      return this.fail("spawn: invalid cwd", "EINVAL");
    if (
      meta.env !== undefined &&
      (!meta.env ||
        typeof meta.env !== "object" ||
        Array.isArray(meta.env) ||
        Object.values(meta.env).some((v) => typeof v !== "string"))
    )
      return this.fail("spawn: invalid env", "EINVAL");
    const modes = [meta.stdin || "pipe", meta.stdout || "pipe", meta.stderr || "pipe"];
    if (modes.some((mode) => !["pipe", "inherit", "ignore"].includes(mode)))
      return this.fail("spawn: invalid stdio", "EINVAL");
    const channels = workerBuffers(meta);
    if (
      this.nextHandle + modes.filter((mode) => mode === "pipe").length + channels.length >
      HANDLE_LIMIT
    )
      return this.fail("spawn: pipe handle space exhausted", "EAGAIN");
    const reservation = this.reserve();
    if (!reservation)
      return this.fail("spawn: at most four bun-wasm child instances may run", "EAGAIN");
    const { slot, token } = reservation;
    const buffers = modes.map(() => new SharedArrayBuffer(16 + PIPE_SIZE)).concat(channels);
    const inheritedStdin = modes[0] === "inherit" && Boolean(this.options.stdin);
    if (inheritedStdin) buffers[0] = this.options.stdin!;
    let id: number;
    let jobId: number;
    let runtimeStdin: PipeEndpointHandle | undefined;
    try {
      id = this.identities.pid();
      if (id >= FIRST_HANDLE) throw new Error("process id space exhausted");
      jobId =
        meta.job === 0 || meta.job === -1
          ? this.identities.job()
          : (meta.job ?? this.options.jobId ?? 1);
      if (modes[0] === "inherit") runtimeStdin = this.options.inheritStdinPipe?.(id);
    } catch (error) {
      this.releaseSlot(slot, token);
      return this.fail(String(error), "EAGAIN");
    }
    const transport: ChildTransport = {
      pid: id,
      parentPid: this.options.pid ?? 1,
      jobId,
      identity: this.identity,
      interrupt: new SharedArrayBuffer(4),
      requestedSignal: new SharedArrayBuffer(4),
      signalState: createSignalState().buffer as SharedArrayBuffer,
      outcome: new SharedArrayBuffer(8),
      budget: this.budget,
      slot,
      token,
      inheritedStdin,
      runtimeStdin,
      pipes: buffers,
      control: new SharedArrayBuffer(16),
    };
    const pipes = transport.pipes.map((buffer) => new SharedPipe(buffer, this.budget));
    const handles = pipes.map((pipe, fd) => {
      if (fd < 3 && modes[fd] !== "pipe") return 0;
      const handle = this.nextHandle++;
      this.handles.set(handle, { pipe, fd, child: id });
      return handle;
    });
    const child: Child = { transport, pipes, handles, modes, worker: null, ended: false };
    this.children.set(id, child);
    if (modes[0] !== "pipe" && !inheritedStdin) pipes[0]!.close();
    try {
      child.worker = this.options.launch(meta, transport, (error) => this.workerError(id, error));
    } catch (error) {
      this.kill(id, 9);
      this.release(id);
      return this.fail(
        String(error),
        error && typeof error === "object" && "code" in error ? String(error.code) : "EIO",
      );
    }
    this.watch();
    return id;
  }
  workerError(id: number, error: unknown) {
    const child = this.children.get(id);
    if (!child || child.ended) return;
    child.pipes[2]!.write(encode.encode(`bun-wasm: ${String(error)}\n`));
    childTransport(child.transport).finish(1);
    this.notify();
  }
  pipe(id: number, fd: number) {
    if (!this.admit()) return -1;
    if (id === 0) return this.workerPipes.handle(fd);
    if (fd === CHILD_FINAL_SIGNAL && !this.parentActive(new Int32Array(this.budget)))
      return this.fail("child outcome: process is no longer active", "ESRCH");
    const child = this.children.get(id);
    if (!child) return BADF;
    if (fd === CHILD_FINAL_SIGNAL) {
      if (!Atomics.load(new Int32Array(child.transport.control), 0)) return AGAIN;
      const result = readOutcome(outcomeWord(child.transport.outcome))!;
      return result.kind === "signaled" ? result.code : 0;
    }
    if (fd === 4 || fd === 5) return child.handles[fd - 1] ?? BADF;
    return fd >= 0 && fd <= 2 ? (child.handles[fd] ?? BADF) : BADF;
  }
  read(handle: number, cap = 65536) {
    if (!this.admit()) return -1;
    if (this.workerPipes.owns(handle)) {
      this.watch();
      return this.workerPipes.read(handle, cap);
    }
    if (handle === 0) {
      const value = this.options.readInput
        ? this.options.readInput(cap)
        : this.stdin
          ? this.stdin.read(cap)
          : -4;
      this.stdinWaiting = value === AGAIN;
      if (this.stdinWaiting) this.watch();
      return value;
    }
    const h = this.handles.get(handle);
    return h && h.fd !== 0 && h.fd !== 3 ? h.pipe.read(cap) : BADF;
  }
  write(handle: number, bytes: Uint8Array) {
    if (!this.admit()) return -1;
    if (this.workerPipes.owns(handle)) {
      const result = this.workerPipes.write(handle, bytes);
      return result === -1 ? this.closedPipe(handle) : result;
    }
    const h = this.handles.get(handle);
    if (!h || (h.fd !== 0 && h.fd !== 3)) return BADF;
    const result = h.pipe.write(bytes);
    return result === -1 ? this.closedPipe(handle) : result;
  }
  closedPipe(handle: number) {
    this.pipeErrors.set(
      handle,
      JSON.stringify({
        name: "Error",
        message: "EPIPE: broken pipe, write",
        code: "EPIPE",
        errno: -32,
        syscall: "write",
      }),
    );
    return -1;
  }
  close(handle: number) {
    if (!this.admit()) return -1;
    if (this.workerPipes.owns(handle)) return this.workerPipes.close(handle);
    if (this.children.has(handle)) {
      const result = this.kill(handle, 9);
      if (result < 0) return result;
      this.release(handle);
      return 0;
    }
    const h = this.handles.get(handle);
    if (!h) return BADF;
    h.pipe.close();
    this.handles.delete(handle);
    this.pipeErrors.delete(handle);
    return 0;
  }
  wait(id: number) {
    if (!this.admit()) return -1;
    return this.waitAdmitted(id);
  }
  private waitAdmitted(id: number) {
    if (!this.parentActive(new Int32Array(this.budget)))
      return this.fail("wait: process is no longer active", "ESRCH");
    return this.waitInternal(id);
  }
  private waitInternal(id: number) {
    const child = this.children.get(id);
    if (!child) return BADF;
    this.drainInherited(child);
    const cells = new Int32Array(child.transport.control, 0, 4);
    if (!Atomics.load(cells, 0)) return AGAIN;
    if (!child.ended) this.reap(child);
    return readOutcome(outcomeWord(child.transport.outcome))!.status;
  }
  reap(child: Child) {
    child.ended = true;
    this.releaseSlot(child.transport.slot, child.transport.token);
    child.worker?.terminate();
  }
  release(id: number) {
    const child = this.children.get(id);
    if (!child) return;
    for (const handle of child.handles) {
      this.handles.delete(handle);
      this.pipeErrors.delete(handle);
    }
    this.children.delete(id);
    this.options.onChildClose?.(child.transport.pid);
  }
  /** Current-process disposition, handled-pending dequeue, and mode 3 RAISE (Bun host slot 18). */
  signal(signal: number, mode: number): number {
    if (!this.admit()) return 0;
    if (signal === 0) return mode === 0 ? takeSignal(this.signalState) : -22;
    let applyDefault: boolean;
    try {
      applyDefault =
        mode === 3
          ? publishSignal(this.signalState, signal) === "default"
          : setSignalDisposition(this.signalState, signal, mode);
    } catch {
      return -22;
    }
    // Do not catch callback exceptions: applying the default can terminate the current guest.
    if (applyDefault) this.options.defaultSignal?.(signal);
    return 0;
  }
  kill(id: number, signal = 15) {
    if (!this.admit()) return -1;
    if (!this.parentActive(new Int32Array(this.budget)))
      return this.fail("kill: process is no longer active", "ESRCH");
    // This control operation was admitted alive; concurrent revocation may linearize afterward.
    return this.killInternal(id, signal);
  }
  private killInternal(id: number, signal: number) {
    const child = this.children.get(id);
    if (!child) return BADF;
    if (![0, 2, 9, 13, 15].includes(signal)) return this.fail("kill: invalid signal", "EINVAL");
    if (this.waitInternal(id) !== AGAIN || signal === 0) return 0;
    const transport = child.transport;
    const result = requestSignal(
      {
        signalState: createSignalState(transport.signalState),
        interrupt: new Int32Array(transport.interrupt),
        requestedSignal: new Int32Array(transport.requestedSignal),
        outcome: outcomeWord(transport.outcome),
      },
      signal,
    );
    if (result.action === "handled" || result.outcome?.kind === "signaled") wake(this.budget);
    // The shared helper claims a default outcome before publishing any audit or wake word.
    // Handled signals only wake the guest; its eventual ordinary exit remains authoritative.
    if (result.outcome?.kind !== "signaled") return 0;
    signal = result.outcome.code;
    child.worker?.revoke?.();
    Atomics.store(new Int32Array(transport.control), 3, 1);
    // Close this process's endpoints before physical teardown; inherited stdin is not ours.
    childTransport(transport).finish(128 + signal, signal);
    child.worker?.terminate();
    this.waitInternal(id);
    return 0;
  }
  drainInherited(child: Child) {
    if (this.fatalSignal() !== 0) return;
    for (const fd of [1, 2]) {
      if (child.modes[fd] === "pipe") continue;
      this.drainPipe(child, fd);
    }
  }
  drainPipe(child: Child, fd: number) {
    for (;;) {
      const bytes = child.pipes[fd]!.read();
      if (typeof bytes === "number") return;
      if (child.modes[fd] !== "inherit" || this.options.output(fd, bytes) !== false) continue;
      child.pipes[fd]!.close();
      return;
    }
  }
  poll(timeout = 0) {
    if (!this.admit()) return -1;
    return this.pollAdmitted(timeout);
  }
  private pollAdmitted(timeout = 0) {
    for (const id of this.children.keys()) this.waitAdmitted(id);
    if (!timeout) return 0;
    const cells = new Int32Array(this.budget);
    const seen = Atomics.load(cells, 1);
    Atomics.wait(cells, 1, seen, timeout < 0 ? 4 : Math.min(timeout, 4));
    for (const id of this.children.keys()) this.waitAdmitted(id);
    return Atomics.load(cells, 1) !== seen ? 1 : 0;
  }
  watch() {
    if (this.detached || this.timer !== null || this.fatalSignal() !== 0) return;
    this.timer = nativeSetTimeout(() => {
      this.timer = null;
      // This host timer is not guest reentry: stop quietly rather than throwing a guest exit.
      if (this.fatalSignal() !== 0) return;
      this.pollAdmitted();
      this.notify();
      if (
        this.workerPipes.active ||
        this.stdinWaiting ||
        Array.from(this.children.values()).some((child) => !child.ended)
      )
        this.watch();
    }, 4);
  }
  detach() {
    this.detached = true;
    this.stdinWaiting = false;
    if (this.timer !== null) nativeClearTimeout(this.timer);
    this.timer = null;
  }
  dispose() {
    this.detach();
    for (const id of this.children.keys()) {
      // Host-owned teardown is not a guest control entry and must also clean detached fixtures.
      this.killInternal(id, 9);
      this.release(id);
    }
  }
  owns(handle: number) {
    return handle >= FIRST_PROCESS;
  }
  engineNet(net?: EngineNet): EngineNet {
    const fallback = Object.fromEntries(
      Object.entries(net?.natives || {}).map(([name, fn]) => [
        name,
        (...args: never[]) => {
          if (name !== "hostError") this.lastError = null;
          return fn(...args);
        },
      ]),
    );
    const natives: EngineNet["natives"] = {
      ...fallback,
      hostPoll: (timeout) => this.poll(timeout),
      hostSpawn: (meta) => this.spawn(meta),
      hostChildWait: (id) => this.wait(id),
      hostChildPipe: (id, fd) => this.pipe(id, fd),
      hostChildKill: (id, signal) => this.kill(id, signal),
      hostSignal: (signal, mode) => this.signal(signal, mode),
      hostRead: (id: number, cap?: number) =>
        this.owns(id) || id === 0
          ? this.read(id, cap)
          : (fallback.hostRead?.(...([id, cap] as never[])) ?? BADF),
      hostWrite: (id: number, bytes: Uint8Array) =>
        this.owns(id)
          ? this.write(id, bytes)
          : (fallback.hostWrite?.(...([id, bytes] as never[])) ?? BADF),
      hostClose: (id: number) =>
        this.owns(id) ? this.close(id) : (fallback.hostClose?.(...([id] as never[])) ?? BADF),
      hostError: (id) =>
        this.pipeErrors.get(id) ??
        (id === 0 && this.lastError
          ? this.lastError
          : (fallback.hostError?.(...([id] as never[])) ?? this.lastError ?? BADF)),
    };
    return {
      natives: Object.fromEntries(
        Object.entries(natives).map(([name, fn]) => [
          name,
          (...args: never[]) => {
            if (!this.admit()) return name === "hostSignal" ? 0 : -1;
            return fn(...args);
          },
        ]),
      ),
      caps: {
        ...net?.caps,
        spawn: true,
        child_wait: true,
        child_pipe: true,
        child_kill: true,
        signal: true,
        read: true,
        write: true,
        close: true,
        error: true,
      },
      onNews: (cb) => {
        this.notify = cb;
        net?.onNews(cb);
      },
    };
  }
  slots(network: SlotImpls = {}): SlotImpls {
    const net = Object.fromEntries(
      Object.entries(network).map(([name, fn]) => [
        name,
        (...args: number[]) => {
          if (name !== "error" && name !== "poll") this.lastError = null;
          return fn(...args);
        },
      ]),
    );
    const bytes = (ptr: number, len: number) => {
      if (!this.memory) throw new Error("Subprocess memory is not attached");
      return this.memory.range(ptr >>> 0, len);
    };
    const read = (id: number, ptr: number, cap: number) => {
      const value = this.read(id, cap);
      if (typeof value === "number") return value;
      bytes(ptr, value.length).set(value);
      return value.length;
    };
    const error = (id: number, ptr: number, cap: number) => {
      const value = encode.encode(
        this.pipeErrors.get(id) ?? this.lastError ?? '{"message":"no error"}',
      );
      if (value.length <= cap) bytes(ptr, value.length).set(value);
      return value.length;
    };
    const impls: SlotImpls = {
      ...net,
      spawn: (ptr, len) => this.spawn(decode.decode(bytes(ptr, len).slice())),
      child_wait: (id) => this.wait(id),
      child_pipe: (id, fd) => this.pipe(id, fd),
      child_kill: (id, signal) => this.kill(id, signal),
      signal: (signal, mode) => this.signal(signal, mode),
      read: (id, ptr, cap) =>
        id === 0 || this.owns(id) ? read(id, ptr, cap) : (net.read?.(id, ptr, cap) ?? BADF),
      write: (id, ptr, len) =>
        this.owns(id) ? this.write(id, bytes(ptr, len)) : (net.write?.(id, ptr, len) ?? BADF),
      close: (id) => (this.owns(id) ? this.close(id) : (net.close?.(id) ?? BADF)),
      error: (id, ptr, cap) =>
        this.pipeErrors.has(id) || (id === 0 && this.lastError)
          ? error(id, ptr, cap)
          : (net.error?.(id, ptr, cap) ?? BADF),
      poll: (timeout) => {
        const news = net.poll?.(0) || 0;
        return this.poll(news ? 0 : timeout) || news;
      },
    };
    return Object.fromEntries(
      Object.entries(impls).map(([name, fn]) => [
        name,
        (...args: number[]) => {
          if (!this.admit()) return name === "signal" ? 0 : -1;
          return fn(...args);
        },
      ]),
    );
  }
}
