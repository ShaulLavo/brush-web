import {
  decodeRecord, decodeSnapshot, encodeRecord, encodeSnapshot, validatePersistedIndex,
  validatePersistedNode, validInteger,
  type PersistenceBatch, type PersistedIndex, type PersistedNode, type StorageBackend,
} from "./storage";

/** The subset of Web Locks needed by this backend; injectable without an unsafe fallback. */
export interface StorageLockManager {
  request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>): Promise<T>;
}
export interface IndexedDBStorageOptions {
  indexedDB?: IDBFactory;
  locks?: StorageLockManager;
  /** Number of incremental saves between full snapshots. */
  compactEvery?: number;
}
interface Journal {
  version: 1;
  previous: number;
  generation: number;
  root: number;
  upserts: PersistedNode[];
  removes: number[];
}
interface TreeState {
  generation: number;
  root: number;
  nodes: Map<number, PersistedNode>;
  references: Map<number, number>;
  parents: Map<number, number>;
}
interface State extends TreeState {
  bases: [PersistedIndex | undefined, PersistedIndex | undefined];
  journals: Map<number, Journal>;
  journalKeys: IDBValidKey[];
  payloadKeys: Set<string>;
  sinceCompaction: number;
}
function metadataError(): never { throw new Error("Invalid persisted filesystem metadata"); }
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
function payloads(nodes: Iterable<PersistedNode>, keys: Set<string>): void {
  for (const node of nodes) if (node.data !== undefined) keys.add(node.data);
}
function hasPayloads(index: PersistedIndex, keys: ReadonlySet<string>): boolean {
  return index.nodes.every(node => node.data === undefined || keys.has(node.data));
}
function referenceIndex(nodes: Iterable<PersistedNode>): Pick<State, "references" | "parents"> {
  const references = new Map<number, number>(), parents = new Map<number, number>();
  for (const node of nodes) for (const [, ino] of node.children ?? []) {
    references.set(ino, (references.get(ino) ?? 0) + 1); parents.set(ino, node.ino);
  }
  return { references, parents };
}
function validateJournal(value: unknown): value is Journal {
  try {
    if (!value || typeof value !== "object") return false;
    const entry = value as Journal;
    if (entry.version !== 1 || !validInteger(entry.previous) || !validInteger(entry.generation)
      || entry.generation <= entry.previous || !validInteger(entry.root)
      || !Array.isArray(entry.upserts) || !Array.isArray(entry.removes)) return false;
    const seen = new Set<number>();
    for (const node of entry.upserts) {
      validatePersistedNode(node);
      if (seen.has(node.ino)) return false;
      seen.add(node.ino);
    }
    for (const ino of entry.removes) { if (!validInteger(ino) || seen.has(ino)) return false; seen.add(ino); }
    return true;
  } catch { return false; }
}

interface StagedChanges {
  upserts: Map<number, PersistedNode>;
  removes: Set<number>;
  references: Map<number, number>;
  parents: Map<number, number | undefined>;
}

/** Validate just the changed edges/inodes. Full-tree work is reserved for startup and compaction. */
function stageChanges(state: TreeState | undefined, batch: Pick<PersistenceBatch, "generation" | "root" | "upserts" | "removes">): StagedChanges {
  if (!validInteger(batch.generation) || (state && batch.generation <= state.generation)) throw new Error("Filesystem generation must increase");
  if (!validInteger(batch.root)) metadataError();
  const upserts = new Map<number, PersistedNode>(), removes = new Set<number>();
  for (const node of batch.upserts) {
    validatePersistedNode(node);
    if (upserts.has(node.ino)) metadataError();
    upserts.set(node.ino, node);
  }
  for (const ino of batch.removes) {
    if (!validInteger(ino) || removes.has(ino) || upserts.has(ino)) metadataError();
    removes.add(ino);
  }
  const nodeAt = (ino: number) => removes.has(ino) ? undefined : upserts.get(ino) ?? state?.nodes.get(ino);
  if (nodeAt(batch.root)?.kind !== "dir") metadataError();
  const references = new Map<number, number>(), parents = new Map<number, number | undefined>();
  const adjust = (ino: number, delta: number) => references.set(ino, (references.get(ino) ?? state?.references.get(ino) ?? 0) + delta);
  for (const ino of Array.from(upserts.keys()).concat(Array.from(removes))) {
    for (const [, child] of state?.nodes.get(ino)?.children ?? []) { adjust(child, -1); parents.set(child, undefined); }
  }
  for (const node of upserts.values()) for (const [, child] of node.children ?? []) {
    adjust(child, 1); parents.set(child, node.ino);
  }
  const touched = new Set(Array.from(upserts.keys()).concat(Array.from(removes), Array.from(references.keys()), [batch.root]));
  if (state) touched.add(state.root);
  for (const ino of touched) {
    const node = nodeAt(ino), count = references.get(ino) ?? state?.references.get(ino) ?? 0;
    if (!node) { if (count !== 0) metadataError(); continue; }
    if (ino === batch.root) { if (node.kind !== "dir" || count !== 0) metadataError(); }
    else if (count < 1 || (node.kind === "dir" && count !== 1)) metadataError();
    if (node.kind === "dir") {
      const seen = new Set<number>(); let current: number | undefined = ino;
      while (current !== batch.root) {
        if (current === undefined || seen.has(current)) metadataError();
        seen.add(current);
        current = parents.has(current) ? parents.get(current) : state?.parents.get(current);
      }
    }
  }
  return { upserts, removes, references, parents };
}

function applyChanges(state: TreeState, staged: StagedChanges, generation: number, root: number): void {
  for (const ino of staged.removes) state.nodes.delete(ino);
  for (const [ino, node] of staged.upserts) state.nodes.set(ino, node);
  for (const [ino, count] of staged.references) {
    if (count) state.references.set(ino, count); else state.references.delete(ino);
  }
  for (const [ino, parent] of staged.parents) {
    if (parent === undefined) state.parents.delete(ino); else state.parents.set(ino, parent);
  }
  state.generation = generation; state.root = root;
}

/** Recover newest-first, copying the full tree only for a candidate with a complete chain. */
export function recoverIndex(bases: readonly (PersistedIndex | undefined)[], journals: ReadonlyMap<number, Journal>,
  payloadKeys: ReadonlySet<string>): PersistedIndex | undefined {
  const generations = Array.from(new Set(Array.from(journals.keys()).concat(
    bases.flatMap(base => base ? [base.generation] : []))));
  generations.sort((a, b) => b - a);
  for (const generation of generations) {
    let current = generation;
    let base = bases.find(base => base?.generation === current);
    const chain: Journal[] = [];
    while (!base) {
      const entry = journals.get(current);
      if (!entry || entry.previous >= current || !entry.upserts.every(node => node.data === undefined || payloadKeys.has(node.data))) break;
      chain.push(entry); current = entry.previous;
      base = bases.find(base => base?.generation === current);
    }
    if (!base) continue;
    const nodes = new Map(base.nodes.map(node => [node.ino, node]));
    const tree: TreeState = { generation: base.generation, root: base.root, nodes, ...referenceIndex(nodes.values()) };
    chain.reverse();
    try {
      for (const entry of chain) applyChanges(tree, stageChanges(tree, entry), entry.generation, entry.root);
      const index: PersistedIndex = { version: 1, generation: tree.generation, root: tree.root, nodes: Array.from(nodes.values()) };
      validatePersistedIndex(index);
      return index;
    } catch { /* Invalid graph: try the next older committed chain, never an empty tree. */ }
  }
  return undefined;
}

/** One lock-owning connection. Writes are strict atomic transactions, never in-place payload edits. */
export class IndexedDBStorage implements StorageBackend {
  private tail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private initialized = false;
  private state?: State;
  private closed = false;
  private closing?: Promise<void>;

  private constructor(private readonly db: IDBDatabase, private readonly unlock: () => Promise<void>,
    private readonly compactEvery: number) {
    db.onversionchange = () => { void this.close(); };
  }

  static async open(name: string, options: IndexedDBStorageOptions = {}): Promise<IndexedDBStorage> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const locks: StorageLockManager | undefined = options.locks ?? globalThis.navigator?.locks;
    const compactEvery = options.compactEvery ?? 128;
    if (!factory || !locks) throw new Error("IndexedDB storage requires IndexedDB and Web Locks");
    if (!Number.isSafeInteger(compactEvery) || compactEvery < 1) throw new Error("Invalid compaction interval");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let acquired!: () => void, refused!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; refused = reject; });
    const lifetime = locks.request(`bun-wasm:filesystem:${name}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (lock === null) { refused(new Error("Filesystem already has a writer in another tab")); return; }
      acquired(); await held;
    });
    void lifetime.catch(refused);
    await ready;
    const unlock = async () => { release(); await lifetime; };
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = factory.open(name, 1);
        let blocked = false;
        opening.onupgradeneeded = () => {
          for (const store of ["metadata", "journal", "data"]) opening.result.createObjectStore(store);
        };
        opening.onsuccess = () => { if (blocked) opening.result.close(); else resolve(opening.result); };
        opening.onerror = () => reject(opening.error ?? new Error("Cannot open filesystem storage"));
        opening.onblocked = () => { blocked = true; reject(new Error("Filesystem database upgrade is blocked")); };
      });
      return new IndexedDBStorage(db, unlock, compactEvery);
    } catch (error) { await unlock(); throw error; }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Filesystem storage is closed"));
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  load(): Promise<PersistedIndex | undefined> {
    return this.enqueue(async () => {
      await this.initialize();
      return this.state && structuredClone(this.index(this.state));
    });
  }

  read(key: string): Promise<Uint8Array> {
    return this.enqueue(async () => {
      await this.initialize();
      const tx = this.db.transaction("data", "readonly");
      const [data] = await Promise.all([request(tx.objectStore("data").get(key)), completed(tx)]);
      if (!(data instanceof Uint8Array)) throw new Error(`Missing filesystem payload: ${key}`);
      return data;
    });
  }

  persist(batch: PersistenceBatch): Promise<void> {
    // Snapshot at submission, not when this operation reaches the asynchronous write queue.
    let copy: PersistenceBatch;
    try { copy = { ...structuredClone({ generation: batch.generation, root: batch.root,
      upserts: batch.upserts, removes: batch.removes, retainedData: batch.retainedData }),
      data: new Map(Array.from(batch.data, ([key, bytes]) => [key, new Uint8Array(bytes)])) }; }
    catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      try { await this.initialize(); await this.commit(copy); this.persistenceError = undefined; }
      catch (error) { this.persistenceError = error; throw error; }
    });
  }

  async flush(): Promise<void> {
    if (this.closed) throw new Error("Filesystem storage is closed");
    await this.tail;
    if (this.persistenceError !== undefined) throw this.persistenceError;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.tail.then(async () => { this.db.close(); await this.unlock(); });
    }
    return this.closing;
  }

  private index(state: State): PersistedIndex {
    return { version: 1, generation: state.generation, root: state.root, nodes: Array.from(state.nodes.values()) };
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const tx = this.db.transaction(["metadata", "journal", "data"], "readonly");
    const metadata = tx.objectStore("metadata"), journal = tx.objectStore("journal");
    const [first, second, metadataCount, journalValues, journalKeys, dataKeys] = await Promise.all([
      request(metadata.get(0)), request(metadata.get(1)), request(metadata.count()),
      request(journal.getAll()), request(journal.getAllKeys()), request(tx.objectStore("data").getAllKeys()), completed(tx),
    ]);
    const payloadKeys = new Set(dataKeys.filter((key): key is string => typeof key === "string"));
    const decoded = await Promise.all([decodeSnapshot(first), decodeSnapshot(second)]);
    const bases: State["bases"] = [decoded[0], decoded[1]];
    for (const slot of [0, 1] as const) if (bases[slot] && !hasPayloads(bases[slot]!, payloadKeys)) bases[slot] = undefined;
    const journals = new Map<number, Journal>();
    await Promise.all(journalValues.map(async (value, i) => {
      const entry = await decodeRecord(value);
      if (validateJournal(entry) && entry.generation === journalKeys[i]) journals.set(entry.generation, entry);
    }));
    const newest = recoverIndex(bases, journals, payloadKeys);
    if (!newest && (metadataCount > 0 || journalKeys.length > 0 || dataKeys.length > 0)) {
      throw new Error("Existing filesystem storage is corrupt; no valid snapshot can be recovered");
    }
    if (newest) {
      const nodes = new Map(newest.nodes.map(node => [node.ino, node]));
      const lastBase = Math.max(...bases.filter((base): base is PersistedIndex => !!base).map(base => base.generation));
      this.state = { generation: newest.generation, root: newest.root, nodes, ...referenceIndex(nodes.values()), bases,
        journals, journalKeys, payloadKeys, sinceCompaction: Array.from(journals.values()).filter(entry => entry.generation > lastBase).length };
    }
    this.initialized = true;
  }


  private async commit(batch: PersistenceBatch): Promise<void> {
    const staged = stageChanges(this.state, batch), old = this.state;
    // A recovered generation may be reused. Its abandoned successors must not reconnect
    // to the replacement journal, or an old edit could become current again on reload.
    const discarded = new Set(old?.journalKeys.filter(key => typeof key !== "number" || key > old.generation));
    const compact = !old || old.sinceCompaction + 1 >= this.compactEvery;
    const entry: Journal | undefined = old && { version: 1, previous: old.generation, generation: batch.generation,
      root: batch.root, upserts: batch.upserts, removes: batch.removes };
    const encodedJournal = entry && await encodeRecord(entry);
    let snapshot: PersistedIndex | undefined;
    const bases: State["bases"] = old ? [old.bases[0], old.bases[1]] : [undefined, undefined];
    let slot: 0 | 1 = 0;
    if (compact) {
      const nodes = new Map(old?.nodes);
      for (const ino of staged.removes) nodes.delete(ino);
      for (const [ino, node] of staged.upserts) nodes.set(ino, node);
      snapshot = { version: 1, generation: batch.generation, root: batch.root, nodes: Array.from(nodes.values()) };
      validatePersistedIndex(snapshot);
      slot = !bases[0] ? 0 : !bases[1] ? 1 : bases[0].generation <= bases[1].generation ? 0 : 1;
      bases[slot] = snapshot;
    }
    const encodedSnapshot = snapshot && await encodeSnapshot(snapshot);
    const expected = new Map<string, number>();
    for (const node of staged.upserts.values()) if (node.data !== undefined) {
      const size = expected.get(node.data);
      if (size !== undefined && size !== node.size) metadataError();
      expected.set(node.data, node.size);
    }
    const checking = new Set(Array.from(expected.keys()).concat(Array.from(batch.data.keys())));
    const pinChecks = new Set(batch.retainedData?.filter(key => !checking.has(key)));
    let cutoff = -1;
    const retained = new Set(batch.retainedData);
    if (compact) {
      cutoff = Math.min(...bases.filter((base): base is PersistedIndex => !!base).map(base => base.generation));
      for (const base of bases) if (base) payloads(base.nodes, retained);
      for (const journal of old?.journals.values() ?? []) {
        if (journal.generation > cutoff && !discarded.has(journal.generation)) payloads(journal.upserts, retained);
      }
      if (entry && entry.generation > cutoff) payloads(entry.upserts, retained);
    }
    // No await inside this transaction: all hashes and compaction preparation are complete.
    const tx = this.db.transaction(["metadata", "journal", "data"], "readwrite", { durability: "strict" });
    const data = tx.objectStore("data");
    await new Promise<void>((resolve, reject) => {
      let failure: unknown;
      const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch {} };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Filesystem transaction aborted"));
      const finish = () => {
        try {
          for (const key of discarded) tx.objectStore("journal").delete(key);
          for (const slot of [0, 1] as const) if (old && !old.bases[slot]) tx.objectStore("metadata").delete(slot);
          if (encodedJournal) tx.objectStore("journal").put(encodedJournal, batch.generation);
          if (encodedSnapshot) tx.objectStore("metadata").put(encodedSnapshot, slot);
          tx.objectStore("metadata").put(batch.generation, "active");
          if (compact) {
            for (const key of old?.journalKeys ?? []) if (typeof key === "number" && key <= cutoff) tx.objectStore("journal").delete(key);
            for (const key of Array.from(old?.payloadKeys ?? []).concat(Array.from(batch.data.keys()))) if (!retained.has(key)) data.delete(key);
          }
        } catch (error) { abort(error); }
      };
      let remaining = checking.size + pinChecks.size;
      try {
        if (!remaining) finish();
        for (const key of checking) {
          const get = data.get(key);
          get.onsuccess = () => {
            try {
              const existing: unknown = get.result, supplied = batch.data.get(key);
              if (existing !== undefined && !(existing instanceof Uint8Array)) throw new Error(`Invalid immutable payload: ${key}`);
              if (existing instanceof Uint8Array && supplied && (existing.length !== supplied.length
                || existing.some((byte, i) => byte !== supplied[i]))) throw new Error(`Cannot overwrite immutable filesystem payload: ${key}`);
              const bytes = existing ?? supplied;
              if (!(bytes instanceof Uint8Array)) throw new Error(`Missing filesystem payload: ${key}`);
              if (expected.has(key) && expected.get(key) !== bytes.length) throw new Error(`Invalid filesystem payload size: ${key}`);
              if (existing === undefined) data.put(bytes, key);
              if (--remaining === 0) finish();
            } catch (error) { abort(error); }
          };
        }
        // Pinning cold open-but-unlinked files must never materialize their payloads.
        for (const key of pinChecks) {
          const get = data.getKey(key);
          get.onsuccess = () => {
            if (get.result === undefined) abort(new Error(`Missing filesystem payload: ${key}`));
            else if (--remaining === 0) finish();
          };
        }
      } catch (error) { abort(error); }
    });
    const state: State = old ?? { generation: batch.generation, root: batch.root, nodes: new Map(), references: new Map(),
      parents: new Map(), bases, journals: new Map(), journalKeys: [], payloadKeys: new Set(), sinceCompaction: 0 };
    for (const key of discarded) if (typeof key === "number") state.journals.delete(key);
    state.journalKeys = state.journalKeys.filter(key => !discarded.has(key));
    applyChanges(state, staged, batch.generation, batch.root);
    state.bases = bases;
    if (entry) { state.journals.set(entry.generation, entry); state.journalKeys.push(entry.generation); }
    for (const key of batch.data.keys()) state.payloadKeys.add(key);
    if (compact) {
      for (const key of state.journals.keys()) if (key <= cutoff) state.journals.delete(key);
      state.journalKeys = state.journalKeys.filter(key => typeof key !== "number" || key > cutoff);
      for (const key of state.payloadKeys) if (!retained.has(key)) state.payloadKeys.delete(key);
    }
    state.sinceCompaction = compact ? 0 : state.sinceCompaction + 1;
    this.state = state;
  }
}
