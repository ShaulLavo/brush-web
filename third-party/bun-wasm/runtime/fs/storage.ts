/** Durable inode metadata. Payload keys are immutable, including across snapshots. */
export interface PersistedNode {
  ino: number;
  kind: "file" | "dir";
  mtime: number;
  size: number;
  children?: [string, number][];
  data?: string;
}

export interface PersistedIndex {
  version: 1;
  generation: number;
  root: number;
  nodes: PersistedNode[];
}

/** One logical generation. Unchanged inode and immutable payload identities are preserved. */
export interface PersistenceBatch {
  generation: number;
  root: number;
  upserts: PersistedNode[];
  removes: number[];
  data: Map<string, Uint8Array>;
  /** Runtime-only pins, for example cold open-but-unlinked files. Never restored on reload. */
  retainedData?: string[];
}

export interface StorageBackend {
  load(): Promise<PersistedIndex | undefined>;
  read(key: string): Promise<Uint8Array>;
  persist(batch: PersistenceBatch): Promise<void>;
  /** Make the selected immutable payloads durable; omitted means all outstanding payloads. */
  flush(keys?: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export interface ChecksummedRecord { json: string; checksum: string }

function invalid(): never { throw new Error("Invalid persisted filesystem metadata"); }
export function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validatePersistedNode(value: unknown): asserts value is PersistedNode {
  if (!value || typeof value !== "object") invalid();
  const node = value as PersistedNode;
  if (!validInteger(node.ino) || !validInteger(node.size) || !Number.isFinite(node.mtime)) invalid();
  if (node.kind === "file") {
    if (node.children !== undefined || (node.data !== undefined && (typeof node.data !== "string" || !node.data))
      || (node.size > 0 && node.data === undefined)) invalid();
  } else if (node.kind === "dir") {
    if (node.data !== undefined || !Array.isArray(node.children)) invalid();
    const names = new Set<string>();
    for (const entry of node.children) {
      if (!Array.isArray(entry) || entry.length !== 2) invalid();
      const [name, ino] = entry;
      if (typeof name !== "string" || !name || name === "." || name === ".." || /[\/\0]/.test(name)
        || !validInteger(ino) || names.has(name)) invalid();
      names.add(name);
    }
  } else invalid();
}

export function validatePersistedIndex(value: unknown): asserts value is PersistedIndex {
  if (!value || typeof value !== "object") invalid();
  const index = value as PersistedIndex;
  if (index.version !== 1 || !validInteger(index.generation) || !validInteger(index.root) || !Array.isArray(index.nodes)) invalid();
  const nodes = new Map<number, PersistedNode>();
  for (const node of index.nodes) {
    validatePersistedNode(node);
    if (nodes.has(node.ino)) invalid();
    nodes.set(node.ino, node);
  }
  if (nodes.get(index.root)?.kind !== "dir") invalid();
  const seen = new Set<number>();
  const pending = [index.root];
  while (pending.length) {
    const ino = pending.pop()!;
    const node = nodes.get(ino);
    if (!node) invalid();
    if (seen.has(ino)) {
      if (node.kind === "dir") invalid();
      continue;
    }
    seen.add(ino);
    if (node.kind === "dir") for (const [, child] of node.children!) pending.push(child);
  }
  if (seen.size !== nodes.size) invalid();
}

async function checksum(json: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function encodeRecord(value: unknown): Promise<ChecksummedRecord> {
  const json = JSON.stringify(value);
  return { json, checksum: await checksum(json) };
}

export async function decodeRecord(value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object") return undefined;
  const record = value as ChecksummedRecord;
  if (typeof record.json !== "string" || typeof record.checksum !== "string"
    || await checksum(record.json) !== record.checksum) return undefined;
  try { return JSON.parse(record.json); } catch { return undefined; }
}

export async function encodeSnapshot(index: PersistedIndex): Promise<ChecksummedRecord> {
  validatePersistedIndex(index);
  return encodeRecord(index);
}

export async function decodeSnapshot(value: unknown): Promise<PersistedIndex | undefined> {
  const index = await decodeRecord(value);
  try { validatePersistedIndex(index); return index; } catch { return undefined; }
}
