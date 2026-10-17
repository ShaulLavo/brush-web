import type { DescriptorTable } from "../core/descriptors";

export const Signal = Object.freeze({ SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 });
export type ProcessSignal = 2 | 9 | 13 | 15;
export type Signal = ProcessSignal;
export type ProcessExit = Readonly<{ kind: "exited" | "signaled"; code: number; status: number }>;
export interface DescriptorBinding { child: number; parent: number }
export interface SpawnRequest {
  executable: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** 0 creates a foreground job, -1 a background job; positive ids join a job. */
  job: number;
  fds: DescriptorBinding[];
}
export interface SpawnReservation {
  pid?: number;
  job?: number;
  interrupt?: Int32Array | SharedArrayBuffer;
  requestedSignal?: Int32Array | SharedArrayBuffer;
  signalState?: Int32Array | SharedArrayBuffer;
  outcome?: BigInt64Array | SharedArrayBuffer;
}
export interface ProcessHandle {
  /** Physical teardown only: revoked shared buffers are never reused, even after this returns. */
  terminate(): void | Promise<void>;
}
export interface ProcessContext {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly request: Readonly<SpawnRequest>;
  readonly module: WebAssembly.Module;
  readonly adapter: string;
  readonly descriptors: DescriptorTable;
  /** Wake hint only; signal identity and pending delivery live in signalState. */
  readonly interrupt: Int32Array;
  /** Unlike interrupt, this word preserves the last requested signal after a checkpoint. */
  readonly requestedSignal: Int32Array;
  /** Shared per-signal disposition and pending cells, indexed by signal number. */
  readonly signalState: Int32Array;
  /** Shared immutable terminal outcome, atomically arbitrated with synchronous parent stubs. */
  readonly outcome: BigInt64Array;
  exit(code: number): void;
  /** Ordinary startup/guest failure exits 126; default signal actions are explicit. */
  fail(error: unknown): void;
  defaultSignal(signal?: number): void;
  registerRevocation(hook: () => void): () => void;
}
export interface ChildExitEvent {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly result: ProcessExit;
}
export class ProcessError extends Error {
  readonly errno: number;
  constructor(errno: number, message: string) { super(message); this.errno = errno; this.name = "ProcessError"; }
}
export const ProcessErrno = Object.freeze({ AGAIN: 6, BADF: 8, CHILD: 12, INVAL: 28, SRCH: 71 });
export function checkedSignal(signal: number): ProcessSignal {
  if (signal !== 2 && signal !== 9 && signal !== 13 && signal !== 15) {
    throw new ProcessError(ProcessErrno.INVAL, `unsupported signal ${signal}`);
  }
  return signal;
}
