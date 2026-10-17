import type { SpawnRequest } from "./types";
export { ProcessIdentityAllocator } from "./identity";

export interface ProcessStarter { start(pid: number): void | Promise<void> }
export interface FirstSpawnOptions {
  /** Synchronous reservation takes descriptor references before returning the pid. */
  reserve(parentPid: number, request: SpawnRequest): number;
  /** Host-side import/initialization. Never block a guest task on this promise. */
  activate(): Promise<ProcessStarter>;
  fail(pid: number, error: unknown): void;
}
/** Tiny activation bridge, independent of the registry, process table and worker executor. */
export class FirstSpawnStub {
  private activation?: Promise<ProcessStarter>;
  constructor(private readonly options: FirstSpawnOptions) {}
  activated(): Promise<ProcessStarter> {
    return this.activation ??= Promise.resolve().then(() => this.options.activate());
  }
  spawn(parentPid: number, request: SpawnRequest): number {
    const pid = this.options.reserve(parentPid, request);
    void this.activated().then(starter => starter.start(pid)).catch(error => this.options.fail(pid, error));
    return pid;
  }
}
