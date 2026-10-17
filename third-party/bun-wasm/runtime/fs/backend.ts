import type { FileHandle, ResolvedPath } from "../core";
import { MemFS, type Node } from "./memory";
import { FilesystemError } from "./protocol";
import { SharedFilesystemState, type SharedSegment } from "./shared";

/** Storage boundary. 3b can add asynchronous loading/commit without changing guest transport. */
export interface FilesystemBackend {
  execute(operation: string, args: any[], data: Uint8Array): unknown | Promise<unknown>;
  retain(handle: FileHandle): void;
  release(handle: FileHandle): void;
  resources?(): Record<string, number>;
  revokeOwner?(owner: number, epoch?: Int32Array): void;
  takeSharedSegments?(): SharedSegment[];
  sharedSegments?(): SharedSegment[];
  /** Lazy storage reads finish before the service acquires its mutation lock. */
  prepare?(operation: string, args: any[], data: Uint8Array): void | Promise<void>;
  flush?(): Promise<void>;
}
const namespaceOperations = new Set(["preopen", "create", "link", "removePath", "rename", "writeFile", "mkdirp", "remove", "move"]);
export class MemoryBackend implements FilesystemBackend {
  readonly fs: MemFS;
  constructor(fs = new MemFS()) { this.fs = fs; }
  shared = new SharedFilesystemState();
  private sharedAttached = false;
  private directoryTimes = new Map<FileHandle, number>();
  attachShared(buffer: SharedArrayBuffer, maxBytes?: number, segments: readonly SharedArrayBuffer[] = []): void {
    if (this.sharedAttached) {
      // SAB wrappers change identity when cloned through a port. Probe a reserved header word
      // instead; connect runs synchronously on the sole service thread and guests never use it.
      const incoming = new Int32Array(buffer, 0, 16);
      const previous = Atomics.load(this.shared.cells, 6);
      const probe = previous ^ -1;
      Atomics.store(this.shared.cells, 6, probe);
      const same = Atomics.load(incoming, 6) === probe;
      Atomics.store(this.shared.cells, 6, previous);
      if (same) return;
      throw new Error("filesystem service cannot attach a second shared tree");
    }
    this.shared = new SharedFilesystemState(buffer, maxBytes, undefined, segments);
    this.sharedAttached = true;
  }
  protected sync(handle: FileHandle): void {
    const node = this.fs.nodeForHandle(handle);
    const stat = this.fs.stat(handle);
    if (node.kind === "file") this.shared.register(handle, stat, node.data);
    else if (this.directoryTimes.get(handle) !== stat.mtime || !this.shared.stat(handle)) {
      this.shared.register(handle, stat);
      this.directoryTimes.set(handle, stat.mtime);
    }
  }
  protected isLinked(node: Node): boolean { return this.fs.hasNode(node); }
  retain(handle: number): void { this.check(handle); this.fs.retain(handle); this.shared.retain(handle); }
  release(handle: number): void { this.shared.release(handle); this.fs.release(handle); }
  private check(handle: number, kind?: "file" | "directory"): void {
    let stat;
    try { stat = this.fs.stat(handle); } catch { throw new FilesystemError(8); }
    this.sync(handle);
    if (kind && stat.kind !== kind) throw new FilesystemError(kind === "directory" ? 54 : 31);
  }
  private path(path: ResolvedPath): void {
    if (path.parent === undefined || path.terminalDot) return;
    this.check(path.parent, "directory");
    const current = this.fs.resolve(path.parent, path.name);
    if (typeof current === "number") throw new FilesystemError(current);
    if (current.node !== path.node) throw new FilesystemError(current.node === undefined ? 44 : 20);
  }
  private existing(path: string): { handle: FileHandle; node: Extract<Node, { kind: "file" }> } | undefined {
    const node = this.fs.lookup(path);
    if (!node || node.kind !== "file") return undefined;
    const handle = this.fs.handleForNode(node);
    this.sync(handle);
    return { handle, node };
  }
  execute(operation: string, args: any[], data: Uint8Array): unknown {
    try { return this.executeOperation(operation, args, data); }
    finally {
      if (namespaceOperations.has(operation)) for (const handle of this.directoryTimes.keys()) {
        try { this.sync(handle); } catch { this.directoryTimes.delete(handle); }
      }
    }
  }
  private executeOperation(operation: string, args: any[], data: Uint8Array): unknown {
    const [a, b, c] = args;
    switch (operation) {
      case "flush": return;
      case "sync": this.check(a); return 0;
      case "preopen": { const handle = this.fs.preopen(a); this.sync(handle); return handle; }
      case "resolve": this.check(a, "directory"); return this.fs.resolve(a, b);
      case "stat": this.check(a); return this.shared.stat(a)!;
      case "read": { this.check(a, "file"); const bytes = new Uint8Array(b); const count = this.shared.read(a, [bytes], c); return bytes.subarray(0, count); }
      case "write": this.check(a, "file"); if (!data.length) return 0; return this.shared.mutate(undefined, undefined, () => { this.shared.growLocked(a, b + data.length); const result = this.shared.write(a, [data], b); this.fs.setMtime(a, Date.now()); return result; });
      case "append": { this.check(a, "file"); if (!data.length) return { written: 0, offset: this.shared.info(a)!.size }; return this.shared.mutate(undefined, undefined, () => { const info = this.shared.info(a)!; this.shared.growLocked(a, info.size + data.length); const result = this.shared.append(a, [data]); this.fs.setMtime(a, Date.now()); return result; }); }
      case "grow": this.check(a, "file"); this.shared.grow(a, b); return;
      case "resize": this.check(a, "file"); return this.shared.mutate(undefined, undefined, () => { this.shared.growLocked(a, b); const result = this.shared.resize(a, b, c); if (c) this.shared.reclaimLocked(a); return result; });
      case "setMtime": this.check(a); this.fs.setMtime(a, b); return this.shared.mutate(undefined, undefined, () => this.shared.setMtime(a, b));
      case "readdir": this.check(a, "directory"); return this.fs.readdir(a);
      case "create": {
        if (a.parent !== undefined) this.check(a.parent, "directory");
        const result = this.fs.create(a, b, c);
        if (typeof result === "number") this.sync(result);
        return result;
      }
      case "link": {
        this.path(a); this.path(b);
        const result = this.fs.link(a, b);
        if (!result && a.node !== undefined) this.shared.relink(a.node);
        return result;
      }
      case "removePath": {
        this.path(a); const handle = a.node;
        const removed = handle === undefined ? undefined : this.fs.nodeForHandle(handle);
        const result = this.fs.removePath(a, b);
        if (!result && handle !== undefined && removed && !this.isLinked(removed)) this.shared.unlink(handle);
        return result;
      }
      case "rename": {
        this.path(a); this.path(b); const target = b.node;
        const replaced = target === undefined ? undefined : this.fs.nodeForHandle(target);
        const result = this.fs.rename(a, b);
        if (!result && target !== undefined && target !== a.node && replaced && !this.isLinked(replaced)) this.shared.unlink(target);
        return result;
      }
      case "lookup": {
        const node = this.fs.lookup(a);
        if (!node) return undefined;
        const metadata = (entry: Node) => {
          const handle = this.fs.handleForNode(entry);
          this.sync(handle);
          const stat = this.shared.stat(handle);
          return { kind: entry.kind, ino: entry.ino, mtime: stat?.mtime ?? entry.mtime };
        };
        return node.kind === "file" ? metadata(node) : { ...metadata(node), children: new Map(Array.from(node.children, ([name, child]) => [name, metadata(child)])) };
      }
      case "readFile": {
        const existing = this.existing(a);
        if (!existing) return undefined;
        const bytes = new Uint8Array(this.shared.info(existing.handle)!.size);
        const count = this.shared.read(existing.handle, [bytes], 0);
        return bytes.subarray(0, count);
      }
      case "writeFile": {
        const existing = this.existing(a);
        if (existing) {
          if (b && !data.length) return;
          if (b) this.shared.mutate(undefined, undefined, () => { const info = this.shared.info(existing.handle)!; this.shared.growLocked(existing.handle, info.size + data.length); this.shared.append(existing.handle, [data]); this.fs.setMtime(existing.handle, Date.now()); });
          else this.shared.mutate(undefined, undefined, () => { this.shared.growLocked(existing.handle, data.length); this.shared.resize(existing.handle, 0, true); this.shared.write(existing.handle, [data], 0); this.shared.reclaimLocked(existing.handle); this.fs.setMtime(existing.handle, Date.now()); });
          return;
        }
        this.fs.writeFile(a, data.slice(), false);
        try { const created = this.existing(a); if (created) this.sync(created.handle); }
        catch (error) { this.fs.remove(a); throw error; }
        return;
      }
      case "mkdirp": this.fs.mkdirp(a); return;
      case "remove": {
        const detached: { node: Node; handle: FileHandle }[] = [];
        const collect = (node: Node) => {
          detached.push({ node, handle: this.fs.handleForNode(node) });
          if (node.kind === "dir") for (const child of node.children.values()) collect(child);
        };
        const node = this.fs.lookup(a);
        if (node) collect(node);
        const result = this.fs.remove(a);
        if (result) for (const entry of detached) if (!this.isLinked(entry.node)) this.shared.unlink(entry.handle);
        return result;
      }
      case "listFiles": return this.fs.listFiles(a);
      case "move": {
        const root = this.fs.preopen("/"); this.sync(root);
        const from = this.fs.resolve(root, a.replace(/^\//, ""));
        const to = this.fs.resolve(root, b.replace(/^\//, ""));
        if (typeof from === "number") return from;
        if (typeof to === "number") return to;
        const target = to.node;
        const replaced = target === undefined ? undefined : this.fs.nodeForHandle(target);
        const result = this.fs.rename(from, to);
        if (!result && target !== undefined && target !== from.node && replaced && !this.isLinked(replaced)) this.shared.unlink(target);
        return result;
      }
      default: throw new FilesystemError(52, `unknown filesystem operation ${operation}`);
    }
  }
  revokeOwner(owner: number, epoch?: Int32Array): void { this.shared.revokeOwner(owner, epoch); }
  takeSharedSegments(): SharedSegment[] { return this.shared.takeNewSegments(); }
  sharedSegments(): SharedSegment[] { return this.shared.segments.slice(1).flatMap((buffer, index) => buffer.byteLength ? [{ buffer, index: index + 1 }] : []); }
  resources(): Record<string, number> { return this.shared.resources(); }
}
