import { checkedSignalNumber, createSignalState, requestSignal } from "./signals";
import { DescriptorTable, MAX_DESCRIPTOR, OpenDescription, type Descriptor } from "../core/descriptors";
import { ExecutableNotFound, ExecutableRegistry } from "./registry";
import { ProcessTable, type ProcessJob, type ProcessRecord } from "./table";
import { claimOutcome, outcomeWord, readOutcome } from "./outcome";
import { ProcessErrno, ProcessError, Signal, checkedSignal, type ChildExitEvent, type ProcessContext, type ProcessExit, type ProcessHandle, type SpawnRequest, type SpawnReservation, type SharedJobIdentity } from "./types";

export interface SupervisorOptions {
  registry: ExecutableRegistry;
  launch(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  table?: ProcessTable;
  /** Message-bearing hosts defer ordinary completion until ordered output/exit messages drain.
   * Fatal outcomes and explicit disposal never wait for this acknowledgement.
   */
  canConfirmExit?(pid: number): boolean;
  /** Legacy hosts without job waits can release outcomes after their last individual reap. */
  retainJobResults?: boolean;
  /** Fence admitted filesystem and adapter work after revocation. Every exit confirmation
   * waits for this hook, but never for physical worker termination.
   */
  quiesce?(pid: number): void | Promise<void>;
  /** Cleanup failures are diagnostics, never a reason to leave peers blocked or skip teardown. */
  onError?(error: unknown): void;
}
export interface RootProcessOptions extends SpawnReservation {
  descriptors?: DescriptorTable;
  foreground?: boolean;
}
function signalWord(source?: Int32Array | SharedArrayBuffer): Int32Array {
  const word = source instanceof Int32Array ? source : new Int32Array(source ?? new SharedArrayBuffer(4));
  if (!(word.buffer instanceof SharedArrayBuffer) || word.length !== 1) throw new TypeError("signal word must be one shared int32");
  return word;
}
function validFd(fd: number): boolean { return Number.isInteger(fd) && fd >= 0 && fd <= MAX_DESCRIPTOR; }
function snapshot(spec: SpawnRequest): Readonly<SpawnRequest> {
  // Own all mutable request data before returning to the guest's synchronous spawn call.
  return {
    executable: spec.executable, argv: spec.argv.slice(), env: { ...spec.env }, cwd: spec.cwd,
    job: spec.job, fds: spec.fds.map(binding => ({ ...binding })),
  };
}

/** Responsive control plane. launch must hand execution to a worker, never run a guest inline. */
export class ProcessSupervisor {
  readonly table: ProcessTable;
  private readonly options: SupervisorOptions;
  private readonly listeners = new Set<(event: ChildExitEvent) => void>();
  private readonly jobReadiness = new Set<(job: number) => boolean>();
  private readonly jobReapListeners = new Set<(job: number) => void>();
  private readonly jobReapClaims = new Set<(job: number) => boolean>();
  private readonly quiescentListeners = new Set<(event: ChildExitEvent) => void>();
  private readonly jobListeners = new Map<number, Set<() => void>>();
  private disposed = false;
  private readonly finishing = new Set<number>();
  constructor(options: SupervisorOptions) { this.options = options; this.table = options.table ?? new ProcessTable(); }
  get(pid: number): ProcessRecord | undefined { return this.table.get(pid); }
  job(id: number) { return this.table.job(id); }
  jobOf(pid: number): number { return this.table.require(pid).job; }
  /** Guest adapters may signal themselves and descendants, never a sibling or ancestor. */
  canSignal(callerPid: number, pid: number): boolean {
    this.table.require(callerPid);
    this.table.require(pid);
    let target: number | undefined = pid;
    while (target !== undefined && target !== 0) {
      if (target === callerPid) return true;
      target = this.table.parentOf(target);
    }
    return false;
  }
  canSignalJob(callerPid: number, jobId: number): boolean {
    this.table.require(callerPid);
    const job = this.table.job(jobId);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${jobId}`);
    return job.ownerPid === callerPid;
  }
  /** A job is controlled by its owner and every live or retained ancestor of that owner. */
  canWaitJob(callerPid: number, jobId: number): boolean {
    // A synchronously accepted worker reap can reach the page after its caller was reaped
    // by an ancestor. Retained identities still authenticate that queued owner-chain action.
    if (this.table.parentOf(callerPid) === undefined) throw new ProcessError(ProcessErrno.SRCH, `unknown process ${callerPid}`);
    const job = this.table.job(jobId);
    if (!job) throw new ProcessError(this.table.wasJob(jobId) ? ProcessErrno.CHILD : ProcessErrno.SRCH, `unknown or reaped job ${jobId}`);
    const seen = new Set<number>();
    let owner: number | undefined = job.ownerPid;
    while (owner !== undefined && owner !== 0 && !seen.has(owner)) {
      if (owner === callerPid) return true;
      seen.add(owner);
      owner = this.table.parentOf(owner);
    }
    return false;
  }
  private requireWaitJob(callerPid: number, jobId: number) {
    const job = this.table.job(jobId);
    if (!job) throw new ProcessError(this.table.wasJob(jobId) ? ProcessErrno.CHILD : ProcessErrno.SRCH, `unknown or reaped job ${jobId}`);
    if (!this.canWaitJob(callerPid, jobId)) throw new ProcessError(63, `job ${jobId} is outside the caller's owner chain`);
    return job;
  }
  private jobIsEmpty(job: ProcessJob, internal = false): boolean {
    try {
      if (!Array.from(this.jobReadiness).every(check => check(job.id)) || job.pendingMembers !== 0) return false;
      return this.table.confirmJobOutcome(job.id) !== null;
    } catch (error) {
      // A blocked worker can claim the shared job immediately after safe publication.
      // Public waiters see CHILD; internal wake/cleanup bookkeeping must not fail for it.
      if (internal && error instanceof ProcessError && error.errno === ProcessErrno.CHILD) return false;
      throw error;
    }
  }
  /** Controller adapters include accepted reservations not yet admitted to the local table. */
  registerJobReadiness(check: (job: number) => boolean): () => void {
    this.jobReadiness.add(check);
    return () => { this.jobReadiness.delete(check); };
  }
  /** A shared controller atomically claims consumption before any local records are removed. */
  registerJobReapClaim(claim: (job: number) => boolean): () => void {
    this.jobReapClaims.add(claim);
    return () => { this.jobReapClaims.delete(claim); };
  }
  onJobReap(listener: (job: number) => void): () => void {
    this.jobReapListeners.add(listener);
    return () => { this.jobReapListeners.delete(listener); };
  }
  private forgetUnusedJob(jobId: number): void {
    const job = this.table.job(jobId);
    if (this.options.retainJobResults === false && job?.members.size === 0 && this.jobIsEmpty(job, true)) this.table.removeJob(jobId);
  }
  jobEmpty(callerPid: number, jobId: number): boolean {
    const job = this.requireWaitJob(callerPid, jobId);
    return this.jobIsEmpty(job);
  }
  registerJobWake(callerPid: number, jobId: number, wake: Int32Array): () => void {
    if (!(wake.buffer instanceof SharedArrayBuffer) || wake.length !== 1) throw new TypeError("job wake must be one shared int32");
    this.requireWaitJob(callerPid, jobId);
    let listeners = this.jobListeners.get(jobId);
    if (!listeners) this.jobListeners.set(jobId, listeners = new Set());
    const listener = () => { Atomics.add(wake, 0, 1); Atomics.notify(wake, 0); };
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.jobListeners.delete(jobId);
    };
  }
  createRoot(options: RootProcessOptions = {}): number {
    if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "supervisor is disposed");
    const pid = options.pid ?? this.table.identities.pid();
    this.table.checkPid(pid);
    const interrupt = signalWord(options.interrupt), requestedSignal = signalWord(options.requestedSignal), outcome = outcomeWord(options.outcome), signalState = createSignalState(options.signalState);
    // Explicit root ids may share an existing job, as with an externally reserved guest root.
    const job = options.job !== undefined && this.table.job(options.job)
      ? this.table.job(options.job)!
      : this.table.createJob(pid, options.foreground ?? true, options.job);
    this.table.insert({
      pid, parentPid: 0, job: job.id, descriptors: options.descriptors ?? new DescriptorTable(),
      interrupt, requestedSignal, signalState, outcome, request: null, state: "running", result: null, jobSafe: false, signal: 0, revoked: false,
      revocations: new Set(), waiters: new Set(),
    });
    return pid;
  }
  reserveSpawn(parentPid: number, spec: SpawnRequest, reservation: SpawnReservation = {}): number {
    return this.reserveProcess(parentPid, spec, reservation, false);
  }
  /** Controller-only adoption of a spawn accepted before lazy supervisor activation.
   * Admission and descriptor retention must already have happened while the parent was live.
   * Shared state is adopted unchanged; a preclaimed child outcome still prevents launch.
   */
  reserveAdmittedSpawn(parentPid: number, spec: SpawnRequest, reservation: SpawnReservation = {}, retainedDescriptors?: DescriptorTable, jobIdentity?: SharedJobIdentity): number {
    return this.reserveProcess(parentPid, spec, reservation, true, retainedDescriptors, jobIdentity);
  }
  private reserveProcess(parentPid: number, spec: SpawnRequest, reservation: SpawnReservation, admitted: boolean, retainedDescriptors?: DescriptorTable, jobIdentity?: SharedJobIdentity): number {
    if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "supervisor is disposed");
    const parent = this.table.get(parentPid);
    // A separately selected job can be admitted after an ancestor reaped its exited parent.
    // Its worker already retained the capabilities and ancestry before that reap.
    if (!parent && (!admitted || !retainedDescriptors || this.table.parentOf(parentPid) === undefined)) throw new ProcessError(ProcessErrno.SRCH, `unknown process ${parentPid}`);
    if (!admitted && (parent!.result || parent!.signal === Signal.SIGKILL || readOutcome(parent!.outcome))) throw new ProcessError(ProcessErrno.SRCH, "parent process has exited or is being killed");
    const parentDescriptors = retainedDescriptors ?? parent!.descriptors;
    if (!Number.isInteger(spec.job) || spec.job < -1) throw new ProcessError(ProcessErrno.INVAL, "invalid job selection");
    const bindings = new Set<number>();
    for (const binding of spec.fds) {
      if (!validFd(binding.child) || !validFd(binding.parent) || bindings.has(binding.child)) {
        throw new ProcessError(ProcessErrno.INVAL, "invalid or duplicate descriptor binding");
      }
      if (!parentDescriptors.get(binding.parent)) throw new ProcessError(ProcessErrno.BADF, `missing parent descriptor ${binding.parent}`);
      bindings.add(binding.child);
    }
    const interrupt = signalWord(reservation.interrupt), requestedSignal = signalWord(reservation.requestedSignal), outcome = outcomeWord(reservation.outcome), signalState = createSignalState(reservation.signalState);
    const request = snapshot(spec);
    const pid = reservation.pid ?? this.table.identities.pid();
    this.table.checkPid(pid);
    let job = reservation.job ?? (spec.job > 0 ? spec.job : undefined);
    let createdJob = false;
    if (job !== undefined && !this.table.job(job)) {
      if (reservation.job === undefined) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${job}`);
      this.table.createJob(jobIdentity?.ownerPid ?? parentPid, jobIdentity?.foreground ?? spec.job === 0, job, jobIdentity);
      createdJob = true;
    }
    if (job === undefined) { job = this.table.createJob(parentPid, spec.job === 0).id; createdJob = true; }
    if (jobIdentity) this.table.adoptJobIdentity(job, jobIdentity);
    const descriptors = new DescriptorTable();
    const inherited = new Map<OpenDescription, Descriptor>();
    const revocations = new Set<() => void>();
    try {
      for (const binding of request.fds) {
        const source = parentDescriptors.get(binding.parent)!;
        let target = inherited.get(source.description);
        if (!target) {
          const resource = source.resource;
          if ((resource.kind === "pipe" || resource.kind === "terminal") && resource.forProcess) {
            const owned = resource.forProcess(pid);
            target = owned === resource ? source : { ...source, resource: owned, description: new OpenDescription(owned, () => owned.close?.()) };
            if (owned.revoke) revocations.add(() => owned.revoke!());
          } else target = source;
          inherited.set(source.description, target);
        }
        descriptors.inherit(binding.child, { ...target, rightsBase: source.rightsBase, rightsInheriting: source.rightsInheriting });
      }
      this.table.insert({
        pid, parentPid, job, descriptors,
        interrupt, requestedSignal, signalState, outcome, request, state: "reserved", result: null, jobSafe: false, signal: 0, revoked: false,
        revocations, waiters: new Set(),
      }, admitted);
    } catch (error) {
      this.disposeDescriptors(descriptors);
      if (createdJob) this.table.removeEmptyJob(job);
      throw error;
    }
    return pid;
  }
  spawn(parentPid: number, spec: SpawnRequest, reservation?: SpawnReservation): number {
    const pid = this.reserveSpawn(parentPid, spec, reservation);
    queueMicrotask(() => { void this.start(pid); });
    return pid;
  }
  /** Idempotent: direct spawn and the asynchronous activation stub may both request start. */
  start(pid: number): Promise<void> {
    const record = this.table.get(pid);
    if (!record || record.request === null) return Promise.resolve();
    if (record.starting) return record.starting;
    if (record.result || record.revoked) return Promise.resolve();
    const settled = readOutcome(record.outcome);
    if (settled) { this.finish(pid, settled); return Promise.resolve(); }
    record.state = "starting";
    record.starting = this.launch(record);
    return record.starting;
  }
  private async launch(record: ProcessRecord): Promise<void> {
    try {
      const executable = await this.options.registry.resolve(record.request!.executable);
      if (record.result || record.revoked) return;
      const settled = readOutcome(record.outcome);
      if (settled) { this.finish(record.pid, settled); return; }
      const context: ProcessContext = {
        pid: record.pid, parentPid: record.parentPid, job: record.job, request: record.request!,
        module: executable.module, adapter: executable.adapter,
        descriptors: record.descriptors, interrupt: record.interrupt, requestedSignal: record.requestedSignal, signalState: record.signalState, outcome: record.outcome,
        exit: code => this.exit(record.pid, code), fail: error => this.failStart(record.pid, error),
        defaultSignal: signal => this.defaultSignal(record.pid, signal),
        registerRevocation: hook => this.registerRevocation(record.pid, hook),
      };
      const handle = await this.options.launch(context);
      if (record.result || record.revoked) this.terminate(handle);
      else { record.handle = handle; record.state = "running"; }
    } catch (error) { this.failStart(record.pid, error); }
  }
  failStart(pid: number, error: unknown): void {
    this.finish(pid, { kind: "exited", code: error instanceof ExecutableNotFound ? 127 : 126 });
  }
  exit(pid: number, code: number): void {
    if (!Number.isInteger(code)) throw new ProcessError(ProcessErrno.INVAL, "exit code must be an integer");
    this.finish(pid, { kind: "exited", code });
  }
  /** Default signals terminate immediately; registered handlers receive shared pending delivery. */
  kill(pid: number, signal: number): void {
    const sig = checkedSignal(signal), record = this.table.require(pid);
    if (record.result) return;
    this.recordSignal(record, sig);
    if (record.signal === Signal.SIGKILL || readOutcome(record.outcome)) this.finish(pid, { kind: "signaled", code: Signal.SIGKILL });
  }
  /** Observe a request already published by a synchronous guest stub. Never redeliver a
   * catchable interrupt the guest may have consumed before this host notification arrived.
   */
  observeSignal(pid: number, signal: number): void {
    const sig = checkedSignalNumber(signal), record = this.table.require(pid);
    if (record.result) return;
    if (Atomics.load(record.requestedSignal, 0) === Signal.SIGKILL) this.recordSignal(record, Signal.SIGKILL);
    else if (record.signal !== Signal.SIGKILL) record.signal = sig;
    if (record.signal === Signal.SIGKILL || readOutcome(record.outcome)) this.finish(pid, { kind: "signaled", code: Signal.SIGKILL });
  }
  private recordSignal(record: ProcessRecord, signal: number): void {
    if (record.result) return;
    const delivery = requestSignal(record, signal);
    if (delivery.action !== "ignore" && delivery.action !== "settled") {
      record.signal = Atomics.load(record.requestedSignal, 0);
    }
    if (delivery.outcome?.kind === "signaled" && delivery.outcome.code === Signal.SIGKILL) record.signal = Signal.SIGKILL;
  }
  private publishKill(record: ProcessRecord): void {
    record.signal = Signal.SIGKILL;
    requestSignal(record, Signal.SIGKILL);
  }
  /** Explicit guest default action. A random trap after a handled signal is not a signal exit. */
  defaultSignal(pid: number, signal?: number): void {
    const record = this.table.get(pid);
    if (!record || record.result) return;
    const settled = readOutcome(record.outcome);
    if (settled) { this.finish(pid, settled); return; }
    const sig = checkedSignalNumber(signal ?? (record.signal || Atomics.load(record.requestedSignal, 0)));
    const winner = claimOutcome(record.outcome, { kind: "signaled", code: Atomics.load(record.requestedSignal, 0) === Signal.SIGKILL ? Signal.SIGKILL : sig });
    this.finish(pid, winner);
  }
  killJob(jobId: number, signal: number): void {
    const sig = checkedSignal(signal);
    const job = this.table.job(jobId);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${jobId}`);
    // New background jobs are independent, even when their parent belongs to this job.
    const targets = Array.from(job.members, pid => this.table.require(pid));
    // Record every target before callbacks: a dying process cannot spawn through an as-yet
    // unmarked sibling, or replace that sibling's SIGKILL with a handled exit.
    for (const record of targets) this.recordSignal(record, sig);
    for (const record of targets) {
      if ((record.signal === Signal.SIGKILL || readOutcome(record.outcome)) && this.table.get(record.pid) === record) {
        this.finish(record.pid, { kind: "signaled", code: Signal.SIGKILL });
      }
    }
  }
  wait(parentPid: number, pid: number): ProcessExit | null { return this.child(parentPid, pid).result; }
  /** Returns and reaps a completed job, retaining the leader's typed outcome even if it was reaped separately. */
  waitJob(parentPid: number, jobId: number): ProcessExit | null {
    const job = this.requireWaitJob(parentPid, jobId);
    if (!this.jobIsEmpty(job)) return null;
    return this.reapJob(parentPid, jobId);
  }
  reapJob(parentPid: number, jobId: number): ProcessExit {
    const job = this.requireWaitJob(parentPid, jobId);
    if (!this.jobIsEmpty(job)) throw new ProcessError(ProcessErrno.AGAIN, "job has not become empty");
    const result = job.leaderResult;
    if (!result) throw new ProcessError(ProcessErrno.CHILD, "job leader has no final outcome");
    for (const claim of this.jobReapClaims) {
      if (!claim(jobId)) throw new ProcessError(ProcessErrno.CHILD, "job was already reaped by another observer");
    }
    for (const pid of Array.from(job.members)) this.table.remove(pid);
    this.table.removeJob(jobId);
    for (const listener of Array.from(this.jobReapListeners)) this.safely(() => listener(jobId));
    this.jobListeners.delete(jobId);
    return result;
  }
  waitForExit(parentPid: number, pid: number): Promise<ProcessExit> {
    const record = this.child(parentPid, pid);
    if (record.result) return Promise.resolve(record.result);
    return new Promise(resolve => record.waiters.add(resolve));
  }
  reap(parentPid: number, pid: number): ProcessExit {
    const record = this.child(parentPid, pid);
    if (!record.result) throw new ProcessError(ProcessErrno.AGAIN, "child has not exited");
    this.table.remove(pid);
    this.forgetUnusedJob(record.job);
    return record.result;
  }
  private child(parentPid: number, pid: number): ProcessRecord {
    const record = this.table.get(pid);
    if (!record || record.parentPid !== parentPid) throw new ProcessError(ProcessErrno.CHILD, `process ${pid} is not a child of ${parentPid}`);
    return record;
  }
  onChildExit(listener: (event: ChildExitEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onProcessQuiescent(listener: (event: ChildExitEvent) => void): () => void {
    this.quiescentListeners.add(listener);
    return () => { this.quiescentListeners.delete(listener); };
  }
  registerRevocation(pid: number, hook: () => void): () => void {
    const record = this.table.get(pid);
    if (!record || record.revoked) this.safely(hook);
    else record.revocations.add(hook);
    return () => { record?.revocations.delete(hook); };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const records = Array.from(this.table.values());
    for (const record of records) this.recordSignal(record, Signal.SIGKILL);
    for (const record of records) {
      if (this.table.get(record.pid) === record) {
        this.finish(record.pid, { kind: "signaled", code: Signal.SIGKILL });
        this.table.remove(record.pid);
        this.table.removeJob(record.job);
      }
    }
    this.table.clearJobs();
    this.listeners.clear();
    this.jobReadiness.clear();
    this.jobReapListeners.clear();
    this.jobReapClaims.clear();
    this.quiescentListeners.clear();
    this.jobListeners.clear();
  }
  private finish(pid: number, result: Omit<ProcessExit, "status">): void {
    const record = this.table.get(pid);
    if (!record || record.result || this.finishing.has(pid)) return;
    this.finishing.add(pid);
    // A synchronous guest-side kill publishes its word before the asynchronous broker message.
    if (Atomics.load(record.requestedSignal, 0) === Signal.SIGKILL) this.recordSignal(record, Signal.SIGKILL);
    if (record.signal === Signal.SIGKILL) result = { kind: "signaled", code: Signal.SIGKILL };
    // Parent kill, worker completion and page failure all choose the same immutable outcome.
    // A signal published after our last read still competes at this atomic decision, rather
    // than overriding one observer's already-final result after the fact.
    const winner = claimOutcome(record.outcome, result);
    // Check the immutable winner, not an earlier read: a worker may ordinary-exit while a
    // signal observer is entering this function. Its queued output must still drain first.
    if (winner.kind === "exited" && !this.disposed) {
      let canConfirm: boolean;
      try { canConfirm = this.options.canConfirmExit?.(pid) !== false; }
      catch (error) { this.finishing.delete(pid); throw error; }
      if (!canConfirm) {
        this.finishing.delete(pid);
        return;
      }
    }
    if (winner.kind === "signaled" && winner.code === Signal.SIGKILL) this.publishKill(record);
    record.revoked = true;
    const hooks = Array.from(record.revocations);
    record.revocations.clear();
    for (const hook of hooks) this.safely(hook);
    this.disposeDescriptors(record.descriptors);
    // Invoke the fence while broker child/identity records are still present. Every observer
    // must wait for admitted filesystem and adapter work (for example a terminal section),
    // independently of the physical worker's potentially delayed termination.
    let quiescence: void | Promise<void> = undefined;
    let fenceFailed = false;
    try { quiescence = this.options.quiesce?.(pid); }
    catch (error) { fenceFailed = true; this.report(error); }
    const safe = () => {
      record.result = winner;
      record.state = "exited";
      this.table.recordOutcome(record);
      this.finishing.delete(pid);
      this.table.markJobSafe(record);
      for (const resolve of record.waiters) resolve(winner);
      record.waiters.clear();
      const event = Object.freeze({ pid, parentPid: record.parentPid, job: record.job, result: winner });
      for (const listener of Array.from(this.listeners)) this.safely(() => listener(event));
      for (const listener of Array.from(this.quiescentListeners)) this.safely(() => listener(event));
      const job = this.table.job(record.job);
      this.forgetUnusedJob(record.job);
      if (job && this.jobIsEmpty(job, true)) {
        const listeners = this.jobListeners.get(record.job);
        if (listeners) for (const listener of Array.from(listeners)) this.safely(listener);
      }
    };
    if (!fenceFailed) {
      if (quiescence) void quiescence.then(safe, error => this.report(error));
      else safe();
    }
    if (record.handle) { const handle = record.handle; record.handle = undefined; this.terminate(handle); }
  }
  private disposeDescriptors(descriptors: DescriptorTable): void {
    // close removes its entry before invoking a release callback; retrying drains any remaining
    // entries even when one resource's cleanup throws. Do not change the core descriptor API.
    for (;;) {
      try { descriptors.dispose(); return; }
      catch (error) { this.report(error); }
    }
  }
  private terminate(handle: ProcessHandle): void {
    try {
      const pending = handle.terminate();
      if (pending) void pending.catch(error => this.report(error));
    } catch (error) { this.report(error); }
  }
  private safely(operation: () => void): void { try { operation(); } catch (error) { this.report(error); } }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* diagnostics must not break teardown */ } }
}
