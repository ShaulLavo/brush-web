import {
  decodeSnapshot, encodeSnapshot, validatePersistedIndex, validatePersistedNode, validInteger,
  type PersistenceBatch, type PersistedIndex, type PersistedNode, type StorageBackend,
} from "./storage";
import type { StorageLockManager } from "./indexeddb";

/** OPFS is owned by the filesystem worker, never a document or guest. */
export interface OpfsStorageOptions {
  root?: FileSystemDirectoryHandle;
  storage?: StorageManager;
  locks?: StorageLockManager;
  /** Default 32, or 1 on Firefox, whose sync-handle opens serialize. */
  createConcurrency?: number;
  /** Default 64. Cache + in-flight creates + metadata must stay well below Safari's 253. */
  handleCacheSize?: number;
}
interface SyncAccess {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> };
type Directory = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> };
interface Snapshot { name: string; index: PersistedIndex }
const encoder = new TextEncoder(), decoder = new TextDecoder();
const BACKOFF_MS = [5, 10, 20, 40, 80];
const LOCKED = new Set(["NotReadableError", "NoModificationAllowedError", "InvalidStateError"]);
function missing(error: unknown): boolean { return (error as { name?: unknown })?.name === "NotFoundError"; }
function translate(error: unknown, operation: string): Error {
  if (typeof (error as { code?: unknown })?.code === "string") return error as Error;
  const name = (error as { name?: string })?.name ?? "Error";
  return Object.assign(new Error(`OPFS ${operation}: ${name}: ${error instanceof Error ? error.message : String(error)}`), {
    code: name === "QuotaExceededError" ? "ENOSPC" : missing(error) ? "ENOENT" : "EIO", cause: error,
  });
}
function encodeName(key: string): string {
  // Opaque keys can contain slashes and NULs. UTF-8 base64url is injective for our string keys.
  // JSON preserves lone UTF-16 surrogates as well, instead of TextEncoder replacing them.
  let binary = "";
  for (const byte of encoder.encode(JSON.stringify(key))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function payloadName(key: string): string { return `p-${encodeName(key)}`; }
function keys(index: PersistedIndex): string[] { return index.nodes.flatMap(node => node.data === undefined ? [] : [node.data]); }
async function parallel<T>(items: readonly T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0, failure: unknown;
  const jobs = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length && failure === undefined) {
      const item = items[cursor++]!;
      try { await action(item); } catch (error) { failure ??= error; }
    }
  });
  // Settle every acquisition/write before cleanup; Promise.all's first rejection is too early.
  await Promise.all(jobs);
  if (failure !== undefined) throw failure;
}

/** One immutable OPFS payload per logical file revision, and two checksummed snapshot copies.
 * A checkpoint closes payloads without flushing each one; explicit flush(keys) fsyncs those
 * payloads and then the naming snapshot. No payload is read while loading the index. */
export class OpfsStorage implements StorageBackend {
  private tail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private initialized = false;
  private closed = false;
  private closing?: Promise<void>;
  private snapshots: Snapshot[] = [];
  private known = new Map<string, number>();
  private dirty = new Set<string>();
  private handles = new Map<string, SyncAccess>();
  private liveHandles = 0;
  private peakHandles = 0;
  private garbage = new Set<string>();
  private needsOrphanSweep = true;

  private constructor(private data: Directory, private metadata: Directory,
    private unlock: () => Promise<void>, private concurrency: number, private cacheSize: number) {}

  static async delete(name: string, options: Pick<OpfsStorageOptions, "root" | "storage" | "locks"> = {}): Promise<void> {
    // Deletion is a writer operation too; it must never remove a live tab's workspace.
    const owner = await OpfsStorage.open(name, options);
    try {
      const root = options.root ?? await (options.storage ?? globalThis.navigator?.storage)!.getDirectory();
      await root.removeEntry(`bun-wasm-${encodeName(name)}`, { recursive: true });
    } catch (error) { if (!missing(error)) throw translate(error, "delete"); }
    finally { await owner.close(); }
  }
  static async open(name: string, options: OpfsStorageOptions = {}): Promise<OpfsStorage> {
    const locks: StorageLockManager | undefined = options.locks ?? globalThis.navigator?.locks;
    if (!locks) throw new Error("OPFS storage requires Web Locks");
    const concurrency = options.createConcurrency ?? (/Firefox\//.test(globalThis.navigator?.userAgent ?? "") ? 1 : 32);
    const cacheSize = options.handleCacheSize ?? 64;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Invalid OPFS create concurrency");
    if (!Number.isSafeInteger(cacheSize) || cacheSize < 1 || cacheSize + concurrency + 1 > 192) throw new Error("Invalid OPFS handle cache size");
    let release!: () => void, acquired!: () => void, refused!: (error: unknown) => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; refused = reject; });
    const lifetime = locks.request(`bun-wasm:filesystem:${name}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (lock === null) { refused(new Error("Filesystem already has a writer in another tab")); return; }
      acquired(); await held;
    });
    void lifetime.catch(refused);
    await ready;
    const unlock = async () => { release(); await lifetime; };
    try {
      const root = options.root ?? await (options.storage ?? globalThis.navigator?.storage)?.getDirectory();
      if (!root) throw new Error("OPFS storage requires navigator.storage.getDirectory()");
      const workspace = await root.getDirectoryHandle(`bun-wasm-${encodeName(name)}`, { create: true });
      const data = await workspace.getDirectoryHandle("data", { create: true });
      const metadata = await workspace.getDirectoryHandle("metadata", { create: true });
      return new OpfsStorage(data as Directory, metadata as Directory, unlock, concurrency, cacheSize);
    } catch (error) { await unlock(); throw translate(error, "open"); }
  }
  resources(): Record<string, number> {
    return { opfsHandles: this.liveHandles, opfsPeakHandles: this.peakHandles, opfsCachedHandles: this.handles.size,
      opfsHandleLimit: this.cacheSize + this.concurrency + 1 };
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Filesystem storage is closed"));
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  load(): Promise<PersistedIndex | undefined> {
    return this.enqueue(async () => { await this.initialize(); return this.snapshots[0] && structuredClone(this.snapshots[0].index); });
  }
  read(key: string): Promise<Uint8Array> {
    return this.enqueue(async () => {
      await this.initialize();
      if (!this.known.has(key)) throw new Error(`Missing filesystem payload: ${key}`);
      try {
        const access = await this.cached(key);
        const bytes = new Uint8Array(access.getSize());
        for (let offset = 0; offset < bytes.length; ) {
          const count = access.read(bytes.subarray(offset), { at: offset });
          if (!(count > 0)) throw new Error(`Short filesystem payload: ${key}`);
          offset += count;
        }
        if (bytes.length !== this.known.get(key)) throw new Error(`Invalid filesystem payload size: ${key}`);
        return bytes;
      } catch (error) { throw translate(error, "read payload"); }
    });
  }
  persist(batch: PersistenceBatch): Promise<void> {
    let copy: PersistenceBatch;
    try {
      copy = { ...structuredClone({ generation: batch.generation, root: batch.root, upserts: batch.upserts,
        removes: batch.removes, retainedData: batch.retainedData }),
        data: new Map(Array.from(batch.data, ([key, bytes]) => [key, new Uint8Array(bytes)])) };
    } catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      try { await this.initialize(); await this.commit(copy); this.persistenceError = undefined; }
      catch (error) { this.persistenceError = error; throw error; }
    });
  }
  flush(selected?: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.persistenceError !== undefined) throw this.persistenceError;
      await this.initialize();
      const pending = selected === undefined ? Array.from(this.dirty) : Array.from(new Set(selected));
      try {
        for (const key of pending) {
          if (!this.known.has(key)) throw new Error(`Missing filesystem payload: ${key}`);
          const access = await this.cached(key);
          access.flush();
          this.dirty.delete(key);
        }
        // Order is payload flush, then naming metadata flush. fsync never promises durability
        // for unrelated files in the same memory-first checkpoint.
        const snapshot = this.snapshots[0];
        if (snapshot) {
          const access = await this.access(await this.metadata.getFileHandle(snapshot.name));
          try { access.flush(); } finally { this.closeAccess(access); }
        }
      } catch (error) { throw translate(error, "flush"); }
    });
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.tail.then(async () => {
        let failure: unknown;
        try {
          for (const access of this.handles.values()) {
            try { this.closeAccess(access); } catch (error) { failure ??= error; }
          }
          this.handles.clear();
        } finally { await this.unlock(); }
        if (failure !== undefined) throw failure;
      });
    }
    return this.closing;
  }
  private closeAccess(access: SyncAccess): void { try { access.close(); } finally { this.liveHandles--; } }
  private async access(handle: FileSystemFileHandle): Promise<SyncAccess> {
    if (typeof (handle as SyncFile).createSyncAccessHandle !== "function") throw new Error("OPFS storage requires sync access handles in a dedicated worker");
    for (let attempt = 0; ; attempt++) {
      try {
        const access = await (handle as SyncFile).createSyncAccessHandle();
        this.liveHandles++; this.peakHandles = Math.max(this.peakHandles, this.liveHandles);
        return access;
      } catch (error) {
        const delay = BACKOFF_MS[attempt];
        if (!LOCKED.has((error as { name?: string })?.name ?? "") || delay === undefined) throw translate(error, "open sync handle");
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  private drop(key: string): void {
    const access = this.handles.get(key);
    if (access) { this.handles.delete(key); this.closeAccess(access); }
  }
  private async cached(key: string): Promise<SyncAccess> {
    let access = this.handles.get(key);
    if (access) { this.handles.delete(key); this.handles.set(key, access); return access; }
    // Evict before opening, including the transient handle in the cap.
    if (this.handles.size >= this.cacheSize) this.drop(this.handles.keys().next().value!);
    access = await this.access(await this.data.getFileHandle(payloadName(key)));
    this.handles.set(key, access);
    return access;
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    let existed = false, ordinarySnapshotExisted = false;
    const snapshots: Snapshot[] = [];
    for await (const [name, handle] of this.metadata.entries()) {
      if (!name.startsWith("snapshot-") || handle.kind !== "file") continue;
      existed = true;
      if (name !== "snapshot-initial.json") ordinarySnapshotExisted = true;
      try {
        const index = await decodeSnapshot(JSON.parse(await (handle as FileSystemFileHandle).getFile().then(file => file.text())));
        if (index) snapshots.push({ name, index });
      } catch { /* An interrupted new snapshot never damages the prior copy. */ }
    }
    snapshots.sort((a, b) => b.index.generation - a.index.generation
      || Number(a.name === "snapshot-initial.json") - Number(b.name === "snapshot-initial.json"));
    if (!snapshots.length && ordinarySnapshotExisted) throw new Error("Existing OPFS filesystem storage is corrupt; no valid snapshot can be recovered");
    // A torn initial empty baseline means no payload write or committed namespace ever started.
    if (!snapshots.length && existed) await this.metadata.removeEntry("snapshot-initial.json").catch(() => {});
    this.snapshots = snapshots.slice(0, 2);
    // A freshly created workspace has no interrupted attempts to collect. Avoid enumerating
    // its just-written corpus; reopened workspaces sweep only after their next checkpoint.
    this.needsOrphanSweep = existed;
    for (const snapshot of this.snapshots) for (const node of snapshot.index.nodes) if (node.data !== undefined) this.known.set(node.data, node.size);
    // Reload cannot infer physical durability from a previous close-only checkpoint. Only the
    // current tree, not obsolete rollback-only payloads, is owed by a global fsync.
    if (this.snapshots[0]) this.dirty = new Set(keys(this.snapshots[0].index));
    this.initialized = true;
  }
  private async commit(batch: PersistenceBatch): Promise<void> {
    const old = this.snapshots[0]?.index;
    const initial = this.snapshots[0]?.name === "snapshot-initial.json";
    if (!validInteger(batch.generation) || (old && (batch.generation < old.generation || batch.generation === old.generation && !initial))) throw new Error("Filesystem generation must increase");
    const nodes = new Map<number, PersistedNode>(old?.nodes.map(node => [node.ino, node]));
    const changed = new Set<number>();
    for (const node of batch.upserts) {
      validatePersistedNode(node);
      if (changed.has(node.ino)) throw new Error("Invalid filesystem metadata: duplicate inode");
      changed.add(node.ino); nodes.set(node.ino, node);
    }
    for (const ino of batch.removes) {
      if (!validInteger(ino) || changed.has(ino)) throw new Error("Invalid filesystem metadata: invalid removal");
      changed.add(ino); nodes.delete(ino);
    }
    const index: PersistedIndex = { version: 1, generation: batch.generation, root: batch.root, nodes: Array.from(nodes.values()) };
    validatePersistedIndex(index);
    const expected = new Map<string, number>();
    for (const node of index.nodes) if (node.data !== undefined) {
      const size = expected.get(node.data);
      if (size !== undefined && size !== node.size) throw new Error(`Invalid filesystem payload size: ${node.data}`);
      expected.set(node.data, node.size);
    }
    for (const [key, size] of expected) {
      const supplied = batch.data.get(key), known = this.known.get(key);
      if (supplied === undefined && known === undefined) throw new Error(`Missing filesystem payload: ${key}`);
      if ((supplied?.length ?? known) !== size) throw new Error(`Invalid filesystem payload size: ${key}`);
    }
    for (const key of batch.retainedData ?? []) if (!this.known.has(key) && !batch.data.has(key)) throw new Error(`Missing filesystem payload: ${key}`);
    const record = encoder.encode(JSON.stringify(await encodeSnapshot(index)));
    const name = `snapshot-${batch.generation}-${crypto.randomUUID()}.json`;
    const created: string[] = [];
    try {
      if (!old) {
        // Make the previous empty state recoverable before the first payload/snapshot can tear.
        const root = nodes.get(batch.root)!;
        const empty: PersistedIndex = { version: 1, generation: 0, root: batch.root,
          nodes: [{ ...root, children: [] }] };
        await this.write(await this.metadata.getFileHandle("snapshot-initial.json", { create: true }),
          encoder.encode(JSON.stringify(await encodeSnapshot(empty))), true);
        this.snapshots = [{ name: "snapshot-initial.json", index: empty }];
      }
      await parallel(Array.from(batch.data), this.concurrency, async ([key, bytes]) => {
        if (this.known.has(key)) {
          this.drop(key); // A second exclusive handle must not conflict with our own read cache.
          const access = await this.access(await this.data.getFileHandle(payloadName(key)));
          try {
            if (access.getSize() !== bytes.length) throw new Error(`Cannot overwrite immutable filesystem payload: ${key}`);
            const prior = new Uint8Array(bytes.length);
            let offset = 0;
            while (offset < prior.length) {
              const count = access.read(prior.subarray(offset), { at: offset });
              if (!(count > 0)) throw new Error(`Short filesystem payload: ${key}`);
              offset += count;
            }
            if (prior.some((byte, i) => byte !== bytes[i])) throw new Error(`Cannot overwrite immutable filesystem payload: ${key}`);
          } finally { this.closeAccess(access); }
          return;
        }
        // Any same-key file left by an interrupted *uncommitted* attempt is an orphan.
        created.push(key);
        const handle = await this.data.getFileHandle(payloadName(key), { create: true });
        await this.write(handle, bytes, false);
      });
      await this.write(await this.metadata.getFileHandle(name, { create: true }), record, true);
    } catch (error) {
      await Promise.all(created.map(key => this.data.removeEntry(payloadName(key)).catch(() => {})));
      await this.metadata.removeEntry(name).catch(() => {});
      throw translate(error, "persist");
    }
    const previous = this.snapshots[0];
    this.snapshots = [{ name, index }].concat(previous ? [previous] : []);
    for (const [key, bytes] of batch.data) {
      this.known.set(key, bytes.length); this.dirty.add(key);
      // Failed earlier collection may still name a key that this checkpoint has re-adopted.
      this.garbage.delete(payloadName(key));
    }
    const required = new Set(keys(index).concat(batch.retainedData ?? []));
    for (const key of this.dirty) if (!required.has(key)) this.dirty.delete(key);
    const retained = new Set(this.snapshots.flatMap(snapshot => keys(snapshot.index)).concat(batch.retainedData ?? []));
    // Only old, known payloads need per-commit collection. Orphan files from a killed worker
    // are collected separately on a later checkpoint, never by scanning payloads on lazy open.
    for (const key of this.known.keys()) if (!retained.has(key)) {
      this.drop(key); this.known.delete(key); this.dirty.delete(key); this.garbage.add(payloadName(key));
    }
    await this.collect();
  }
  private async write(handle: FileSystemFileHandle, bytes: Uint8Array, durable: boolean): Promise<void> {
    const access = await this.access(handle);
    try {
      access.truncate(bytes.length);
      for (let offset = 0; offset < bytes.length; ) {
        const count = access.write(bytes.subarray(offset), { at: offset });
        if (!(count > 0)) throw Object.assign(new Error("OPFS write made no progress"), { code: "ENOSPC" });
        offset += count;
      }
      if (durable) access.flush();
    } finally { this.closeAccess(access); }
  }
  private async collect(): Promise<void> {
    // Garbage collection is after publication. A cleanup failure cannot uncommit a save.
    // Sweep unknown crash remnants once at the first checkpoint, never during lazy startup.
    if (this.needsOrphanSweep) {
      try {
        const retained = new Set(Array.from(this.known.keys(), payloadName));
        for await (const [name, handle] of this.data.entries()) if (handle.kind === "file" && !retained.has(name)) this.garbage.add(name);
        this.needsOrphanSweep = false;
      } catch { /* Retry after the next checkpoint; ownership is still this worker's. */ }
    }
    for (const name of this.garbage) {
      try { await this.data.removeEntry(name); this.garbage.delete(name); } catch { /* Retry at the next checkpoint. */ }
    }
    const retained = new Set(this.snapshots.map(snapshot => snapshot.name));
    try {
      for await (const [name, handle] of this.metadata.entries()) if (handle.kind === "file" && name.startsWith("snapshot-") && !retained.has(name)) {
        await this.metadata.removeEntry(name);
      }
    } catch { /* Retaining an extra valid snapshot is safe; cleanup retries next time. */ }
  }
}
