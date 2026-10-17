import { checkedSignalNumber, createSignalState, requestSignal } from "./signals";
import { DescriptorTable, MAX_DESCRIPTOR, OpenDescription, type Descriptor } from "../core/descriptors";
import { ExecutableNotFound, ExecutableRegistry } from "./registry";
import { ProcessTable, type ProcessRecord } from "./table";
import { claimOutcome, outcomeWord, readOutcome } from "./outcome";
import { ProcessErrno, ProcessError, Signal, checkedSignal, type ChildExitEvent, type ProcessContext, type ProcessExit, type ProcessHandle, type SpawnRequest, type SpawnReservation } from "./types";

export interface SupervisorOptions {
  registry: ExecutableRegistry;
  launch(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  table?: ProcessTable;
  /** Message-bearing hosts defer ordinary completion until ordered output/exit messages drain.
   * Fatal outcomes and explicit disposal never wait for this acknowledgement.
   */
  canConfirmExit?(pid: number): boolean;
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
      interrupt, requestedSignal, signalState, outcome, request: null, state: "running", result: null, signal: 0, revoked: false,
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
  reserveAdmittedSpawn(parentPid: number, spec: SpawnRequest, reservation: SpawnReservation = {}): number {
    return this.reserveProcess(parentPid, spec, reservation, true);
  }
  private reserveProcess(parentPid: number, spec: SpawnRequest, reservation: SpawnReservation, admitted: boolean): number {
    if (this.disposed) throw new ProcessError(ProcessErrno.SRCH, "supervisor is disposed");
    const parent = this.table.require(parentPid);
    if (!admitted && (parent.result || parent.signal === Signal.SIGKILL || readOutcome(parent.outcome))) throw new ProcessError(ProcessErrno.SRCH, "parent process has exited or is being killed");
    if (!Number.isInteger(spec.job) || spec.job < -1) throw new ProcessError(ProcessErrno.INVAL, "invalid job selection");
    const bindings = new Set<number>();
    for (const binding of spec.fds) {
      if (!validFd(binding.child) || !validFd(binding.parent) || bindings.has(binding.child)) {
        throw new ProcessError(ProcessErrno.INVAL, "invalid or duplicate descriptor binding");
      }
      if (!parent.descriptors.get(binding.parent)) throw new ProcessError(ProcessErrno.BADF, `missing parent descriptor ${binding.parent}`);
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
      this.table.createJob(parentPid, spec.job === 0, job);
      createdJob = true;
    }
    if (job === undefined) { job = this.table.createJob(parentPid, spec.job === 0).id; createdJob = true; }
    const descriptors = new DescriptorTable();
    const inherited = new Map<OpenDescription, Descriptor>();
    const revocations = new Set<() => void>();
    try {
      for (const binding of request.fds) {
        const source = parent.descriptors.get(binding.parent)!;
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
        interrupt, requestedSignal, signalState, outcome, request, state: "reserved", result: null, signal: 0, revoked: false,
        revocations, waiters: new Set(),
      });
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
    if (record.result) return Promise.resolve();
    const settled = readOutcome(record.outcome);
    if (settled) { this.finish(pid, settled); return Promise.resolve(); }
    record.state = "starting";
    record.starting = this.launch(record);
    return record.starting;
  }
  private async launch(record: ProcessRecord): Promise<void> {
    try {
      const executable = await this.options.registry.resolve(record.request!.executable);
      if (record.result) return;
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
      if (record.result) this.terminate(handle);
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
  waitForExit(parentPid: number, pid: number): Promise<ProcessExit> {
    const record = this.child(parentPid, pid);
    if (record.result) return Promise.resolve(record.result);
    return new Promise(resolve => record.waiters.add(resolve));
  }
  reap(parentPid: number, pid: number): ProcessExit {
    const record = this.child(parentPid, pid);
    if (!record.result) throw new ProcessError(ProcessErrno.AGAIN, "child has not exited");
    this.table.remove(pid);
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
      }
    }
    this.listeners.clear();
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
    // Shared outcome selects a winner; waitability begins only after all capabilities are frozen.
    record.result = winner;
    record.state = "exited";
    this.finishing.delete(pid);
    for (const resolve of record.waiters) resolve(record.result);
    record.waiters.clear();
    const event = Object.freeze({ pid, parentPid: record.parentPid, job: record.job, result: record.result });
    for (const listener of Array.from(this.listeners)) this.safely(() => listener(event));
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
