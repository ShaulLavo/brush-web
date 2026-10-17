import { DescriptorTable } from "../core/descriptors";
import { ProcessIdentityAllocator } from "./identity";
import { outcomeWord, readOutcome } from "./outcome";
import { ProcessErrno, ProcessError, type ProcessExit, type ProcessHandle, type SpawnRequest, type SharedJobIdentity } from "./types";

export interface ProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly descriptors: DescriptorTable;
  readonly interrupt: Int32Array;
  readonly requestedSignal: Int32Array;
  readonly signalState: Int32Array;
  readonly outcome: BigInt64Array;
  readonly request: Readonly<SpawnRequest> | null;
  state: "reserved" | "starting" | "running" | "exited";
  result: ProcessExit | null;
  /** Job completion additionally waits for filesystem admission fences. */
  jobSafe: boolean;
  /** Host-owned signal record; unlike shared words, a dying guest cannot overwrite it. */
  signal: number;
  revoked: boolean;
  handle?: ProcessHandle;
  starting?: Promise<void>;
  revocations: Set<() => void>;
  waiters: Set<(result: ProcessExit) => void>;
}
export interface ProcessJob {
  readonly id: number;
  readonly ownerPid: number;
  readonly foreground: boolean;
  /** The first member is the job leader; its outcome remains available after ordinary child reap. */
  readonly leaderPid: number | undefined;
  readonly leaderResult: ProcessExit | null;
  readonly pendingMembers: number;
  /** Descendants inherit a job unless spawn explicitly creates/joins another one. */
  readonly members: ReadonlySet<number>;
}
interface MutableProcessJob extends Omit<ProcessJob, "members" | "leaderPid" | "leaderResult" | "pendingMembers"> {
  leaderPid: number | undefined;
  leaderResult: ProcessExit | null;
  pendingMembers: number;
  members: Set<number>;
  leaderOutcome: BigInt64Array | null;
}
/** Host-owned records. Neither guest workers nor their blocked WASM own this table. */
export class ProcessTable {
  readonly identities: ProcessIdentityAllocator;
  private readonly records = new Map<number, ProcessRecord>();
  private readonly jobs = new Map<number, MutableProcessJob>();
  private readonly usedPids = new Set<number>();
  /** Keep ancestry after wait/reap so a live descendant never loses its controlling ancestors. */
  private readonly parents = new Map<number, number>();
  private readonly usedJobs = new Set<number>();
  constructor(identities = new ProcessIdentityAllocator()) { this.identities = identities; }
  get(pid: number): ProcessRecord | undefined { return this.records.get(pid); }
  parentOf(pid: number): number | undefined { return this.parents.get(pid); }
  job(id: number): ProcessJob | undefined { return this.jobs.get(id); }
  /** Job ids are never reused, so callers can distinguish an already-reaped job from an unknown id. */
  wasJob(id: number): boolean { return this.usedJobs.has(id); }
  values(): IterableIterator<ProcessRecord> { return this.records.values(); }
  require(pid: number): ProcessRecord {
    const record = this.get(pid);
    if (!record) throw new ProcessError(ProcessErrno.SRCH, `unknown process ${pid}`);
    return record;
  }
  createJob(ownerPid: number, foreground: boolean, id = this.identities.job(), identity?: SharedJobIdentity): ProcessJob {
    if (this.usedJobs.has(id)) throw new ProcessError(ProcessErrno.INVAL, `job ${id} was already reserved`);
    this.identities.observeJob(id);
    const job: MutableProcessJob = { id, ownerPid, foreground, leaderPid: identity?.leaderPid, leaderResult: null, pendingMembers: 0, members: new Set(), leaderOutcome: identity ? outcomeWord(identity.outcome) : null };
    this.usedJobs.add(id);
    this.jobs.set(id, job);
    return job;
  }
  /** The directory's first member, not the first delivered spawn message, owns the outcome. */
  adoptJobIdentity(id: number, identity: SharedJobIdentity): void {
    const job = this.jobs.get(id);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${id}`);
    const outcome = outcomeWord(identity.outcome);
    const previous = job.leaderOutcome ?? (job.leaderPid === undefined ? null : this.records.get(job.leaderPid)?.outcome);
    // Structured cloning creates different SharedArrayBuffer wrappers for the same memory.
    // The authenticated directory supplies immutable pid identity; offsets must still agree.
    if (job.ownerPid !== identity.ownerPid || job.foreground !== identity.foreground ||
        (job.leaderPid !== undefined && job.leaderPid !== identity.leaderPid) ||
        (previous && (previous.byteOffset !== outcome.byteOffset || previous.buffer.byteLength !== outcome.buffer.byteLength))) {
      throw new ProcessError(ProcessErrno.INVAL, `job ${id} identity changed`);
    }
    job.leaderPid = identity.leaderPid;
    job.leaderOutcome ??= outcome;
  }
  /** Call only after every local member and shared-directory reservation is safely complete. */
  confirmJobOutcome(id: number): ProcessExit | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.leaderOutcome) job.leaderResult = readOutcome(job.leaderOutcome);
    return job.leaderResult;
  }
  /** Roll back a reservation without deleting a job that a reentrant hook populated. */
  removeEmptyJob(id: number): void {
    if (this.jobs.get(id)?.members.size === 0) this.jobs.delete(id);
  }
  checkPid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || this.usedPids.has(pid)) {
      throw new ProcessError(ProcessErrno.INVAL, `pid ${pid} is invalid or was already reserved`);
    }
  }
  insert(record: ProcessRecord, admitted = false): void {
    this.checkPid(record.pid);
    const job = this.jobs.get(record.job);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${record.job}`);
    // Worker transports reserve membership synchronously before posting admission. The host
    // may already have confirmed the previous member while that accepted spawn was queued.
    if (!admitted && job.leaderPid !== undefined && job.pendingMembers === 0) {
      throw new ProcessError(ProcessErrno.CHILD, `completed job ${job.id} cannot be joined`);
    }
    this.identities.observePid(record.pid);
    this.usedPids.add(record.pid);
    this.parents.set(record.pid, record.parentPid);
    this.records.set(record.pid, record);
    if (job.leaderPid === undefined) job.leaderPid = record.pid;
    job.members.add(record.pid);
    job.pendingMembers++;
  }
  recordOutcome(record: ProcessRecord): void {
    const job = this.jobs.get(record.job);
    if (job?.leaderPid === record.pid) job.leaderResult = record.result;
  }
  markJobSafe(record: ProcessRecord): void {
    if (record.jobSafe) return;
    record.jobSafe = true;
    const job = this.jobs.get(record.job);
    if (job) job.pendingMembers--;
  }
  clearJobs(): void { this.jobs.clear(); }
  removeJob(id: number): void { this.jobs.delete(id); }
  remove(pid: number): void {
    const record = this.records.get(pid);
    if (!record) return;
    this.records.delete(pid);
    const job = this.jobs.get(record.job);
    job?.members.delete(pid);
    // Completion metadata outlives individual child reap until wait_job consumes it.
  }
}
