import { DescriptorTable, MAX_DESCRIPTOR, OpenDescription, type Descriptor, type Resource, type Stream } from "../core/descriptors";
import { ProcessIdentityAllocator } from "./identity";
import { claimOutcome, readOutcome } from "./outcome";
import { requestSignal, type SignalTransport } from "./signals";
import { ProcessErrno, ProcessError, checkedSignal, type ProcessExit, type SpawnRequest } from "./types";

// Fixed shared records make job signalling synchronous even when descendants' messages have
// not reached the page. Slots never recycle: a delayed capability cannot address a new guest.
const HEADER_WORDS = 4;
const RECORD_WORDS = 76;
const SIGNAL_OFFSET = 9;

export interface WorkerDescriptorBinding {
  fd: number;
  reference: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
}
/** A token owns one retained process endpoint, not a second reference on deserialization.
 * import() may run in both controller and worker; its release must therefore be idempotent.
 * File/terminal adapters supply their own cloneable resource token and shared lifetime.
 */
export interface WorkerDescriptorCodec {
  export(descriptor: Descriptor, pid: number): unknown;
  import(token: unknown, pid: number): OpenDescription;
  discard(token: unknown): void;
}
export interface WorkerProcessTransport {
  directory: SharedArrayBuffer;
  identity: SharedArrayBuffer;
  slot: number;
  bindings: WorkerDescriptorBinding[];
  resources: unknown[];
  /** Host adapter context, such as an independently reserved filesystem identity. */
  data?: unknown;
}
export type WorkerProcessMessage =
  | { type: "runtime-proc"; operation: "spawn"; transport: WorkerProcessTransport; request: SpawnRequest }
  | { type: "runtime-proc"; operation: "signal" | "exit"; transport: WorkerProcessTransport; targets: number[] }
  | { type: "runtime-proc"; operation: "pipe"; transport: WorkerProcessTransport; handle: unknown };

function record(transport: WorkerProcessTransport, slot = transport.slot): Int32Array {
  const capacity = (transport.directory.byteLength / 4 - HEADER_WORDS) / RECORD_WORDS;
  if (!Number.isInteger(capacity) || !Number.isInteger(slot) || slot < 0 || slot >= capacity) throw new TypeError("invalid process directory slot");
  return new Int32Array(transport.directory, (HEADER_WORDS + slot * RECORD_WORDS) * 4, RECORD_WORDS);
}
export function workerProcessState(transport: WorkerProcessTransport, slot = transport.slot) {
  const cells = record(transport, slot);
  return {
    pid: Atomics.load(cells, 0), parentPid: Atomics.load(cells, 1), job: Atomics.load(cells, 2),
    jobOwner: Atomics.load(cells, 75),
    confirmed: new Int32Array(cells.buffer, cells.byteOffset + 74 * 4, 1),
    signals: {
      interrupt: new Int32Array(cells.buffer, cells.byteOffset + 3 * 4, 1),
      requestedSignal: new Int32Array(cells.buffer, cells.byteOffset + 4 * 4, 1),
      outcome: new BigInt64Array(cells.buffer, cells.byteOffset + 6 * 4, 1),
      signalState: new Int32Array(cells.buffer, cells.byteOffset + SIGNAL_OFFSET * 4, 65),
    } satisfies SignalTransport,
    // One readiness sequence for the entire service; inherited endpoints can wake every
    // interested process without retaining a cross-worker list of subscriber addresses.
    wake: new Int32Array(transport.directory, 4, 1),
  };
}
function reserveRecord(transport: WorkerProcessTransport, pid: number, parentPid: number, job: number, jobOwner: number): WorkerProcessTransport {
  const header = new Int32Array(transport.directory, 0, HEADER_WORDS);
  const capacity = (transport.directory.byteLength / 4 - HEADER_WORDS) / RECORD_WORDS;
  let slot: number;
  for (;;) {
    slot = Atomics.load(header, 0);
    if (slot >= capacity) throw new ProcessError(ProcessErrno.AGAIN, "process directory is full");
    if (Atomics.compareExchange(header, 0, slot, slot + 1) === slot) break;
  }
  const child: WorkerProcessTransport = { directory: transport.directory, identity: transport.identity, slot, bindings: [], resources: [] };
  const cells = record(child);
  Atomics.store(cells, 1, parentPid);
  Atomics.store(cells, 2, job);
  Atomics.store(cells, 75, jobOwner);
  // Publish identity last. Unpublished reservations cannot be signalled as live processes.
  Atomics.store(cells, 0, pid);
  return child;
}
export function workerProcessDirectoryId(transport: WorkerProcessTransport): string {
  const header = new Uint32Array(transport.directory, 0, HEADER_WORDS);
  return `${header[2]}:${header[3]}`;
}
export function createWorkerProcessTransport(options: { pid?: number; job?: number; identity?: SharedArrayBuffer; capacity?: number } = {}): WorkerProcessTransport {
  const pid = options.pid ?? 1, job = options.job ?? 1, capacity = options.capacity ?? 1024;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new RangeError("invalid process directory capacity");
  const identities = new ProcessIdentityAllocator(options.identity);
  identities.observePid(pid); identities.observeJob(job);
  const transport: WorkerProcessTransport = {
    directory: new SharedArrayBuffer((HEADER_WORDS + capacity * RECORD_WORDS) * 4), identity: identities.buffer,
    slot: 0, bindings: [], resources: [],
  };
  new Uint32Array(transport.directory, 8, 2).set(crypto.getRandomValues(new Uint32Array(2)));
  return reserveRecord(transport, pid, 0, job, pid);
}
export function wakeWorkerProcess(transport: WorkerProcessTransport, slot = transport.slot): void {
  const wake = workerProcessState(transport, slot).wake;
  Atomics.add(wake, 0, 1); Atomics.notify(wake, 0);
}
export function workerProcessSlots(transport: WorkerProcessTransport): number[] {
  const count = Atomics.load(new Int32Array(transport.directory, 0, HEADER_WORDS), 0);
  return Array.from({ length: count }, (_, slot) => slot).filter(slot => workerProcessState(transport, slot).pid !== 0);
}

export interface WorkerSpawnTransfer {
  data?: unknown;
  codec?: WorkerDescriptorCodec;
  /** Commit runs after the request is published, while a filesystem admission fence is held. */
  commit?(): void;
  cancel?(): void;
}
export interface WorkerProcessClientOptions {
  transport: WorkerProcessTransport;
  descriptors: DescriptorTable;
  postMessage(message: WorkerProcessMessage): void;
  codec: WorkerDescriptorCodec;
  prepareSpawn?(pid: number): WorkerSpawnTransfer;
  /** Synchronously freeze shared endpoint cursors after default signal death is selected.
   * A shared pipe publication registry supplies this hook without entering the guest worker.
   */
  revokeProcess?(pid: number, transport: WorkerProcessTransport): void;
  createPipe?(): readonly [Stream, Stream];
  onError?(error: unknown): void;
}
/** Synchronous guest-side process service; only notifications cross the message boundary. */
export class WorkerProcessClient {
  readonly pid: number;
  readonly job: number;
  readonly signals: SignalTransport;
  readonly wake: Int32Array;
  private readonly identities: ProcessIdentityAllocator;
  constructor(readonly options: WorkerProcessClientOptions) {
    const state = workerProcessState(options.transport);
    this.pid = state.pid; this.job = state.job; this.signals = state.signals; this.wake = state.wake;
    this.identities = new ProcessIdentityAllocator(options.transport.identity);
  }
  installBindings(): void { installWorkerBindings(this.options.transport, this.options.descriptors, this.options.codec); }
  private admit(): void {
    if (readOutcome(this.signals.outcome)) throw new ProcessError(ProcessErrno.SRCH, "process has exited");
  }
  spawn(parentPid: number, request: SpawnRequest): number {
    this.admit();
    if (parentPid !== this.pid) throw new ProcessError(ProcessErrno.SRCH, "invalid spawning process");
    const fds = new Set<number>();
    const sources = request.fds.map(binding => {
      if (!Number.isInteger(binding.child) || binding.child < 0 || binding.child > MAX_DESCRIPTOR || !Number.isInteger(binding.parent) || binding.parent < 0 || binding.parent > MAX_DESCRIPTOR || fds.has(binding.child)) throw new ProcessError(ProcessErrno.INVAL, "invalid descriptor binding");
      fds.add(binding.child);
      const source = this.options.descriptors.get(binding.parent);
      if (!source) throw new ProcessError(ProcessErrno.BADF, "missing inherited descriptor");
      return source;
    });
    if (!Number.isInteger(request.job) || request.job < -1) throw new ProcessError(ProcessErrno.INVAL, "invalid job selection");
    const job = request.job > 0 ? request.job : this.identities.job();
    const existingJob = workerProcessSlots(this.options.transport).map(slot => workerProcessState(this.options.transport, slot)).find(state => state.job === job);
    if (request.job > 0 && !existingJob) throw new ProcessError(ProcessErrno.SRCH, "unknown job");
    const pid = this.identities.pid();
    const child = reserveRecord(this.options.transport, pid, this.pid, job, existingJob?.jobOwner ?? this.pid);
    const references = new Map<OpenDescription, number>();
    let transfer: WorkerSpawnTransfer | undefined;
    let codec = this.options.codec;
    try {
      transfer = this.options.prepareSpawn?.(pid);
      codec = transfer?.codec ?? codec;
      child.data = transfer?.data;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;
        let reference = references.get(source.description);
        if (reference === undefined) {
          reference = child.resources.length;
          child.resources.push(codec.export(source, pid));
          references.set(source.description, reference);
        }
        child.bindings.push({ fd: request.fds[i]!.child, reference, rightsBase: source.rightsBase, rightsInheriting: source.rightsInheriting });
      }
      // The worker may immediately mutate the original request or close its source fds.
      const snapshot: SpawnRequest = { ...request, argv: request.argv.slice(), env: { ...request.env }, fds: request.fds.map(binding => ({ ...binding })) };
      this.admit();
      this.options.postMessage({ type: "runtime-proc", operation: "spawn", transport: child, request: snapshot });
    } catch (error) {
      claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 126 });
      for (const token of child.resources) {
        try { codec.discard(token); } catch (cleanupError) { this.report(cleanupError); }
      }
      try { transfer?.cancel?.(); } catch (cleanupError) { this.report(cleanupError); }
      wakeWorkerProcess(this.options.transport);
      throw error;
    }
    // Publication transferred ownership. A failing host commit must never discard resources
    // which the page may already be launching; commit implementations are nonthrowing fences.
    transfer?.commit?.();
    return pid;
  }
  private find(pid: number) {
    for (const slot of workerProcessSlots(this.options.transport)) {
      const state = workerProcessState(this.options.transport, slot);
      if (state.pid === pid) return { slot, ...state };
    }
    throw new ProcessError(ProcessErrno.SRCH, `unknown process ${pid}`);
  }
  wait(parentPid: number, pid: number): ProcessExit | null {
    const target = this.find(pid);
    if (parentPid !== this.pid || target.parentPid !== this.pid) throw new ProcessError(ProcessErrno.CHILD, "not a child process");
    return Atomics.load(target.confirmed, 0) ? readOutcome(target.signals.outcome) : null;
  }
  jobOf(pid: number): number { return this.find(pid).job; }
  canSignal(callerPid: number, pid: number): boolean {
    if (callerPid !== this.pid) return false;
    const seen = new Set<number>();
    let target = this.find(pid);
    for (;;) {
      if (target.pid === this.pid) return true;
      if (target.parentPid === 0 || seen.has(target.parentPid)) return false;
      seen.add(target.pid);
      target = this.find(target.parentPid);
    }
  }
  canSignalJob(callerPid: number, job: number): boolean {
    if (callerPid !== this.pid) return false;
    return workerProcessSlots(this.options.transport).some(slot => {
      const state = workerProcessState(this.options.transport, slot);
      return state.job === job && state.jobOwner === this.pid;
    });
  }
  kill(pid: number, signal: number): void {
    if (!this.canSignal(this.pid, pid)) throw new ProcessError(63, "process is outside the caller's ancestry");
    this.deliver([this.find(pid)], checkedSignal(signal));
  }
  killJob(job: number, signal: number): void {
    const targets = workerProcessSlots(this.options.transport).map(slot => ({ slot, ...workerProcessState(this.options.transport, slot) })).filter(state => state.job === job);
    if (!targets.length) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${job}`);
    if (!this.canSignalJob(this.pid, job)) throw new ProcessError(63, "job is not owned by the caller");
    this.deliver(targets, checkedSignal(signal));
  }
  private deliver(targets: { slot: number; pid: number; parentPid: number; signals: SignalTransport }[], signal: number): void {
    this.admit();
    for (const target of targets) requestSignal(target.signals, signal);
    // Select every target before resource callbacks, then freeze all canonical cursors before
    // returning to the guest. Handled and ignored signals must not revoke endpoints.
    for (const target of targets) {
      if (readOutcome(target.signals.outcome)?.kind === "signaled") this.options.revokeProcess?.(target.pid, this.options.transport);
    }
    for (const target of targets) {
      wakeWorkerProcess(this.options.transport, target.slot);
      const parent = workerProcessSlots(this.options.transport).find(slot => workerProcessState(this.options.transport, slot).pid === target.parentPid);
      if (parent !== undefined) wakeWorkerProcess(this.options.transport, parent);
    }
    this.options.postMessage({ type: "runtime-proc", operation: "signal", transport: this.options.transport, targets: targets.map(target => target.pid) });
  }
  defaultSignal(pid: number, signal: number): void {
    if (pid !== this.pid) throw new ProcessError(ProcessErrno.SRCH, "invalid default signal process");
    if (!Number.isInteger(signal) || signal < 1 || signal > 64) throw new ProcessError(ProcessErrno.INVAL, "invalid default signal");
    const winner = claimOutcome(this.signals.outcome, { kind: "signaled", code: Atomics.load(this.signals.requestedSignal, 0) === 9 ? 9 : signal });
    if (winner.kind === "signaled") this.options.revokeProcess?.(pid, this.options.transport);
    wakeWorkerProcess(this.options.transport);
    this.options.postMessage({ type: "runtime-proc", operation: "exit", transport: this.options.transport, targets: [pid] });
  }
  exit(code: number): void {
    claimOutcome(this.signals.outcome, { kind: "exited", code });
    wakeWorkerProcess(this.options.transport);
    this.options.postMessage({ type: "runtime-proc", operation: "exit", transport: this.options.transport, targets: [this.pid] });
  }
  createPipe(): readonly [Stream, Stream] {
    if (!this.options.createPipe) throw new ProcessError(58, "worker pipe factory is unavailable");
    return this.options.createPipe();
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Diagnostics never own cleanup. */ } }
}

/** Group duplicate bindings by open description, retaining exactly one transferred lifetime. */
export function installWorkerBindings(transport: WorkerProcessTransport, descriptors: DescriptorTable, codec: WorkerDescriptorCodec): void {
  const imported = new Map<number, { description: OpenDescription; resource: Resource }>();
  const staged = new DescriptorTable();
  try {
    for (const binding of transport.bindings) {
      let source = imported.get(binding.reference);
      if (!source) {
        if (!Number.isInteger(binding.reference) || binding.reference < 0 || binding.reference >= transport.resources.length) throw new TypeError("invalid transferred descriptor reference");
        const description = codec.import(transport.resources[binding.reference], workerProcessState(transport).pid);
        staged.add(description, { rightsBase: binding.rightsBase, rightsInheriting: binding.rightsInheriting });
        source = { description, resource: description.resource };
        imported.set(binding.reference, source);
      }
      descriptors.inherit(binding.fd, { ...source, rightsBase: binding.rightsBase, rightsInheriting: binding.rightsInheriting });
    }
  } finally { staged.dispose(); }
}
