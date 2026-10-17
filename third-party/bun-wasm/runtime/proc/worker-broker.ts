import { DescriptorTable, type Resource } from "../core/descriptors";
import { claimOutcome, readOutcome } from "./outcome";
import { requestSignal } from "./signals";
import type { ProcessSupervisor } from "./supervisor";
import { ProcessErrno, ProcessError } from "./types";
import { confirmWorkerProcessJob, installWorkerBindings, wakeWorkerProcess, workerProcessDirectoryId, workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "./worker-client";

export interface WorkerProcessBrokerOptions {
  /** Reuse the host's supervisor and executable registry, including its legacy Bun children. */
  supervisor(): Promise<ProcessSupervisor>;
  codec: WorkerDescriptorCodec | ((transport: WorkerProcessTransport) => WorkerDescriptorCodec);
  /** Optional pipe layer hooks; the ownership transport has no dependency on pipe primitives. */
  onPipe?(handle: unknown, transport: WorkerProcessTransport): void;
  pumpPipes?(): void;
  /** Fence host work for an identity whose spawn failed before supervisor admission. */
  quiesce?(pid: number, transport: WorkerProcessTransport): void | Promise<void>;
  onError?(error: unknown): void;
}

/** Page-side admission over an existing supervisor. The worker has already retained every
 * transferred resource before its spawn message is queued. No request waits for page reply.
 */
export class WorkerProcessBroker {
  private readonly transports = new Map<number, WorkerProcessTransport>();
  /** Authenticate delayed messages without retaining reaped descriptor/adapter payloads. */
  private readonly identities = new Map<number, WorkerProcessTransport>();
  private readonly failedCleanup = new Set<number>();
  private acknowledgingJob?: number;
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
    const existing = this.getIdentity(state.pid);
    if (existing && workerProcessDirectoryId(existing) !== workerProcessDirectoryId(transport)) throw new TypeError("process identity is already registered");
    this.transports.set(state.pid, transport);
  }
  get(pid: number): WorkerProcessTransport | undefined { return this.transports.get(pid); }
  getIdentity(pid: number): WorkerProcessTransport | undefined { return this.transports.get(pid) ?? this.identities.get(pid); }
  private retainIdentity(pid: number, transport: WorkerProcessTransport): void {
    this.identities.set(pid, { directory: transport.directory, identity: transport.identity, slot: transport.slot, bindings: [], resources: [] });
  }
  private jobTransport(job: number): WorkerProcessTransport | undefined {
    for (const transport of this.transports.values()) if (workerProcessState(transport).job === job) return transport;
    for (const transport of this.identities.values()) if (workerProcessState(transport).job === job) return transport;
    return undefined;
  }
  private reapTransports(job: number): void {
    const leader = this.jobTransport(job);
    if (leader) { Atomics.compareExchange(workerProcessState(leader).jobPending, 0, 0, -1); wakeWorkerProcess(leader); }
    for (const [pid, transport] of this.transports) {
      if (workerProcessState(transport).job === job) { this.retainIdentity(pid, transport); this.transports.delete(pid); }
    }
  }
  private codec(transport: WorkerProcessTransport): WorkerDescriptorCodec {
    return typeof this.options.codec === "function" ? this.options.codec(transport) : this.options.codec;
  }
  private ready(): Promise<ProcessSupervisor> {
    return this.activation ??= this.options.supervisor().then(supervisor => {
      this.supervisor = supervisor;
      if (!this.disposed) {
        const stopExit = supervisor.onChildExit(event => {
          if (this.disposed) return;
          const transport = this.transports.get(event.pid);
          // The supervisor publishes exit only after revocation, descriptor cleanup and
          // its asynchronous host-work fence; process and job waits share that boundary.
          if (transport && !this.failedCleanup.has(event.pid)) { Atomics.store(workerProcessState(transport).confirmed, 0, 1); wakeWorkerProcess(transport); }
        });
        const stopQuiescent = supervisor.onProcessQuiescent(event => {
          if (this.disposed) return;
          const transport = this.transports.get(event.pid);
          if (transport && !this.failedCleanup.has(event.pid)) confirmWorkerProcessJob(transport);
        });
        const stopReadiness = supervisor.registerJobReadiness(job => {
          const transport = this.jobTransport(job);
          if (!transport) return true;
          const pending = Atomics.load(workerProcessState(transport).jobPending, 0);
          if (pending === -1 && this.acknowledgingJob !== job) throw new ProcessError(ProcessErrno.CHILD, "job was already reaped by another observer");
          return pending === 0 || (pending === -1 && this.acknowledgingJob === job);
        });
        const stopClaim = supervisor.registerJobReapClaim(job => {
          const transport = this.jobTransport(job);
          if (!transport) return true;
          const pending = workerProcessState(transport).jobPending;
          // Only the worker's acknowledgment may consume an already-claimed job. A
          // normal host consumer must win the same CAS as every blocked guest worker.
          return this.acknowledgingJob === job ? Atomics.load(pending, 0) === -1 : Atomics.compareExchange(pending, 0, 0, -1) === 0;
        });
        const stopReap = supervisor.onJobReap(job => this.reapTransports(job));
        this.stopListening = () => { stopExit(); stopQuiescent(); stopReadiness(); stopClaim(); stopReap(); };
      }
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
    return this.admission.then(async () => {
      if (this.disposed) return;
      const supervisor = await this.ready();
      this.pump();
      if (message.operation === "reap-job") {
        const previous = this.acknowledgingJob;
        this.acknowledgingJob = message.job;
        try {
          if (!supervisor.waitJob(state.pid, message.job)) return;
        } catch (error) {
          // A wholly rejected transfer has only a shared directory record. A host-side
          // consumer may also have reaped first; neither notice should recreate a job.
          if (!(error instanceof ProcessError) || (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)) throw error;
        } finally { this.acknowledgingJob = previous; }
        this.reapTransports(message.job);
      }
    });
  }
  private async spawn(transport: WorkerProcessTransport, request: import("./types").SpawnRequest): Promise<void> {
    const state = workerProcessState(transport);
    // A repeated message owns no new references. Reject without discarding the retained
    // lifetimes already held by the first accepted process.
    if (this.getIdentity(state.pid)) throw new ProcessError(ProcessErrno.INVAL, "process identity is already registered");
    const codec = this.codec(transport);
    let admitted = false;
    try {
      if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed");
      const parentTransport = this.getIdentity(state.parentPid);
      if (!parentTransport || workerProcessDirectoryId(parentTransport) !== workerProcessDirectoryId(transport)) throw new ProcessError(ProcessErrno.SRCH, "unknown process parent");
      const supervisor = await this.ready();
      if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "process broker is disposed");
      // Reserve the authoritative leader/owner before a codec can fail. Transferred
      // endpoints belong to this child, not the parent's mutable or already-reaped table.
      this.transports.set(state.pid, transport);
      supervisor.reserveAdmittedSpawn(state.parentPid, { ...request, fds: [] }, {
        pid: state.pid, job: state.job, ...state.signals,
      }, new DescriptorTable(), { ownerPid: state.jobOwner, leaderPid: state.jobLeaderPid, outcome: state.jobOutcome, foreground: state.jobForeground });
      admitted = true;
      const descriptors = supervisor.get(state.pid)!.descriptors;
      installWorkerBindings(transport, descriptors, codec);
      const resources = new Set<Resource>();
      for (const binding of transport.bindings) {
        const resource = descriptors.get(binding.fd)!.resource;
        if (resources.has(resource)) continue;
        resources.add(resource);
        if ((resource.kind === "pipe" || resource.kind === "terminal") && resource.revoke) supervisor.registerRevocation(state.pid, () => resource.revoke!());
      }
      // A kill may have won before lazy admission, including after the sender already exited.
      // start() adopts the shared decision and never launches an already-dead worker.
      void supervisor.start(state.pid).catch(error => this.report(error));
      this.pump();
    } catch (error) {
      if (admitted) {
        // Imported descriptions release through the supervisor; discard also releases
        // tokens that failed before import, using the codec's idempotent lifetime.
        for (const token of transport.resources) {
          try { codec.discard(token); } catch (cleanupError) { this.failedCleanup.add(state.pid); this.report(cleanupError); }
        }
        this.supervisor!.failStart(state.pid, error);
      } else {
        this.transports.delete(state.pid);
        claimOutcome(state.signals.outcome, { kind: "exited", code: 126 });
        let cleaned = true;
        for (const token of transport.resources) {
          try { codec.discard(token); } catch (cleanupError) { cleaned = false; this.report(cleanupError); }
        }
        await this.options.quiesce?.(state.pid, transport);
        if (cleaned) {
          Atomics.store(state.confirmed, 0, 1);
          confirmWorkerProcessJob(transport);
        }
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
    const cleanup = new Map<number, { complete: boolean }>();
    for (const [pid, transport] of this.transports) {
      const record = this.supervisor?.get(pid);
      if (!record) continue;
      const gate = { complete: !this.failedCleanup.has(pid) };
      cleanup.set(pid, gate);
      // Exit waiters resolve at the host-work fence even if the embedding immediately
      // disposes the supervisor and clears its event listeners. Retain shared identity
      // only, never descriptor tokens, adapter payloads, or the broker itself.
      const identity: WorkerProcessTransport = { directory: transport.directory, identity: transport.identity, slot: transport.slot, bindings: [], resources: [] };
      void this.supervisor!.waitForExit(record.parentPid, pid).then(() => {
        if (!gate.complete) return;
        Atomics.store(workerProcessState(identity).confirmed, 0, 1);
        confirmWorkerProcessJob(identity);
      });
    }
    for (const transport of this.transports.values()) requestSignal(workerProcessState(transport).signals, 9);
    this.pump();
    for (const [pid, transport] of this.transports) {
      if (transport.resources.length === 0) { wakeWorkerProcess(transport); continue; }
      const codec = this.codec(transport);
      for (const token of transport.resources) {
        try { codec.discard(token); } catch (error) {
          const gate = cleanup.get(pid);
          if (gate) gate.complete = false;
          this.report(error);
        }
      }
      wakeWorkerProcess(transport);
    }
    this.transports.clear();
    this.identities.clear();
    this.failedCleanup.clear();
    this.stopListening?.(); this.stopListening = undefined;
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Diagnostics never own cleanup. */ } }
}
