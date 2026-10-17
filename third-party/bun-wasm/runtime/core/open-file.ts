import type { Resource } from "./descriptors";
import { FilesystemError, FilesystemSection, isRevoked, type FilesystemIdentity } from "../fs/protocol";

type FileResource = Extract<Resource, { kind: "file" }>;
interface SharedOffset {
  buffer: SharedArrayBuffer;
  cells: Int32Array;
  identity: FilesystemIdentity;
  section: FilesystemSection;
}
const offsets = new WeakMap<FileResource, SharedOffset>();

/** Promote the existing description in place, so every local dup keeps the same offset. */
export function shareFileResource(resource: FileResource, identity: FilesystemIdentity, buffer?: SharedArrayBuffer): SharedArrayBuffer {
  const existing = offsets.get(resource);
  if (existing) return existing.buffer;
  const shared = buffer ?? new SharedArrayBuffer(16);
  const cells = new Int32Array(shared);
  // Atomics has no Float64 operation. Share the number's bits, not a signed integer
  // conversion: existing JS offsets above 2^63 must not wrap into negative positions.
  const offset = new BigUint64Array(shared, 8, 1);
  const value = new Float64Array(1);
  const bits = new BigUint64Array(value.buffer);
  if (!buffer) {
    Atomics.store(cells, 1, resource.append ? 1 : 0);
    value[0] = resource.offset;
    Atomics.store(offset, 0, bits[0]!);
  }
  offsets.set(resource, { buffer: shared, cells, identity, section: new FilesystemSection(identity) });
  Object.defineProperties(resource, {
    offset: { enumerable: true, configurable: false, get: () => { bits[0] = Atomics.load(offset, 0); return value[0]!; }, set: (next: number) => { value[0] = next; Atomics.store(offset, 0, bits[0]!); } },
    append: { enumerable: true, configurable: false, get: () => Atomics.load(cells, 1) !== 0, set: (value: boolean) => Atomics.store(cells, 1, value ? 1 : 0) },
  });
  return shared;
}

/** Serialize offset selection, I/O and advancement. Positioned I/O need not enter this lock.
 * The section admits before checking revocation, so kill waits for release. A crashed owner's
 * lock is recoverable only after its controller has published the proven-reaped state. */
export function withFileOffset(resource: FileResource, operation: () => number, nonblocking = false): number {
  const state = offsets.get(resource);
  if (!state) return operation();
  const { cells, identity, section } = state;
  let admitted = false;
  let acquired = false;
  try {
    section.enter(); admitted = true;
    for (;;) {
      if (isRevoked(identity)) return -11;
      const owner = Atomics.compareExchange(cells, 0, 0, identity.owner);
      if (owner === 0) { acquired = true; break; }
      if (Atomics.load(new Int32Array(identity.ownerStates), owner) === 2) {
        Atomics.compareExchange(cells, 0, owner, 0);
        continue;
      }
      if (nonblocking) return -6;
    }
    if (isRevoked(identity)) return -11;
    return operation();
  } catch (error) {
    if (error instanceof FilesystemError) return -error.errno;
    throw error;
  } finally {
    if (acquired) { Atomics.compareExchange(cells, 0, identity.owner, 0); Atomics.notify(cells, 0); }
    if (admitted) section.exit();
  }
}
