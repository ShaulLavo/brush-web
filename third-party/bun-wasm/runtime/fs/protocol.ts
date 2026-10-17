// Original shared-memory protocol. Ports schedule work; request/response bytes and completion
// state live in the SAB. The service never waits on a guest, including a terminated one.
// Guest browser-engine polyfills replace MessageChannel; transport endpoints must stay native.
const NativeMessageChannel = globalThis.MessageChannel;
export const DEFAULT_SHARED_MAX_BYTES = 1024 * 1024 * 1024;
export const SHARED_SEGMENT_BYTES = 16 * 1024 * 1024;
export const MAX_SHARED_SEGMENTS = DEFAULT_SHARED_MAX_BYTES / SHARED_SEGMENT_BYTES;
export type GrowableSharedSegment = SharedArrayBuffer & {
  readonly growable: boolean;
  readonly maxByteLength: number;
  grow(byteLength: number): void;
};
export function createSharedSegment(): GrowableSharedSegment {
  // The runtime supports growable SABs; ES2022's library declarations do not yet expose them.
  const Constructor = SharedArrayBuffer as unknown as new (bytes: number, options: { maxByteLength: number }) => GrowableSharedSegment;
  return new Constructor(0, { maxByteLength: SHARED_SEGMENT_BYTES });
}
export function normalizeSharedMaxBytes(maxBytes: number): number {
  if (Number.isNaN(maxBytes)) throw new RangeError("invalid shared filesystem storage cap");
  return Math.max(1, Math.min(MAX_SHARED_SEGMENTS, Math.floor(maxBytes / SHARED_SEGMENT_BYTES))) * SHARED_SEGMENT_BYTES;
}
export const HEADER = 32;
export const PAGE = 64 * 1024;
export const TRANSIENT_HANDLES = 256;
export const CAPABILITY_SLOTS = 4096;
// One candidate-count word, then reusable [handle, open-reference count, transfer count] records. A negative
// reference count revokes an entry. Handles never recycle, but these per-session entries do.
export const CAPABILITY_HEADER = 1;
export const CAPABILITY_WORDS = 3;
const MAX_CONNECTION_OWNERS = 65536;
export const enum State { Pending, Complete, Cancelled, Failed, Overflow }
export class FilesystemError extends Error {
  constructor(public errno: number, message = `filesystem errno ${errno}`) { super(message); }
}
export interface FilesystemConnection {
  port: MessagePort;
  epoch: SharedArrayBuffer;
  signal: SharedArrayBuffer;
  /** This connection's revocation word, then its ancestors. Never reused. */
  revocations: SharedArrayBuffer[];
  shared: SharedArrayBuffer;
  /** Extra data segments, published before guests run; only the service grows their backing. */
  segments: SharedArrayBuffer[];
  /** Private to this connection, not its descendants: capabilities and local open references. */
  capabilities: SharedArrayBuffer;
  /** Active synchronous host filesystem sections, private to this connection. Never reused. */
  sections: SharedArrayBuffer;
  /** Nonzero lock owner token; service clears it when this identity is reaped. */
  owner: number;
  maxBytes: number;
  /** Service revocation in word 0, then per-owner liveness for independent process identities. */
  ownerStates: SharedArrayBuffer;
  /** Synchronous reservations adopted when this identity reaches the service. */
  reservations: FilesystemReservation[];
}
export interface FilesystemReservation {
  handle: number;
  source: SharedArrayBuffer;
  sourceKey: number;
  target: SharedArrayBuffer;
  targetKey: number;
  targetOwner: number;
  /** Closed once; transfer state: 0 pending, 1 adopted, 2 cancelled. */
  state: SharedArrayBuffer;
}
export type FilesystemIdentity = Omit<FilesystemConnection, "port">;
/** Guests can allocate a child identity while blocked; its controller creates the ports.
 * Firefox does not activate guest-created channels until that guest returns to its event loop.
 */
export function createFilesystemIdentity(parent?: FilesystemIdentity, maxBytes = DEFAULT_SHARED_MAX_BYTES): FilesystemIdentity {
  maxBytes = parent?.maxBytes ?? normalizeSharedMaxBytes(maxBytes);
  const shared = parent?.shared ?? new SharedArrayBuffer(24 * 1024 * 1024);
  const segments = parent?.segments ?? Array.from({ length: maxBytes / SHARED_SEGMENT_BYTES - 1 }, () => createSharedSegment());
  const owner = Atomics.add(new Int32Array(shared), 5, 1) + 1;
  if (owner >= MAX_CONNECTION_OWNERS) throw new FilesystemError(33, "filesystem identity table exhausted");
  const ownerStates = parent?.ownerStates ?? new SharedArrayBuffer(MAX_CONNECTION_OWNERS * 4);
  const capabilities = new SharedArrayBuffer((CAPABILITY_HEADER + CAPABILITY_SLOTS * CAPABILITY_WORDS) * 4);
  const entries = new Int32Array(capabilities);
  entries.fill(-1);
  entries[0] = 0;
  return {
    epoch: parent?.epoch ?? new SharedArrayBuffer(4),
    // Every descendant waits here too, so root revocation can wake blocked guests after a crash.
    signal: parent?.signal ?? new SharedArrayBuffer(4),
    revocations: [new SharedArrayBuffer(4)].concat(parent?.revocations ?? []),
    shared,
    segments,
    capabilities,
    sections: new SharedArrayBuffer(4),
    owner,
    maxBytes,
    ownerStates,
    reservations: [],
  };
}
/** Processes share storage, not the lifetime of the process that spawned them. */
export function createProcessFilesystemIdentity(parent: FilesystemIdentity): FilesystemIdentity {
  const identity = createFilesystemIdentity(parent);
  identity.revocations = identity.revocations.slice(0, 1);
  return identity;
}
/** Idempotent across the controller and guest copies of a transferred description. */
export function releaseFilesystemReservation(reservation: FilesystemReservation): void {
  const state = new Int32Array(reservation.state);
  if (Atomics.exchange(state, 0, 1)) return;
  const target = new Int32Array(reservation.target);
  for (;;) {
    const count = Atomics.load(target, reservation.targetKey + 1);
    if (count <= 0 || Atomics.compareExchange(target, reservation.targetKey + 1, count, count - 1) === count) break;
  }
  if (Atomics.compareExchange(state, 1, 0, 2) === 0)
    Atomics.sub(new Int32Array(reservation.source), reservation.sourceKey + 2, 1);
}
export function connectFilesystemIdentity(identity: FilesystemIdentity) {
  const channel = new NativeMessageChannel();
  return { client: { ...identity, port: channel.port1 }, server: { ...identity, port: channel.port2 } };
}
export function createFilesystemConnection(parent?: FilesystemIdentity) {
  return connectFilesystemIdentity(createFilesystemIdentity(parent));
}
export function isRevoked(connection: FilesystemIdentity): boolean {
  if (Atomics.load(new Int32Array(connection.ownerStates), 0)) return true;
  return connection.revocations.some(buffer => Atomics.load(new Int32Array(buffer), 0) !== 0);
}
/** The service lifetime is shared even by processes with independent parent lifetimes. */
export function revokeFilesystemService(connection: FilesystemIdentity): void {
  Atomics.store(new Int32Array(connection.ownerStates), 0, 1);
  wake(connection);
}
export function revokeFilesystem(connection: FilesystemIdentity): void {
  Atomics.compareExchange(new Int32Array(connection.revocations[0]!), 0, 0, 1);
  Atomics.compareExchange(new Int32Array(connection.ownerStates), connection.owner, 0, 1);
  wake(connection);
}
/** Admission must precede every client lock, pin change or page write. The shared count handles
 * nested synchronous operations and multiple users of one identity. Never hold a section across
 * an await or a call into guest Wasm. Revocation is checked AFTER admission: the supervisor's
 * revoke-then-zero observation proves that any later entrant will abort before touching storage. */
export class FilesystemSection {
  private readonly cells: Int32Array;
  constructor(connection: FilesystemIdentity, private readonly revoked: () => boolean = () => isRevoked(connection)) {
    this.cells = new Int32Array(connection.sections);
  }
  enter(): void {
    Atomics.add(this.cells, 0, 1);
    if (!this.revoked()) return;
    this.exit();
    throw new FilesystemError(11);
  }
  exit(): void {
    if (Atomics.sub(this.cells, 0, 1) === 1) Atomics.notify(this.cells, 0);
  }
}
/** Revokes synchronously, then waits without blocking the supervisor's event loop. Resolving
 * proves this identity cannot touch filesystem storage again, even if its worker is still alive.
 * Descendants have their own sections; their controllers must quiesce each identity separately. */
export async function waitForFilesystemQuiescence(connection: FilesystemIdentity): Promise<void> {
  revokeFilesystem(connection);
  const cells = new Int32Array(connection.sections);
  const revocation = new Int32Array(connection.revocations[0]!);
  const asyncAtomics = Atomics as typeof Atomics & {
    waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> };
  };
  for (;;) {
    const observed = Atomics.load(cells, 0);
    if (!observed || Atomics.load(revocation, 0) === 2) return;
    const waiting = asyncAtomics.waitAsync(cells, 0, observed);
    // A proven-dead reap may have notified between the check and registration without
    // changing an abandoned count. Recheck after registration and release that waiter too.
    if (Atomics.load(revocation, 0) === 2) { Atomics.notify(cells, 0); return; }
    if (waiting.async) await waiting.value;
  }
}
/** Call only after the guest has stopped, after waitForFilesystemQuiescence(), or from its own
 * quiescent dispose path. A stopped worker can leave an unfinished section and abandoned locks. */
export function reapFilesystem(connection: FilesystemIdentity): void {
  Atomics.store(new Int32Array(connection.revocations[0]!), 0, 2);
  Atomics.store(new Int32Array(connection.ownerStates), connection.owner, 2);
  Atomics.notify(new Int32Array(connection.sections), 0);
  wake(connection);
}
export function wake(connection: FilesystemIdentity): void {
  const signal = new Int32Array(connection.signal);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function pack(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, (_key, item) => item === undefined ? { $undefined: true } : item instanceof Map ? { $map: Array.from(item) } : item));
}
export function unpack(bytes: Uint8Array): any {
  // Revivers returning undefined delete object properties, which is correct for resolved paths.
  return JSON.parse(decoder.decode(bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes), (_key, item) => item?.$undefined ? undefined : item?.$map ? new Map(item.$map) : item);
}
export type RequestMessage = { id: number; buffer: SharedArrayBuffer } | { connect: FilesystemConnection } | { sweep: true } | { trim: true } | { discard: number };
export function errno(error: unknown): number {
  if (error instanceof FilesystemError) return error.errno;
  if (error instanceof RangeError) return 22; // EFBIG
  return 29; // EIO, never invent ENOENT for an internal failure.
}
