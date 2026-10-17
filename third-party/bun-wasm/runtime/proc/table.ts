import { DescriptorTable } from "../core/descriptors";
import { ProcessIdentityAllocator } from "./identity";
import { ProcessErrno, ProcessError, type ProcessExit, type ProcessHandle, type SpawnRequest } from "./types";

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
  /** Descendants inherit a job unless spawn explicitly creates/joins another one. */
  readonly members: ReadonlySet<number>;
}
interface MutableProcessJob extends Omit<ProcessJob, "members"> { members: Set<number> }
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
  values(): IterableIterator<ProcessRecord> { return this.records.values(); }
  require(pid: number): ProcessRecord {
    const record = this.get(pid);
    if (!record) throw new ProcessError(ProcessErrno.SRCH, `unknown process ${pid}`);
    return record;
  }
  createJob(ownerPid: number, foreground: boolean, id = this.identities.job()): ProcessJob {
    if (this.usedJobs.has(id)) throw new ProcessError(ProcessErrno.INVAL, `job ${id} was already reserved`);
    this.identities.observeJob(id);
    const job: MutableProcessJob = { id, ownerPid, foreground, members: new Set() };
    this.usedJobs.add(id);
    this.jobs.set(id, job);
    return job;
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
  insert(record: ProcessRecord): void {
    this.checkPid(record.pid);
    const job = this.jobs.get(record.job);
    if (!job) throw new ProcessError(ProcessErrno.SRCH, `unknown job ${record.job}`);
    this.identities.observePid(record.pid);
    this.usedPids.add(record.pid);
    this.parents.set(record.pid, record.parentPid);
    this.records.set(record.pid, record);
    job.members.add(record.pid);
  }
  remove(pid: number): void {
    const record = this.records.get(pid);
    if (!record) return;
    this.records.delete(pid);
    const job = this.jobs.get(record.job)!;
    job.members.delete(pid);
    if (job.members.size === 0) this.jobs.delete(job.id);
  }
}
