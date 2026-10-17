import type { FileHandle } from "./filesystem";

export interface Readiness {
  readable: boolean;
  writable: boolean;
  hangup: boolean;
  nbytes?: number;
}
/** Pipe and terminal services supply I/O and level-triggered readiness, never guest pointers.
 * I/O returns a byte count or negative WASI errno. Preview1 adapters may block inside read/write.
 */
export interface Stream {
  kind: "pipe" | "terminal";
  read(chunks: readonly Uint8Array[]): number;
  write(chunks: readonly Uint8Array[]): number;
  /** Explicit immediate operations for async guests; never fall back to blocking preview1 I/O. */
  tryRead?(chunks: readonly Uint8Array[]): number;
  tryWrite?(chunks: readonly Uint8Array[]): number;
  readiness(): Readiness;
  /** Shared sequence incremented and notified after readiness changes. */
  readonly notification?: Int32Array;
  close?(): void;
  /** A process gets independent capabilities; dup within one process keeps its description. */
  forProcess?(pid: number): Stream;
  /** Freeze shared I/O before releasing references or requesting physical termination. */
  revoke?(): void;
}
export type Resource =
  | { kind: "file"; handle: FileHandle; offset: number; append: boolean }
  | { kind: "directory"; handle: FileHandle }
  | Stream;

/** POSIX open description: offset, flags and lifetime shared by all descriptor references. */
export class OpenDescription {
  private count = 0;
  get references(): number { return this.count; }
  private released = false;
  constructor(public readonly resource: Resource, private readonly release?: () => void) {}
  retain(): void {
    if (this.released) throw new Error("open description is closed");
    this.count++;
  }
  drop(): void {
    if (this.count === 0) throw new Error("open description has no references");
    if (--this.count === 0) {
      this.released = true;
      this.release?.();
    }
  }
}
export interface Descriptor {
  description: OpenDescription;
  readonly resource: Resource;
  rightsBase: bigint;
  rightsInheriting: bigint;
  preopen?: string;
}
/** Successful runtime_proc fd results must also be nonnegative WASM i32 values. */
export const MAX_DESCRIPTOR = 0x7fffffff;
export class DescriptorTable {
  private entries = new Map<number, Descriptor>();
  private next = 0;
  get(fd: number): Descriptor | undefined { return this.entries.get(fd); }
  add(description: OpenDescription, rights: { rightsBase: bigint; rightsInheriting: bigint; preopen?: string }): number {
    if (this.entries.size > MAX_DESCRIPTOR) throw new RangeError("descriptor table is full");
    let fd = this.next;
    while (this.entries.has(fd)) fd = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
    description.retain();
    this.entries.set(fd, { ...rights, description, resource: description.resource });
    this.next = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
    return fd;
  }
  open(resource: Resource, rightsBase: bigint, rightsInheriting: bigint, release?: () => void, preopen?: string): number {
    return this.add(new OpenDescription(resource, release ?? (resource.kind === "pipe" || resource.kind === "terminal" ? () => resource.close?.() : undefined)), { rightsBase, rightsInheriting, preopen });
  }
  dup(fd: number): number {
    const entry = this.entries.get(fd);
    if (!entry) return -8;
    // Preopen discovery belongs to the binding, not the shared description.
    return this.add(entry.description, { rightsBase: entry.rightsBase, rightsInheriting: entry.rightsInheriting });
  }
  /** Retain before replacing, including when both bindings already share the description. */
  inherit(fd: number, source: Descriptor): void {
    if (!Number.isInteger(fd) || fd < 0 || fd > MAX_DESCRIPTOR) throw new RangeError("invalid descriptor number");
    source.description.retain();
    this.close(fd);
    this.entries.set(fd, { description: source.description, resource: source.resource, rightsBase: source.rightsBase, rightsInheriting: source.rightsInheriting });
    if (fd >= this.next) this.next = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
  }
  close(fd: number): boolean {
    const entry = this.entries.get(fd);
    if (!entry) return false;
    this.entries.delete(fd);
    entry.description.drop();
    return true;
  }
  renumber(from: number, to: number): boolean {
    const entry = this.entries.get(from);
    if (!entry || !this.entries.has(to)) return false;
    if (from === to) return true;
    this.close(to);
    this.entries.set(to, entry);
    this.entries.delete(from);
    return true;
  }
  dispose(): void { for (const fd of this.entries.keys()) this.close(fd); }
}
