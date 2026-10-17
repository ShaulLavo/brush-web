import { DescriptorTable } from "../core/descriptors";
import { claimOutcome, readOutcome } from "./outcome";
import { requestSignal } from "./signals";
import type { ProcessSupervisor } from "./supervisor";
import { ProcessErrno, ProcessError } from "./types";
import { installWorkerBindings, wakeWorkerProcess, workerProcessDirectoryId, workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "./worker-client";

export interface WorkerProcessBrokerOptions {
  /** Reuse the host's supervisor and executable registry, including its legacy Bun children. */
  supervisor(): Promise<ProcessSupervisor>;
  codec: WorkerDescriptorCodec | ((transport: WorkerProcessTransport) => WorkerDescriptorCodec);
  /** Optional pipe layer hooks; the ownership transport has no dependency on pipe primitives. */
  onPipe?(handle: unknown, transport: WorkerProcessTransport): void;
  pumpPipes?(): void;
  onError?(error: unknown): void;
}

/** Page-side admission over an existing supervisor. The worker has already retained every
 * transferred resource before its spawn message is queued. No request waits for page reply.
 */
export class WorkerProcessBroker {
  private readonly transports = new Map<number, WorkerProcessTransport>();
  private supervisor?: ProcessSupervisor;
  private activation?: Promise<ProcessSupervisor>;
  private stopListening?: () => void;
  private disposed = false;
  // Preserve admission ordering while the optional supervisor chunk is still loading.
  private admission: Promise<void> = Promise.resolve();
  constructor(private readonly options: WorkerProcessBrokerOptions) {}
  adoptRoot(transport: WorkerProcessTransport): void {
    const state = workerProcessState(transport);
    if (state.parentPid !== 0) throw new TypeError("root process has a parent");
    const existing = this.transports.get(state.pid);
    if (existing && workerProcessDirectoryId(existing) !== workerProcessDirectoryId(transport)) throw new TypeError("process identity is already registered");
    this.transports.set(state.pid, transport);
  }
  get(pid: number): WorkerProcessTransport | undefined { return this.transports.get(pid); }
  private codec(transport: WorkerProcessTransport): WorkerDescriptorCodec {
    return typeof this.options.codec === "function" ? this.options.codec(transport) : this.options.codec;
  }
  private ready(): Promise<ProcessSupervisor> {
    return this.activation ??= this.options.supervisor().then(supervisor => {
      this.supervisor = supervisor;
      if (!this.disposed) this.stopListening = supervisor.onChildExit(event => {
        const transport = this.transports.get(event.pid);
        // Supervisor emits only after revocation hooks and descriptor release. Shared outcome
        // selection by a guest is earlier and must not make wait/poll report completion yet.
        if (transport) { Atomics.store(workerProcessState(transport).confirmed, 0, 1); wakeWorkerProcess(transport); }
      });
      return supervisor;
    });
  }
  handle(message: WorkerProcessMessage, senderPid?: number): Promise<void> {
    const state = workerProcessState(message.transport);
    if (senderPid !== undefined && (message.operation === "spawn" ? state.parentPid : state.pid) !== senderPid) return Promise.reject(new ProcessError(ProcessErrno.SRCH, "process message has the wrong sender"));
    if (message.operation === "spawn") {
      const pending = this.admission.then(() => this.spawn(message.transport, message.request));
      this.admission = pending.catch(error => { this.report(error); });
      return pending;
    }
    if (message.operation === "pipe") {
      if (!this.disposed) this.options.onPipe?.(message.handle, message.transport);
      return Promise.resolve();
    }
    // The signal and immutable outcome were published synchronously in the directory. Never
    // request the signal again: a guest may have already consumed a handled delivery.
    return this.admission.then(async () => { if (!this.disposed) { await this.ready(); this.pump(); } });
  }
  private async spawn(transport: WorkerProcessTransport, request: import("./types").SpawnRequest): Promise<void> {
    const state = workerProcessState(transport);
    // A repeated message owns no new references. Reject without discarding the retained
    // lifetimes already held by the first accepted process.
    if (this.transports.has(state.pid)) throw new ProcessError(ProcessErrno.INVAL, "process identity is already registered");
    const codec = this.codec(transport);
    let admitted = false;
    try {
      if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed");
      const parentTransport = this.transports.get(state.parentPid);
      if (!parentTransport || workerProcessDirectoryId(parentTransport) !== workerProcessDirectoryId(transport)) throw new ProcessError(ProcessErrno.SRCH, "unknown process parent");
      const supervisor = await this.ready();
      if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed");
      const parent = supervisor.get(state.parentPid);
      if (!parent) throw new ProcessError(ProcessErrno.SRCH, "process parent has been reaped");
      const imported = new DescriptorTable();
      const staging: number[] = [];
      try {
        installWorkerBindings(transport, imported, codec);
        // Staging numbers belong only to the page's copy of the parent's table. They cannot
        // collide with, replace, or depend on the worker's independently changing fd numbers.
        const bindings = transport.bindings.map(binding => {
          const source = imported.get(binding.fd)!;
          const fd = parent.descriptors.add(source.description, source);
          staging.push(fd);
          return { child: binding.fd, parent: fd };
        });
        this.transports.set(state.pid, transport);
        supervisor.reserveAdmittedSpawn(state.parentPid, { ...request, fds: bindings }, {
          pid: state.pid, job: state.job, ...state.signals,
        });
        admitted = true;
      } finally {
        for (const fd of staging) parent.descriptors.close(fd);
        imported.dispose();
      }
      // A kill may have won before lazy admission, including after the sender already exited.
      // start() adopts the shared decision and never launches an already-dead worker.
      void supervisor.start(state.pid).catch(error => this.report(error));
      this.pump();
    } catch (error) {
      if (!admitted) {
        this.transports.delete(state.pid);
        claimOutcome(state.signals.outcome, { kind: "exited", code: 126 });
        for (const token of transport.resources) {
          try { codec.discard(token); } catch (cleanupError) { this.report(cleanupError); }
        }
        Atomics.store(state.confirmed, 0, 1);
        wakeWorkerProcess(transport);
      }
      throw error;
    }
  }
  /** Deterministic host pump, also useful when the embedding owns a single relay loop. */
  pump(): void {
    this.options.pumpPipes?.();
    const supervisor = this.supervisor;
    if (!supervisor) return;
    for (const [pid, transport] of this.transports) {
      const record = supervisor.get(pid);
      if (!record || record.result) continue;
      const state = workerProcessState(transport);
      const outcome = readOutcome(state.signals.outcome);
      if (outcome?.kind === "signaled") supervisor.defaultSignal(pid, outcome.code);
      else if (outcome) supervisor.exit(pid, outcome.code);
      else {
        const signal = Atomics.load(state.signals.requestedSignal, 0);
        if (signal) supervisor.observeSignal(pid, signal);
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const transport of this.transports.values()) requestSignal(workerProcessState(transport).signals, 9);
    this.pump();
    for (const transport of this.transports.values()) {
      if (transport.resources.length === 0) { wakeWorkerProcess(transport); continue; }
      const codec = this.codec(transport);
      for (const token of transport.resources) {
        try { codec.discard(token); } catch (error) { this.report(error); }
      }
      wakeWorkerProcess(transport);
    }
    this.transports.clear();
    this.stopListening?.(); this.stopListening = undefined;
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Diagnostics never own cleanup. */ } }
}
