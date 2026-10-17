import type { FileSystem, FileHandle, FileStat, DirectoryEntry, ResolvedPath } from "../core";
import { CAPABILITY_HEADER, CAPABILITY_SLOTS, CAPABILITY_WORDS, HEADER, PAGE, TRANSIENT_HANDLES, State, FilesystemError, FilesystemSection, createFilesystemConnection, errno, isRevoked, pack, reapFilesystem, unpack, wake, releaseFilesystemReservation, type FilesystemIdentity, type FilesystemReservation, type FilesystemConnection } from "./protocol";
import { MissingDataError, MissingSegmentError, SharedFilesystemState, fixedWriteSources, sharedRevoked } from "./shared";

const asyncAtomics = Atomics as typeof Atomics & {
  waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> };
};

export class FilesystemCompletion {
  readonly cells: Int32Array;
  private changed: (() => void)[] = [];
  private cancellations = new Set<() => void>();
  private decoded: unknown;
  private loading?: Promise<unknown>;
  private consumed = false;
  constructor(readonly id: number, readonly buffer: SharedArrayBuffer, private client: FilesystemClient) { this.cells = new Int32Array(buffer, 0, HEADER / 4); }
  get ready(): boolean { return isRevoked(this.client.connection) || Atomics.load(this.cells, 0) !== State.Pending; }
  get epoch(): number { return this.cells[5]!; }
  notify(): void { for (const done of this.changed.splice(0)) done(); }
  cancel(): void {
    if (Atomics.exchange(this.cells, 6, 1)) return;
    Atomics.compareExchange(this.cells, 0, State.Pending, State.Cancelled);
    Atomics.notify(this.cells, 0);
    wake(this.client.connection);
    this.client.connection.port.postMessage({ discard: this.id });
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    this.notify();
  }
  release(): void {
    // Shared state can be ready before its port notification wakes value(). An unconsumed
    // release cancels that value and notifies its waiters before removing the completion.
    if (!this.consumed) this.cancel();
    else this.client.connection.port.postMessage({ discard: this.id });
    this.client.completions.delete(this.id);
    if (!this.client.completions.size) wake(this.client.connection);
  }
  /** Release a ready result that the caller does not need, while still delivering failures.
   * This never waits, decodes bytes or requests an overflow transfer. */
  releaseReady(): void {
    if (!this.ready) throw new FilesystemError(6);
    try { this.check(); this.consumed = true; }
    finally { this.release(); }
  }
  private check(): void {
    if (isRevoked(this.client.connection) || this.cells[6] || this.cells[0] === State.Cancelled) throw new FilesystemError(11);
    if (this.cells[0] === State.Failed) throw new FilesystemError(this.cells[3]!);
  }
  private decode(bytes: Uint8Array): unknown { return this.cells[4] ? bytes : unpack(bytes); }
  wait(): any {
    const signal = new Int32Array(this.client.connection.signal);
    while (!this.ready) {
      const observed = Atomics.load(signal, 0);
      this.check();
      if (!this.ready) Atomics.wait(signal, 0, observed);
    }
    this.check();
    if (this.consumed) return this.decoded;
    const size = this.cells[2]!;
    let bytes = new Uint8Array(this.buffer, HEADER, Math.min(size, this.buffer.byteLength - HEADER)).slice();
    if (this.cells[0] === State.Overflow) {
      bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += PAGE) bytes.set(this.client.call("take", [this.id, at, PAGE]), at);
    }
    this.check();
    this.decoded = this.decode(bytes); this.consumed = true;
    return this.decoded;
  }
  async value(): Promise<any> {
    if (!this.ready) await new Promise<void>(resolve => {
      this.changed.push(resolve);
      this.client.watchRevocation();
      // The response may have arrived between the check and registration.
      if (this.ready) this.notify();
    });
    this.check();
    if (this.consumed) return this.decoded;
    // All waiters consume the same overflow transfer; the final take deletes the stored bytes.
    return this.loading ??= this.load();
  }
  private async load(): Promise<unknown> {
    const size = this.cells[2]!;
    let bytes = new Uint8Array(this.buffer, HEADER, Math.min(size, this.buffer.byteLength - HEADER)).slice();
    if (this.cells[0] === State.Overflow) {
      bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += PAGE) {
        const part = this.client.submit("take", [this.id, at, PAGE]);
        const cancel = () => part.cancel();
        this.cancellations.add(cancel);
        try {
          this.check();
          bytes.set(await part.value(), at);
        } finally {
          this.cancellations.delete(cancel);
          part.release();
        }
      }
    }
    this.check();
    this.decoded = this.decode(bytes); this.consumed = true;
    return this.decoded;
  }
}
/** Blocking preview1 adapter and non-blocking request/completion API for the async host.
 * Read/stat caches are validated by the service's global seqlock. A concurrent mutation invalidates
 * before changing data; a cached read that overlaps it is discarded, never returned as fresh.
 */
export class FilesystemClient implements FileSystem {
  readonly completions = new Map<number, FilesystemCompletion>();
  private nextRequest = 1;
  private reads = new Map<number, { offset: number; bytes: Uint8Array; epoch: number }>();
  private stats = new Map<number, { stat: FileStat; epoch: number }>();
  private paths = new Map<string, { path: ResolvedPath | number; epoch: number }>();
  private readdirs = new Map<number, { entries: DirectoryEntry[]; epoch: number }>();
  private openHandles = new Map<number, number>();
  // Shared slots of open regular files: a live handle never changes slot, and direct I/O
  // rechecks the slot's handle under its file lock.
  private fileSlots = new Map<number, number>();
  // Preparation owns no guest buffers and never writes file bytes. Only a successful try* retry
  // commits I/O; the pending grow request merely loads data and reserves capacity.
  private ioPreparations = new Map<number, FilesystemCompletion>();
  private capabilityEntries = new Map<number, number>();
  private capabilities: Int32Array;
  private epoch: Int32Array;
  private revoked: () => boolean;
  private readonly section: FilesystemSection;
  readonly shared: SharedFilesystemState;
  private watchingRevocation = false;
  constructor(readonly connection: FilesystemConnection) {
    this.capabilities = new Int32Array(connection.capabilities);
    this.epoch = new Int32Array(connection.epoch);
    this.revoked = sharedRevoked(connection);
    this.section = new FilesystemSection(connection, this.revoked);
    this.shared = new SharedFilesystemState(connection.shared, connection.maxBytes, connection.owner, connection.segments, this.section);
    connection.port.onmessage = ({ data }) => { if (data.segment) this.shared.addSegment(data.segment, data.index); else this.completions.get(data.completed)?.notify(); };
    connection.port.start();
  }
  /** A single shared-signal waiter handles service death without a port completion message.
   * Normal replies still use the port; the watcher exits when the last completion is released.
   */
  watchRevocation(): void {
    if (this.watchingRevocation) return;
    this.watchingRevocation = true;
    void this.monitorRevocation();
  }
  private async monitorRevocation(): Promise<void> {
    const signal = new Int32Array(this.connection.signal);
    try {
      while (this.completions.size) {
        const observed = Atomics.load(signal, 0);
        if (this.revoked()) {
          for (const completion of this.completions.values()) completion.cancel();
          return;
        }
        const waiting = asyncAtomics.waitAsync(signal, 0, observed);
        if (waiting.async) await waiting.value;
      }
    } finally { this.watchingRevocation = false; }
  }
  fork(): FilesystemConnection {
    this.section.enter();
    try {
      const connection = createFilesystemConnection(this.connection);
      this.connection.port.postMessage({ connect: connection.server }, [connection.server.port]);
      return connection.client;
    } finally { this.section.exit(); }
  }
  /** Keep source admission held until the spawn notification has been published. */
  beginTransfer(): () => void {
    this.section.enter();
    let active = true;
    return () => { if (active) { active = false; this.section.exit(); } };
  }
  reserve(handle: FileHandle, target: FilesystemIdentity): FilesystemReservation {
    this.section.enter();
    try {
      if (isRevoked(target)) throw new FilesystemError(11);
      this.retain(handle);
      try {
        const sourceKey = this.capabilityEntry(handle)!;
        const entries = new Int32Array(target.capabilities);
        let targetKey = CAPABILITY_HEADER;
        while (targetKey < entries.length && Atomics.load(entries, targetKey + 1) >= 0 && Atomics.load(entries, targetKey) !== handle) targetKey += CAPABILITY_WORDS;
        if (targetKey >= entries.length) throw new FilesystemError(51);
        const reservation: FilesystemReservation = { handle, source: this.connection.capabilities, sourceKey, target: target.capabilities, targetKey, targetOwner: target.owner, state: new SharedArrayBuffer(8) };
        Atomics.add(this.capabilities, sourceKey + 2, 1);
        Atomics.store(entries, targetKey, handle);
        Atomics.store(entries, targetKey + 2, 0);
        const previous = Atomics.load(entries, targetKey + 1);
        Atomics.store(entries, targetKey + 1, previous < 0 ? 1 : previous + 1);
        target.reservations.push(reservation);
        return reservation;
      } finally { this.release(handle); }
    } finally { this.section.exit(); }
  }
  /** Import the already-owned reference, not another retain. */
  adopt(reservation: FilesystemReservation): void {
    if (Atomics.load(new Int32Array(reservation.state), 0)) return;
    this.openHandles.set(reservation.handle, (this.openHandles.get(reservation.handle) ?? 0) + 1);
    this.capabilityEntries.set(reservation.handle, reservation.targetKey);
  }
  releaseReservation(reservation: FilesystemReservation): void {
    const state = new Int32Array(reservation.state);
    const wasClosed = Atomics.load(state, 0);
    releaseFilesystemReservation(reservation);
    if (!wasClosed) {
      const count = this.openHandles.get(reservation.handle) ?? 0;
      if (count > 1) this.openHandles.set(reservation.handle, count - 1);
      else { this.openHandles.delete(reservation.handle); this.fileSlots.delete(reservation.handle); this.cancelIO(reservation.handle); }
    }
    this.connection.port.postMessage({ trim: true });
    this.sweep();
  }
  sweep(): void { this.connection.port.postMessage({ sweep: true }); }
  submit(operation: string, args: unknown[] = [], data: Uint8Array = new Uint8Array(), capacity = operation === "read" || operation === "take" || operation === "readdir" ? PAGE : 1024): FilesystemCompletion {
    if (this.revoked()) throw new FilesystemError(11);
    const input = pack({ operation, args });
    const buffer = new SharedArrayBuffer(HEADER + Math.max(input.length + data.length, capacity));
    const completion = new FilesystemCompletion(this.nextRequest++, buffer, this);
    completion.cells[1] = input.length; completion.cells[2] = data.length;
    new Uint8Array(buffer, HEADER).set(input);
    new Uint8Array(buffer, HEADER + input.length).set(data);
    this.completions.set(completion.id, completion);
    this.connection.port.postMessage({ id: completion.id, buffer });
    return completion;
  }
  readiness(id: number): { kind: 3; id: number; ready: boolean } | undefined {
    const completion = this.completions.get(id);
    return completion && { kind: 3, id, ready: completion.ready };
  }
  call(operation: string, args: unknown[] = [], data?: Uint8Array): any {
    const completion = this.submit(operation, args, data);
    try { return completion.wait(); } finally { completion.release(); }
  }
  async asyncCall(operation: string, args: unknown[] = [], data?: Uint8Array): Promise<any> {
    const completion = this.submit(operation, args, data);
    try { return await completion.value(); } finally { completion.release(); }
  }
  dispose(): void {
    // The disposing agent is quiescent: no synchronous file operation can be active here.
    reapFilesystem(this.connection);
    for (const completion of this.completions.values()) completion.cancel();
    this.completions.clear(); this.ioPreparations.clear(); this.reads.clear(); this.stats.clear(); this.paths.clear(); this.readdirs.clear(); this.openHandles.clear(); this.fileSlots.clear(); this.capabilityEntries.clear();
    this.sweep(); this.connection.port.close();
  }
  private version(): number {
    if (this.revoked()) throw new FilesystemError(11);
    return Atomics.load(this.epoch, 0);
  }
  preopen(path: string): FileHandle { return this.call("preopen", [path]); }
  private capabilityEntry(handle: FileHandle): number | undefined {
    const cached = this.capabilityEntries.get(handle);
    if (cached !== undefined && Atomics.load(this.capabilities, cached) === handle && Atomics.load(this.capabilities, cached + 1) >= 0) return cached;
    this.capabilityEntries.delete(handle);
    for (let key = CAPABILITY_HEADER; key < this.capabilities.length; key += CAPABILITY_WORDS) {
      if (Atomics.load(this.capabilities, key) === handle && Atomics.load(this.capabilities, key + 1) >= 0) return key;
    }
    return undefined;
  }
  private dropReference(key: number): number {
    for (;;) {
      const count = Atomics.load(this.capabilities, key + 1);
      if (count <= 0) return count;
      if (Atomics.compareExchange(this.capabilities, key + 1, count, count - 1) !== count) continue;
      if (count === 1 && !this.revoked() && (this.shared.isUnlinked(Atomics.load(this.capabilities, key)) || Atomics.load(this.capabilities, 0) > TRANSIENT_HANDLES)) this.connection.port.postMessage({ trim: true });
      return count - 1;
    }
  }
  retain(handle: FileHandle): void {
    this.section.enter();
    try {
      if (!Number.isInteger(handle) || handle < 0) throw new FilesystemError(8);
      for (;;) {
        if (this.revoked()) throw new FilesystemError(11);
        const key = this.capabilityEntry(handle);
        if (key === undefined) throw new FilesystemError(8);
        const count = Atomics.load(this.capabilities, key + 1);
        if (count < 0 || Atomics.load(this.capabilities, key) !== handle) continue;
        if (count === 0x7fffffff) throw new FilesystemError(33);
        if (Atomics.compareExchange(this.capabilities, key + 1, count, count + 1) !== count) continue;
        // An idle entry may have been evicted and reassigned between the key read and CAS.
        // Our temporary reference prevents further reuse while we validate its identity.
        if (Atomics.load(this.capabilities, key) !== handle) { this.dropReference(key); continue; }
        if (this.revoked()) { this.dropReference(key); throw new FilesystemError(11); }
        this.capabilityEntries.set(handle, key);
        this.openHandles.set(handle, (this.openHandles.get(handle) ?? 0) + 1);
        if (this.capabilityEntries.size > CAPABILITY_SLOTS) for (const [cachedHandle, entry] of this.capabilityEntries) {
          if (!this.openHandles.has(cachedHandle) && (Atomics.load(this.capabilities, entry) !== cachedHandle || Atomics.load(this.capabilities, entry + 1) < 0)) this.capabilityEntries.delete(cachedHandle);
        }
        return;
      }
    } finally { this.section.exit(); }
  }
  release(handle: FileHandle): void {
    try { this.section.enter(); }
    catch (error) {
      if (!(error instanceof FilesystemError) || error.errno !== 11) throw error;
      this.openHandles.delete(handle); this.fileSlots.delete(handle); this.cancelIO(handle); return;
    }
    try {
      const count = this.openHandles.get(handle) ?? 0;
      if (!count) throw new FilesystemError(8);
      const key = this.capabilityEntries.get(handle)!;
      if (count > 1) this.openHandles.set(handle, count - 1); else { this.openHandles.delete(handle); this.fileSlots.delete(handle); this.cancelIO(handle); }
      // Keep linked zero-reference capabilities as a bounded cache. dropReference queues any
      // needed detached-file/budget trim without waiting for a worker acknowledgment.
      this.dropReference(key);
    } finally { this.section.exit(); }
  }
  /** The shared slot of a regular file this connection holds open, or 0. */
  private directSlot(handle: FileHandle): number {
    const cached = this.fileSlots.get(handle);
    if (cached !== undefined) return cached;
    if (!this.openHandles.has(handle)) return 0;
    const slot = this.shared.fileSlot(handle);
    if (slot) this.fileSlots.set(handle, slot);
    return slot;
  }
  private directFailure(handle: FileHandle, error: unknown): number {
    if (error instanceof FilesystemError && error.errno === 8) this.fileSlots.delete(handle);
    return errno(error);
  }
  private cancelIO(handle: FileHandle): void {
    const completion = this.ioPreparations.get(handle);
    if (!completion) return;
    this.ioPreparations.delete(handle);
    completion.release();
  }
  private preparedIO(handle: FileHandle): boolean {
    const completion = this.ioPreparations.get(handle);
    if (!completion) return true;
    if (!completion.ready) return false;
    this.ioPreparations.delete(handle);
    // Inspect shared completion state even while poll owns the worker, before the port callback
    // can run. No wait(), async continuation or overflow transfer is needed for preparation.
    completion.releaseReady();
    return true;
  }
  private prepareIO(handle: FileHandle, size: number): void {
    if (!this.ioPreparations.has(handle)) this.ioPreparations.set(handle, this.submit("grow", [handle, size]));
  }
  /** Nonblocking runtime_proc I/O. Never retain an iovec across an EAGAIN boundary. */
  tryRead(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (!(offset >= 0)) return -28;
    try {
      if (!this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      return this.shared.directRead(slot, handle, chunks, offset, this.revoked, this.connection.owner, true);
    } catch (error) {
      if (error instanceof MissingDataError || error instanceof MissingSegmentError) {
        try { this.prepareIO(handle, 0); return -6; } catch (failure) { return -errno(failure); }
      }
      return -this.directFailure(handle, error);
    }
  }
  tryWrite(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (!(offset >= 0)) return -28;
    try {
      if (!this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      chunks = fixedWriteSources(chunks);
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const written = this.shared.directWrite(slot, handle, chunks, offset, total, this.epoch, this.revoked, this.connection.owner, true);
      if (written !== undefined) return written;
      this.prepareIO(handle, offset + total);
      return -6;
    } catch (error) { return -this.directFailure(handle, error); }
  }
  tryAppend(handle: FileHandle, chunks: readonly Uint8Array[]): { written: number; offset: number } | number {
    try {
      if (!this.preparedIO(handle)) return -6;
      const slot = this.directSlot(handle);
      if (!slot) return -8;
      chunks = fixedWriteSources(chunks);
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const result = this.shared.directAppend(slot, handle, chunks, total, this.epoch, this.revoked, this.connection.owner, true);
      if (typeof result !== "number") return result;
      this.prepareIO(handle, result);
      return -6;
    } catch (error) { return -this.directFailure(handle, error); }
  }
  ioReadiness(handle: FileHandle, writing: boolean): { readable: boolean; writable: boolean; hangup: boolean } {
    const pending = this.ioPreparations.get(handle);
    // A failed preparation is ready too: retrying the syscall delivers its errno, rather than
    // leaving poll asleep forever. Preserve that completion until the syscall consumes it.
    if (this.revoked()) return { readable: true, writable: true, hangup: true };
    if (pending && !pending.ready) return { readable: false, writable: false, hangup: false };
    if (pending && (pending.cells[0] === State.Failed || pending.cells[0] === State.Cancelled)) return { readable: true, writable: true, hangup: false };
    try {
      if (!this.preparedIO(handle)) return { readable: false, writable: false, hangup: false };
      const slot = this.directSlot(handle);
      if (!slot) return { readable: true, writable: true, hangup: false };
      const ready = this.shared.directReadiness(slot, handle, writing, this.revoked, this.connection.owner);
      // A cold file can be polled before its first read. Start hydration, but do not enqueue
      // RPCs on ordinary hot-file lock contention.
      if (ready === undefined) this.prepareIO(handle, 0);
      return { readable: !writing && ready === true, writable: writing && ready === true, hangup: false };
    } catch { return { readable: true, writable: true, hangup: false }; }
  }
  resolve(directory: FileHandle, path: string): ResolvedPath | number {
    try {
      const epoch = this.version();
      const key = `${directory}\0${path}`;
      const cached = this.paths.get(key);
      if (!(epoch & 1) && cached?.epoch === epoch) return typeof cached.path === "number" ? cached.path : { ...cached.path };
      const completion = this.submit("resolve", [directory, path]);
      try {
        const resolved: ResolvedPath | number = completion.wait();
        if (this.paths.size >= 256) this.paths.clear();
        this.paths.set(key, { path: resolved, epoch: completion.epoch });
        return typeof resolved === "number" ? resolved : { ...resolved };
      } finally { completion.release(); }
    } catch (error) { return errno(error); }
  }
  stat(handle: FileHandle): FileStat {
    const epoch = this.version();
    const direct = this.openHandles.has(handle) ? this.shared.stat(handle, this.revoked) : undefined;
    if (direct) return direct;
    const cached = this.stats.get(handle);
    if (!(epoch & 1) && cached?.epoch === epoch) return { ...cached.stat };
    const completion = this.submit("stat", [handle]);
    try {
      const stat = completion.wait();
      if (this.stats.size >= 256) this.stats.clear();
      this.stats.set(handle, { stat, epoch: completion.epoch });
      return { ...stat };
    } finally { completion.release(); }
  }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (!(offset >= 0)) return -28; // EINVAL: positions are never negative.
    const slot = this.directSlot(handle);
    if (slot) {
      try { return this.shared.directRead(slot, handle, chunks, offset, this.revoked, this.connection.owner); }
      catch (error) {
        if (!(error instanceof MissingSegmentError) && !(error instanceof MissingDataError)) return -this.directFailure(handle, error);
        // Only a standalone state can lack a segment; the service reply replaces every copied byte.
        try {
          let requested = 0; for (let i = 0; i < chunks.length; i++) requested += chunks[i]!.length;
          const bytes = this.call("read", [handle, requested, offset]) as Uint8Array;
          let at = 0; for (const chunk of chunks) { const count = Math.min(chunk.length, bytes.length - at); if (count > 0) chunk.set(bytes.subarray(at, at + count)); at += count; }
          return bytes.length;
        } catch (failure) { return -errno(failure); }
      }
    }
    let total = 0;
    try {
      for (const chunk of chunks) {
        let at = 0;
        while (at < chunk.length) {
          const position = offset + total;
          const epoch = this.version();
          let cached = this.reads.get(handle);
          if ((epoch & 1) || cached?.epoch !== epoch || position < cached.offset || position >= cached.offset + cached.bytes.length) {
            const completion = this.submit("read", [handle, PAGE, position]);
            try {
              cached = { offset: position, bytes: completion.wait(), epoch: completion.epoch };
              if (this.reads.size >= 16) this.reads.clear();
              this.reads.set(handle, cached);
            } finally { completion.release(); }
          }
          const start = position - cached.offset;
          const count = Math.min(chunk.length - at, cached.bytes.length - start);
          if (this.version() !== cached.epoch) continue;
          chunk.set(cached.bytes.subarray(start, start + count), at);
          at += count; total += count;
          if (!count || cached.bytes.length < PAGE && start + count === cached.bytes.length) return total;
        }
      }
      return total;
    } catch (error) { return total || -errno(error); }
  }
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    if (!(offset >= 0)) return -28; // EINVAL: positions are never negative.
    chunks = fixedWriteSources(chunks);
    const slot = this.directSlot(handle);
    if (slot) {
      let total = 0;
      for (let i = 0; i < chunks.length; i++) total += chunks[i]!.length;
      try {
        if (!total) { if (this.revoked()) throw new FilesystemError(11); return 0; }
        for (;;) {
          // Capacity is rechecked under the file lock. A truncate can reclaim pages between
          // retries, so grow only after both locks exit.
          const written = this.shared.directWrite(slot, handle, chunks, offset, total, this.epoch, this.revoked, this.connection.owner);
          if (written !== undefined) return written;
          this.call("grow", [handle, offset + total]);
        }
      } catch (error) {
        if (error instanceof MissingSegmentError) {
          try {
            const data = new Uint8Array(total); let at = 0; for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
            return this.call("write", [handle, offset], data);
          } catch (failure) { return -errno(failure); }
        }
        return -this.directFailure(handle, error);
      }
    }
    let total = 0;
    try { for (const chunk of chunks) for (let at = 0; at < chunk.length; at += PAGE) total += this.call("write", [handle, offset + total], chunk.subarray(at, at + PAGE)); return total; }
    catch (error) { return total || -errno(error); }
  }
  append(handle: FileHandle, chunks: readonly Uint8Array[]): { written: number; offset: number } | number {
    chunks = fixedWriteSources(chunks);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i]!.length;
    const fallback = () => {
      const data = new Uint8Array(total);
      let at = 0; for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
      return this.call("append", [handle], data);
    };
    const slot = this.directSlot(handle);
    try {
      if (!slot) return fallback();
      for (;;) {
        const result = this.shared.directAppend(slot, handle, chunks, total, this.epoch, this.revoked, this.connection.owner);
        if (typeof result !== "number") return result;
        this.call("grow", [handle, result]);
      }
    } catch (error) {
      if (error instanceof MissingSegmentError) { try { return fallback(); } catch (failure) { return -errno(failure); } }
      return -this.directFailure(handle, error);
    }
  }
  resize(handle: FileHandle, size: number, truncate: boolean): number {
    if (this.openHandles.has(handle) && this.shared.hasFile(handle)) {
      try {
        const result = this.shared.mutate(this.epoch, this.revoked, () => {
          const info = this.shared.info(handle, this.revoked);
          if (!info) throw new FilesystemError(8);
          // Recheck under the global lock: an append may have turned this into a shrink,
          // or a service shrink may have reclaimed the capacity sampled by the caller.
          if (truncate && size < info.size || size > info.capacity) return undefined;
          return this.shared.resize(handle, size, truncate, this.revoked, this.connection.owner);
        }, this.connection.owner);
        return result === undefined ? this.call("resize", [handle, size, truncate]) : result;
      } catch (error) { if (error instanceof MissingSegmentError || error instanceof MissingDataError) return this.call("resize", [handle, size, truncate]); return errno(error); }
    }
    try { return this.call("resize", [handle, size, truncate]); } catch (error) { return errno(error); }
  }
  setMtime(handle: FileHandle, mtime: number): number {
    if (this.openHandles.has(handle) && this.shared.hasFile(handle)) {
      try { return this.shared.mutate(this.epoch, this.revoked, () => this.shared.setMtime(handle, mtime, this.revoked, this.connection.owner), this.connection.owner); }
      catch (error) { return errno(error); }
    }
    try { return this.call("setMtime", [handle, mtime]); } catch (error) { return errno(error); }
  }
  sync(handle: FileHandle): number { try { return this.call("sync", [handle]); } catch (error) { return errno(error); } }
  readdir(handle: FileHandle): DirectoryEntry[] {
    const epoch = this.version();
    const cached = this.readdirs.get(handle);
    if (!(epoch & 1) && cached?.epoch === epoch) return cached.entries.map(entry => ({ ...entry }));
    const completion = this.submit("readdir", [handle]);
    try {
      const entries = completion.wait() as DirectoryEntry[];
      if (this.readdirs.size >= 64) this.readdirs.clear();
      this.readdirs.set(handle, { entries, epoch: completion.epoch });
      return entries.map(entry => ({ ...entry }));
    } finally { completion.release(); }
  }
  create(path: ResolvedPath, kind: "file" | "directory", exclusive = true): FileHandle | { error: number } {
    try { return this.call("create", [path, kind, exclusive]); } catch (error) { return { error: errno(error) }; }
  }
  link(from: ResolvedPath, to: ResolvedPath): number { try { return this.call("link", [from, to]); } catch (error) { return errno(error); } }
  removePath(path: ResolvedPath, directory: boolean): number { try { return this.call("removePath", [path, directory]); } catch (error) { return errno(error); } }
  rename(from: ResolvedPath, to: ResolvedPath): number { try { return this.call("rename", [from, to]); } catch (error) { return errno(error); } }
  lookup(path: string): any { return this.call("lookup", [path]); }
  writeFile(path: string, value: string | Uint8Array, append = false): void { this.call("writeFile", [path, append], typeof value === "string" ? new TextEncoder().encode(value) : value); }
}
