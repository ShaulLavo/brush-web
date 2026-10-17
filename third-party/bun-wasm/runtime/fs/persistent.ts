import type { FileHandle } from "../core";
import { MemoryBackend } from "./backend";
import { MemFS, adoptInodes, type Node, type DirNode, type FileNode } from "./memory";
import type { PersistedIndex, PersistedNode, PersistenceBatch, StorageBackend } from "./storage";

/** Memory is authoritative while running. Storage receives immutable, ordered checkpoints;
 * no lock or guest request is held across a background commit. */
export class PersistentBackend extends MemoryBackend {
  private nodes = new Map<number, Node>();
  private detached = new WeakSet<Node>();
  private links = new Map<number, number>();
  private removed = new Set<number>();
  private dirty = new Set<Node>();
  private keys = new Map<number, string>();
  private committedKeys = new Map<number, string>();
  private detachedKeys = new Map<number, string>();
  private revisions = new Map<number, number>();
  private registeredNodes = new Map<number, Node>();
  private loading = new Map<FileHandle, Promise<void>>();
  private lastCommit: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private sequence = 0;
  private checkpointEpoch = 0;
  private pendingCheckpoints = 0;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private nonce = crypto.randomUUID();
  private constructor(private storage: StorageBackend, fs: MemFS, index?: PersistedIndex, intervalMs = 50) {
    super(fs);
    const visit = (node: Node) => {
      this.links.set(node.ino, (this.links.get(node.ino) ?? 0) + 1);
      if (this.nodes.has(node.ino)) return;
      this.nodes.set(node.ino, node);
      if (node.kind === "dir") for (const child of node.children.values()) visit(child);
    };
    visit(fs.root);
    if (index) {
      this.generation = index.generation;
      for (const node of index.nodes) if (node.data) this.keys.set(node.ino, node.data);
      this.committedKeys = new Map(this.keys);
    } else this.dirty.add(fs.root);
    fs.onLinkChange = (node, delta) => this.changeLinks(node, delta);
    fs.onChange = node => { if (!this.detached.has(node)) { this.nodes.set(node.ino, node); this.dirty.add(node); } };
    if (intervalMs > 0) this.timer = setInterval(() => {
      if (!this.stopped && !this.pendingCheckpoints) void this.flush().catch(() => { /* explicit flush reports/retries failures */ });
    }, intervalMs);
  }
  static async open(storage: StorageBackend, options: { intervalMs?: number } = {}): Promise<PersistentBackend> {
    const index = await storage.load();
    if (!index) return new PersistentBackend(storage, new MemFS(), undefined, options.intervalMs);
    const nodes = new Map<number, Node>();
    for (const entry of index.nodes) nodes.set(entry.ino, entry.kind === "dir"
      ? { kind: "dir", ino: entry.ino, mtime: entry.mtime, children: new Map() }
      : { kind: "file", ino: entry.ino, mtime: entry.mtime, size: entry.size, data: new Uint8Array() });
    for (const entry of index.nodes) if (entry.kind === "dir") {
      const node = nodes.get(entry.ino) as DirNode;
      for (const [name, ino] of entry.children ?? []) {
        const child = nodes.get(ino);
        if (!child) throw new Error(`persisted filesystem references missing inode ${ino}`);
        node.children.set(name, child);
      }
    }
    const root = nodes.get(index.root);
    if (root?.kind !== "dir") throw new Error("persisted filesystem has no root directory");
    adoptInodes(root);
    return new PersistentBackend(storage, new MemFS(root), index, options.intervalMs);
  }
  private changeLinks(node: Node, delta: 1 | -1): void {
    const previous = this.links.get(node.ino) ?? 0;
    const count = previous + delta;
    if (count > 0) this.links.set(node.ino, count);
    else this.links.delete(node.ino);
    if (delta === 1 && previous === 0) {
      this.nodes.set(node.ino, node); this.detached.delete(node);
      const key = this.detachedKeys.get(node.ino);
      if (key) {
        // The namespace entry is new, but this payload is already durable. Restore its
        // rollback baseline too, so a failed reattachment checkpoint can retry cold.
        this.keys.set(node.ino, key); this.committedKeys.set(node.ino, key);
        this.detachedKeys.delete(node.ino);
      }
      this.removed.delete(node.ino); this.dirty.add(node);
      if (node.kind === "dir") for (const child of node.children.values()) this.changeLinks(child, 1);
    } else if (delta === -1 && count === 0) {
      this.nodes.delete(node.ino); this.dirty.delete(node); this.detached.add(node);
      this.removed.add(node.ino);
      if (node.kind === "dir") for (const child of node.children.values()) this.changeLinks(child, -1);
    }
  }
  protected isLinked(node: Node): boolean { return this.nodes.has(node.ino); }
  /** Dead handles are no longer enumerable in shared memory; prune their private owners too. */
  private pruneDetached(): void {
    for (const [handle, node] of this.registeredNodes) if (this.shared.revision(handle) === undefined) {
      this.registeredNodes.delete(handle); this.revisions.delete(handle);
      if (this.detached.has(node)) { this.keys.delete(node.ino); this.detachedKeys.delete(node.ino); }
    }
  }
  private retainedData(): string[] {
    const keys: string[] = [];
    for (const [handle, node] of this.registeredNodes) if (this.detached.has(node) && this.shared.revision(handle) !== undefined) {
      const key = this.committedKeys.get(node.ino) ?? this.detachedKeys.get(node.ino);
      if (key) keys.push(key);
    }
    return keys;
  }
  protected sync(handle: FileHandle): void {
    const node = this.fs.nodeForHandle(handle);
    this.registeredNodes.set(handle, node);
    if (node.kind === "dir") { super.sync(handle); return; }
    const registered = this.shared.hasFile(handle);
    const loaded = node.size === undefined;
    this.shared.register(handle, this.fs.stat(handle), node.data, loaded);
    if (!registered && loaded) {
      // The page pool owns the only mutable payload. Retaining initial MemFS buffers doubles
      // workspace memory and, after direct writes, would retain an obsolete second copy.
      node.size = node.data.length;
      node.data = new Uint8Array();
    }
    if (!registered && !loaded) {
      const revision = this.shared.revision(handle);
      if (revision !== undefined) this.revisions.set(handle, revision);
    }
  }
  private evictClean(except?: FileHandle): void {
    // Registration is bounded independently of workspace size. Idle metadata and clean payload
    // slots may be reclaimed; held capabilities keep their identity and dirty bytes stay resident.
    for (const handle of this.shared.registeredHandles()) {
      if (handle === except || this.loading.has(handle)) continue;
      const revision = this.shared.revision(handle);
      const stat = this.shared.stat(handle);
      if (!stat || revision === undefined) continue;
      const node = this.registeredNodes.get(handle);
      if (!node) continue;
      if (node.kind === "dir") { if (this.shared.evict(handle, revision)) this.registeredNodes.delete(handle); continue; }
      if (this.revisions.get(handle) !== revision) continue;
      if (this.shared.isResident(handle) && this.keys.get(node.ino) !== this.committedKeys.get(node.ino)) continue;
      if (this.shared.evict(handle, revision)) {
        node.size = stat.size; node.mtime = stat.mtime;
        this.revisions.delete(handle); this.registeredNodes.delete(handle);
      } else this.shared.unload(handle, revision);
    }
  }
  private ensureLoaded(handle: FileHandle): void | Promise<void> {
    const node = this.fs.nodeForHandle(handle);
    if (node.kind !== "file") return;
    this.sync(handle);
    if (this.shared.isResident(handle)) return;
    const pending = this.loading.get(handle);
    if (pending) return pending;
    const key = this.detachedKeys.get(node.ino) ?? this.keys.get(node.ino);
    const revision = this.shared.revision(handle);
    // The asynchronous preparation owns a pin independently of the requesting capability.
    // A namespace replacement, cancellation or trim may otherwise reclaim its slot mid-read.
    this.retain(handle);
    const load = Promise.resolve().then(async () => {
      const data = key ? await this.storage.read(key) : new Uint8Array();
      // A complete overwrite/truncate may have made this disk read obsolete. Never install
      // an old payload over newer shared bytes or metadata, even for the same inode.
      if (this.registeredNodes.get(handle) !== node || this.shared.revision(handle) !== revision || this.shared.isResident(handle)) return;
      if (data.length !== node.size) throw new Error(`persisted filesystem payload size mismatch for inode ${node.ino}`);
      const resources = this.shared.resources();
      if (resources.usedBytes + data.length > resources.maxBytes) this.evictClean(handle);
      // Registration already records the clean revision. Hydration preserves it; sampling
      // after hydrate unlocks could misclassify another guest's immediate write as clean.
      this.shared.hydrate(handle, data);
    }).finally(() => { this.loading.delete(handle); this.release(handle); });
    this.loading.set(handle, load);
    return load;
  }
  prepare(operation: string, args: any[]): void | Promise<void> {
    if (this.stopped) throw new Error("filesystem persistence backend is closed");
    const target = ["read", "write", "append", "grow", "resize"].includes(operation) ? args[0]
      : operation === "readFile" || operation === "writeFile" ? this.fs.lookup(args[0]) : undefined;
    const handle = typeof target === "number" ? target : target?.kind === "file" ? this.fs.handleForNode(target) : undefined;
    const resources = this.shared.resources();
    if (resources.files > 1024 || resources.usedBytes >= resources.maxBytes / 2) this.evictClean(handle);
    if (["read", "write", "append", "grow", "resize"].includes(operation)) {
      if (operation === "resize" && args[1] === 0 && args[2]) this.sync(args[0]);
      else return this.ensureLoaded(args[0]);
    }
    if (operation === "readFile" || operation === "writeFile") {
      const node = this.fs.lookup(args[0]);
      if (node?.kind === "file") {
        const handle = this.fs.handleForNode(node);
        if (operation === "writeFile" && !args[1]) this.sync(handle);
        else return this.ensureLoaded(handle);
      }
    }
  }
  execute(operation: string, args: any[], data: Uint8Array): unknown {
    if (operation === "lookup") {
      const node = this.fs.lookup(args[0]);
      if (!node) return undefined;
      const metadata = (entry: Node) => {
        const handle = this.fs.handleForNode(entry);
        const stat = this.shared.stat(handle);
        return { kind: entry.kind, ino: entry.ino, mtime: stat?.mtime ?? entry.mtime };
      };
      return node.kind === "file" ? metadata(node) : { ...metadata(node), children: new Map(Array.from(node.children, ([name, child]) => [name, metadata(child)])) };
    }
    return super.execute(operation, args, data);
  }
  /** Capture only dirty nodes and changed resident payloads. Cost is bounded by the shared
   * slot table plus changes, not by the number of cold files in a workspace. */
  flush(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("filesystem persistence backend is closed"));
    this.pruneDetached();
    const changed = new Set(this.dirty);
    const data = new Map<string, Uint8Array>();
    this.shared.mutate(undefined, undefined, () => {
      for (const handle of this.shared.registeredHandles()) {
        const revision = this.shared.revision(handle);
        if (revision === undefined || revision === this.revisions.get(handle)) continue;
        const node = this.registeredNodes.get(handle);
        if (node?.kind !== "file" || this.detached.has(node)) continue;
        const stat = this.shared.stat(handle);
        if (!stat) continue;
        node.size = stat.size; node.mtime = stat.mtime;
        const snapshot = this.shared.snapshot(handle);
        if (snapshot) {
          const key = `${this.nonce}:${node.ino}:${++this.sequence}`;
          data.set(key, snapshot.data); this.keys.set(node.ino, key);
        }
        this.revisions.set(handle, revision);
        changed.add(node);
      }
    });
    const upserts: PersistedNode[] = Array.from(changed, node => node.kind === "dir"
      ? { ino: node.ino, kind: "dir", mtime: node.mtime, size: 0, children: Array.from(node.children, ([name, child]) => [name, child.ino]) }
      : { ino: node.ino, kind: "file", mtime: node.mtime, size: node.size ?? node.data.length, data: this.keys.get(node.ino) });
    this.dirty.clear();
    const removes = Array.from(this.removed); this.removed.clear();
    if (!upserts.length && !removes.length) return this.lastCommit.then(() => this.storage.flush());
    const epoch = this.checkpointEpoch;
    const batch: PersistenceBatch = { generation: 0, root: this.fs.root.ino, upserts, removes, data };
    this.pendingCheckpoints++;
    const commit = this.tail.then(async () => {
      if (epoch !== this.checkpointEpoch) throw new Error("filesystem checkpoint invalidated by a failed commit");
      batch.generation = this.generation + 1;
      // A later request may have reattached an inode removed by this older checkpoint.
      // Its next upsert still needs the durable payload even though it is no longer detached.
      batch.retainedData = this.retainedData().concat(removes.flatMap(ino => {
        const key = this.committedKeys.get(ino);
        return this.nodes.has(ino) && key ? [key] : [];
      }));
      await this.storage.persist(batch);
      await this.storage.flush();
      this.generation = batch.generation;
      for (const entry of upserts) if (entry.data) this.committedKeys.set(entry.ino, entry.data);
      this.pruneDetached();
      const retained = new Set(this.retainedData());
      for (const ino of removes) {
        if (this.nodes.has(ino)) continue; // A later link still owns this durable baseline.
        const key = this.committedKeys.get(ino);
        if (key && retained.has(key)) this.detachedKeys.set(ino, key);
        this.committedKeys.delete(ino);
        this.keys.delete(ino);
      }
    }).finally(() => { this.pendingCheckpoints--; });
    this.lastCommit = commit;
    this.tail = commit.catch(() => {
      this.checkpointEpoch++;
      for (const node of changed) if (!this.detached.has(node)) this.dirty.add(node);
      // A later request may have linked an open inode back into the namespace while
      // this commit waited. Retry the current tree, not the failed checkpoint's removals.
      for (const ino of removes) if (!this.nodes.has(ino)) this.removed.add(ino);
      this.keys = new Map(this.committedKeys);
      this.revisions.clear();
    });
    return commit;
  }
  dispose(): void { this.stopped = true; if (this.timer !== undefined) clearInterval(this.timer); }
  async close(): Promise<void> { try { await this.flush(); } finally { this.dispose(); await this.storage.close(); } }
}
