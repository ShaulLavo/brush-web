import { OpfsStorage, type OpfsStorageOptions } from "../fs/opfs";
import type { PersistenceBatch, PersistedNode } from "../fs/storage";
import { assert, batch, bytes, rejects, storageContractCases, type BrowserStorageTest } from "./storage-browser";

type SyncAccess = {
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};
type SyncFactory = (this: FileSystemFileHandle) => Promise<SyncAccess>;
type SyncPrototype = FileSystemFileHandle & { createSyncAccessHandle: SyncFactory };
interface HandleCounts { active: number; peak: number; opened: number; attempts: number }

/** Instrument the actual browser API, not resources(), so a fallback cannot hide leaked handles. */
async function withSyncHandles<T>(
  run: (counts: HandleCounts) => Promise<T>,
  before?: (file: FileSystemFileHandle) => void,
  wrap?: (file: FileSystemFileHandle, access: SyncAccess) => SyncAccess,
): Promise<T> {
  const prototype = FileSystemFileHandle.prototype as SyncPrototype;
  const original = prototype.createSyncAccessHandle;
  assert(typeof original === "function", "OPFS sync-access tests must run in a dedicated worker");
  const counts: HandleCounts = { active: 0, peak: 0, opened: 0, attempts: 0 };
  prototype.createSyncAccessHandle = async function() {
    counts.attempts++;
    before?.(this);
    const access = await original.call(this);
    counts.active++; counts.opened++; counts.peak = Math.max(counts.peak, counts.active);
    const wrapped = wrap?.(this, access) ?? access;
    let closed = false;
    return new Proxy(wrapped, {
      get(target, key) {
        if (key === "close") return () => {
          if (closed) return;
          target.close(); closed = true; counts.active--;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try { return await run(counts); }
  finally { prototype.createSyncAccessHandle = original; }
}

function replaceWrite(access: SyncAccess, write: SyncAccess["write"]): SyncAccess {
  return new Proxy(access, {
    get(target, key) {
      if (key === "write") return write;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  try { await action; }
  catch (error) {
    assert((error as { code?: string }).code === code, `Expected ${code}, got ${String(error)}`);
    return;
  }
  throw new Error(`Expected rejection with code ${code}`);
}

function manyFiles(count: number): PersistenceBatch {
  const children: [string, number][] = [];
  const upserts: PersistedNode[] = [{ ino: 1, kind: "dir", mtime: 1, size: 0, children }];
  const data = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index++) {
    const ino = index + 2, key = `file:${ino}`;
    children.push([`file${index}`, ino]);
    upserts.push({ ino, kind: "file", mtime: 1, size: 1, data: key });
    data.set(key, new Uint8Array([index & 255]));
  }
  return { generation: 1, root: 1, upserts, removes: [], data };
}

type Directory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
};
function encodedTestName(value: string): string {
  // These raw-layout tests use ASCII names/keys only; production also handles arbitrary Unicode.
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function workspaceDirectory(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`bun-wasm-${encodedTestName(name)}`);
}
async function metadataDirectory(name: string): Promise<Directory> {
  return await (await workspaceDirectory(name)).getDirectoryHandle("metadata") as Directory;
}
async function writeRaw(handle: FileSystemFileHandle, contents: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try { await writable.write(contents as Uint8Array<ArrayBuffer>); await writable.close(); }
  catch (error) { await writable.abort().catch(() => {}); throw error; }
}

interface OpfsCase {
  label: string;
  run(name: string, open: (options?: OpfsStorageOptions) => Promise<OpfsStorage>): Promise<void>;
}

function focusedCases(): OpfsCase[] {
  return [
    {
      label: "more than 253 payload reads use a genuinely bounded sync-handle cache",
      async run(_name, open) {
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            const count = 320;
            await storage.persist(manyFiles(count)); await storage.flush();
            // Reopen to prove startup stays lazy and all reads go through the real worker-only API.
            await storage.close();
            const reopened = await open();
            try {
              await reopened.load();
              assert(counts.active === 0, "opening metadata must not pre-open payload handles");
              const before = counts.opened;
              for (let round = 0; round < 2; round++) for (let index = 0; index < count; index++) {
                const value = await reopened.read(`file:${index + 2}`);
                assert(value.length === 1 && value[0] === (index & 255), "payload bytes survive cache churn");
              }
              assert(counts.opened - before >= count * 2, "all churn reads must acquire real sync handles, not silently fall back");
              const opened = counts.opened;
              await reopened.read(`file:${count + 1}`);
              assert(counts.opened === opened, "a hot payload must reuse its cached handle");
              const resources = reopened.resources();
              assert(resources.opfsCachedHandles! <= 64, "the retained read cache stays within its default bound");
              assert(counts.peak <= resources.opfsHandleLimit!, `real sync-handle peak ${counts.peak} exceeds declared total bound ${resources.opfsHandleLimit}`);
              assert(counts.peak < 253, "actual live handles must stay below Safari's sync-access cap, including transient handles");
              assert(counts.active === resources.opfsHandles, "resource accounting matches actual live handles");
            } finally { await reopened.close(); }
            assert(counts.active === 0, "close releases every actual sync access handle");
          } finally { await storage.close(); }
        });
      },
    },
    {
      label: "transient sync-access creation failures retry before opening a real handle",
      async run(_name, open) {
        const failures = ["NotReadableError", "NoModificationAllowedError", "InvalidStateError"];
        let remaining = 0, failure = "", attempts = 0;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            await storage.persist(manyFiles(failures.length));
            for (let index = 0; index < failures.length; index++) {
              failure = failures[index]!; remaining = 2; attempts = 0;
              const opened = counts.opened;
              assert((await storage.read(`file:${index + 2}`))[0] === index, "read succeeds after transient sync failure");
              assert(Number(attempts) === 3 && remaining === 0, `${failure} must retry twice then acquire a handle`);
              assert(counts.opened === opened + 1, "successful retry must use a real sync handle");
            }
          } finally { await storage.close(); }
          assert(counts.active === 0, "retrying handle creation leaks no handles");
        }, file => {
          if (!file.name.startsWith("p-")) return;
          attempts++;
          if (remaining > 0) { remaining--; throw new DOMException("injected transient sync failure", failure); }
        });
      },
    },
    {
      label: "sync-access retries are bounded, map errors, and can recover on a later read",
      async run(_name, open) {
        let failure: string | undefined, attempts = 0;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            await storage.persist(batch(1));
            failure = "NoModificationAllowedError";
            await rejectsCode(storage.read("file:1"), "EIO");
            assert(Number(attempts) === 6, `expected six bounded attempts, got ${attempts}`);
            assert(counts.active === 0, "failed sync opens do not consume the cache");
            failure = "SecurityError"; attempts = 0;
            await rejectsCode(storage.read("file:1"), "EIO");
            assert(Number(attempts) === 1, "non-transient sync errors must not be retried");
            failure = "QuotaExceededError"; attempts = 0;
            await rejectsCode(storage.read("file:1"), "ENOSPC");
            assert(Number(attempts) === 1, "sync-open quota maps to ENOSPC without retrying");
            failure = undefined;
            assert(new TextDecoder().decode(await storage.read("file:1")) === "v1", "a later read recovers after exhausted sync retries");
            assert(storage.resources().opfsHandles === 1, "recovered read acquires a real handle");
          } finally { await storage.close(); }
          assert(counts.active === 0, "failed opens followed by successful retry leak no handles");
        }, file => {
          if (failure && file.name.startsWith("p-")) { attempts++; throw new DOMException("injected sync-open failure", failure); }
        });
      },
    },
    {
      label: "payload quota maps to ENOSPC and the same failed write can be retried after reopen",
      async run(_name, open) {
        let fail = false, injected = false;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            await storage.persist(batch(1)); fail = true;
            await rejectsCode(storage.persist(batch(2)), "ENOSPC");
            await rejectsCode(storage.flush(), "ENOSPC");
            assert(injected, "quota fault must hit the real sync payload write");
            assert((await storage.load())?.generation === 1, "failed payload write leaves committed in-memory tree unchanged");
          } finally { fail = false; await storage.close(); }
          assert(counts.active === 0, "failed payload writes close every actual handle");
          const reopened = await open();
          try {
            assert((await reopened.load())?.generation === 1, "failed payload write preserves prior snapshot after reopen");
            await reopened.persist(batch(2)); await reopened.flush();
          } finally { await reopened.close(); }
          const final = await open();
          try {
            assert((await final.load())?.generation === 2, "same generation and immutable payload key can be retried");
            assert(new TextDecoder().decode(await final.read("file:2")) === "v2", "retry publishes complete payload bytes");
          } finally { await final.close(); }
          assert(counts.active === 0, "successful retry leaks no actual handles");
        }, undefined, (file, access) => file.name.startsWith("p-") ? replaceWrite(access, (buffer, options) => {
          if (fail && !injected) {
            injected = true;
            access.write(buffer.subarray(0, 1), options);
            throw new DOMException("injected partial payload quota", "QuotaExceededError");
          }
          return access.write(buffer, options);
        }) : access);
      },
    },
    {
      label: "torn snapshot quota retains the previous generation and supports recovery writes",
      async run(name, open) {
        let fail = false, injected = false;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            await storage.persist(batch(1));
            fail = true;
            await rejectsCode(storage.persist(batch(2)), "ENOSPC");
            await rejectsCode(storage.flush(), "ENOSPC");
            assert(injected, "snapshot fault must hit a real sync write");
            assert((await storage.load())?.generation === 1, "failed snapshot does not publish its in-memory index");
          } finally { fail = false; await storage.close(); }
          assert(counts.active === 0, "failed snapshot write closes its actual sync handle");
          // A killed worker cannot run rollback. Leave the same torn-file shape explicitly
          // so reopen also covers interruption, not just the synchronous error cleanup path.
          const metadata = await metadataDirectory(name);
          const torn = await metadata.getFileHandle("snapshot-2-interrupted.json", { create: true });
          const writable = await torn.createWritable();
          try { await writable.write(bytes('{"json":')); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
          const reopened = await open();
          try {
            assert((await reopened.load())?.generation === 1, "torn newest snapshot must fall back, never erase the tree");
            assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "old snapshot payload survives failed cleanup boundary");
            await reopened.persist(batch(2)); await reopened.flush();
          } finally { await reopened.close(); }
          const final = await open();
          try {
            assert((await final.load())?.generation === 2, "recovery can publish the formerly failed generation");
            assert(new TextDecoder().decode(await final.read("file:2")) === "v2", "recovered generation has intact bytes");
          } finally { await final.close(); }
          assert(counts.active === 0, "snapshot recovery releases all real handles");
        }, undefined, (file, access) => {
          if (!file.name.startsWith("snapshot-")) return access;
          return replaceWrite(access, (buffer, options) => {
            if (fail && !injected) {
              injected = true;
              access.write(buffer.subarray(0, Math.min(7, buffer.length)), options);
              throw new DOMException("injected torn snapshot quota", "QuotaExceededError");
            }
            return access.write(buffer, options);
          });
        });
      },
    },
    {
      label: "corrupt newest OPFS snapshot recovers the prior copy and can reuse its generation",
      async run(name, open) {
        const storage = await open();
        for (let generation = 1; generation <= 3; generation++) await storage.persist(batch(generation));
        await storage.flush(); await storage.close();
        const metadata = await metadataDirectory(name);
        let corrupted = 0;
        for await (const [entryName, entry] of metadata.entries()) {
          if (entry.kind !== "file" || !entryName.startsWith("snapshot-3-")) continue;
          const writable = await (entry as FileSystemFileHandle).createWritable();
          try { await writable.write(bytes("torn newest snapshot")); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
          corrupted++;
        }
        assert(corrupted === 1, "must corrupt the newest committed snapshot, not the older copy");
        const recovered = await open();
        assert((await recovered.load())?.generation === 2, "corrupt newest snapshot recovers the retained older generation");
        assert(new TextDecoder().decode(await recovered.read("file:2")) === "v2", "older snapshot payload survives collection");
        await recovered.persist(batch(3, "replacement")); await recovered.flush(); await recovered.close();
        const final = await open();
        assert((await final.load())?.generation === 3, "recovery can reuse the corrupt generation number");
        assert(new TextDecoder().decode(await final.read("file:3")) === "replacement", "abandoned payload bytes cannot replace the recovery edit");
      },
    },
    {
      label: "interrupted first checkpoint recovers the empty baseline and can retry the same key",
      async run(name, open) {
        let fail = true, injected = false;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            await rejectsCode(storage.persist(batch(1)), "ENOSPC");
            assert(injected, "failure must occur after the durable empty baseline was written");
          } finally { fail = false; await storage.close(); }
          assert(counts.active === 0, "first-checkpoint failure closes every actual sync handle");
          // Reproduce what a killed worker leaves, without allowing its rollback to remove it.
          const workspace = await workspaceDirectory(name);
          const data = await workspace.getDirectoryHandle("data");
          await writeRaw(await data.getFileHandle(`p-${encodedTestName("file:1")}`, { create: true }), bytes("partial"));
          const metadata = await metadataDirectory(name);
          await writeRaw(await metadata.getFileHandle("snapshot-1-interrupted.json", { create: true }), bytes('{"json":'));
          const recovered = await open();
          try {
            const index = await recovered.load();
            assert(index?.generation === 0 && index.nodes.length === 1, "first interrupted checkpoint recovers its explicit empty baseline");
            assert(index.nodes[0]?.kind === "dir" && index.nodes[0].children?.length === 0, "empty baseline contains no half-published namespace");
            await rejects(recovered.read("file:1"), /Missing|ENOENT|NotFound/);
            await recovered.persist(batch(1)); await recovered.flush();
          } finally { await recovered.close(); }
          const final = await open();
          try {
            assert((await final.load())?.generation === 1, "first generation can be retried after interruption");
            assert(new TextDecoder().decode(await final.read("file:1")) === "v1", "uncommitted orphan bytes are replaced by the retry");
          } finally { await final.close(); }
          assert(counts.active === 0, "first-checkpoint recovery leaks no native handles");
        }, undefined, (file, access) => file.name.startsWith("snapshot-") && file.name !== "snapshot-initial.json"
          ? replaceWrite(access, (buffer, options) => {
            if (fail && !injected) {
              injected = true; access.write(buffer.subarray(0, Math.min(7, buffer.length)), options);
              throw new DOMException("injected first-checkpoint interruption", "QuotaExceededError");
            }
            return access.write(buffer, options);
          }) : access);
      },
    },
    {
      label: "unknown crash payloads are swept once after publication, never during lazy load",
      async run(name, open) {
        const storage = await open(); await storage.persist(batch(1)); await storage.close();
        const data = await (await workspaceDirectory(name)).getDirectoryHandle("data");
        const orphan = `p-${encodedTestName("crash-orphan")}`;
        await writeRaw(await data.getFileHandle(orphan, { create: true }), bytes("uncommitted crash residue"));
        const prototype = FileSystemDirectoryHandle.prototype;
        const original = prototype.entries;
        let loading = true, sweeps = 0;
        prototype.entries = function() {
          if (this.name === "data") {
            assert(!loading, "lazy load must not enumerate the payload directory");
            sweeps++;
          }
          return original.call(this);
        };
        try {
          const recovered = await open();
          try {
            assert((await recovered.load())?.generation === 1, "orphan does not disturb the committed snapshot");
            assert(Number(sweeps) === 0, "load reads only metadata, even in the presence of orphan data");
            loading = false;
            await recovered.persist({ ...batch(2), retainedData: ["file:1"] });
            assert(Number(sweeps) === 1, "first successful publication sweeps unknown crash remnants");
            await rejects(data.getFileHandle(orphan), /NotFound/);
            await recovered.persist({ ...batch(3), retainedData: ["file:1"] });
            assert(Number(sweeps) === 1, "later checkpoints do not rescan the payload directory");
            assert(new TextDecoder().decode(await recovered.read("file:1")) === "v1", "orphan sweep preserves runtime-pinned payloads");
            assert(new TextDecoder().decode(await recovered.read("file:2")) === "v2", "orphan sweep preserves the older rollback snapshot");
            assert(new TextDecoder().decode(await recovered.read("file:3")) === "v3", "orphan sweep preserves the newly published snapshot");
          } finally { loading = false; await recovered.close(); }
        } finally { prototype.entries = original; }
      },
    },
    {
      label: "pending garbage cannot delete a payload re-adopted by a later checkpoint",
      async run(_name, open) {
        const storage = await open();
        const prototype = FileSystemDirectoryHandle.prototype;
        const original = prototype.removeEntry;
        const oldPayload = `p-${encodedTestName("file:1")}`;
        let blockRemoval = false, failures = 0;
        prototype.removeEntry = async function(entryName, options) {
          if (blockRemoval && this.name === "data" && entryName === oldPayload) {
            failures++;
            throw new DOMException("injected busy garbage payload", "NoModificationAllowedError");
          }
          return original.call(this, entryName, options);
        };
        try {
          await storage.persist(batch(1)); await storage.persist(batch(2));
          blockRemoval = true;
          await storage.persist(batch(3));
          assert(failures > 0, "third checkpoint must attempt collection of the first payload");
          assert((await storage.load())?.generation === 3, "failed garbage deletion must not roll back publication");
          blockRemoval = false;
          const adopted = batch(4, "v1");
          adopted.upserts[1]!.data = "file:1";
          adopted.data = new Map([["file:1", bytes("v1")]]);
          await storage.persist(adopted); await storage.flush();
          assert(new TextDecoder().decode(await storage.read("file:1")) === "v1", "pending garbage entry must be cancelled when its key is live again");
        } finally { prototype.removeEntry = original; await storage.close(); }
        const reopened = await open();
        assert((await reopened.load())?.generation === 4, "re-adopted generation survives reopening");
        assert(new TextDecoder().decode(await reopened.read("file:1")) === "v1", "re-adopted payload remains on disk after queued garbage collection");
      },
    },
    {
      label: "initial empty-baseline quota maps to ENOSPC and can be retried",
      async run(_name, open) {
        let fail = true, injected = false;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            await rejectsCode(storage.persist(batch(1)), "ENOSPC");
            await rejectsCode(storage.flush(), "ENOSPC");
            assert(injected, "fault must hit the durable initial baseline write");
          } finally { fail = false; await storage.close(); }
          assert(counts.active === 0, "baseline write failure releases its real native handle");
          const recovered = await open();
          try {
            const index = await recovered.load();
            assert(index === undefined || index.generation === 0, "a failed baseline cannot fabricate a committed namespace");
            await recovered.persist(batch(1)); await recovered.flush();
            assert(new TextDecoder().decode(await recovered.read("file:1")) === "v1", "baseline failure leaves the first checkpoint retryable");
          } finally { await recovered.close(); }
          assert(counts.active === 0, "baseline retry releases every real native handle");
        }, undefined, (file, access) => file.name === "snapshot-initial.json" ? replaceWrite(access, (buffer, options) => {
          if (fail && !injected) {
            injected = true; access.write(buffer.subarray(0, Math.min(7, buffer.length)), options);
            throw new DOMException("injected initial-baseline quota", "QuotaExceededError");
          }
          return access.write(buffer, options);
        }) : access);
      },
    },
    {
      label: "selective fsync preserves its file and namespace when an unrelated unsynced payload is lost",
      async run(name, open) {
        let observe = false;
        const flushed: string[] = [];
        const aName = `p-${encodedTestName("file:2")}`, bName = `p-${encodedTestName("file:3")}`;
        await withSyncHandles(async counts => {
          const storage = await open();
          try {
            // Keep a valid older namespace so recovery cannot pass by substituting that tree.
            await storage.persist(batch(1)); await storage.flush();
            await storage.persist({ ...manyFiles(2), generation: 2 });
            observe = true;
            await storage.flush(["file:2"]);
          } finally { await storage.close(); observe = false; }
          assert(flushed.includes(aName), "selective fsync flushes the requested real payload handle");
          assert(!flushed.includes(bName), "selective fsync and close must not flush an unrelated dirty payload");
          const snapshotFlush = flushed.findIndex(fileName => fileName.startsWith("snapshot-2-"));
          assert(snapshotFlush > flushed.indexOf(aName), "selective fsync flushes the naming snapshot after the selected payload");
          assert(counts.active === 0, "close releases both selected and unselected real handles");
          // Explicit power-loss model: an unflushed payload may disappear independently.
          const data = await (await workspaceDirectory(name)).getDirectoryHandle("data");
          await data.removeEntry(bName);
          const recovered = await open();
          try {
            const index = await recovered.load();
            assert(index?.generation === 2, "loss of an unrelated unsynced payload must not erase or substitute the naming snapshot");
            assert(index.nodes.some(node => node.data === "file:3"), "the current namespace retains the missing unrelated file rather than hiding it");
            const a = await recovered.read("file:2");
            assert(a.length === 1 && a[0] === 0, "fsynced payload bytes survive the modeled loss");
            await rejectsCode(recovered.read("file:3"), "ENOENT");
            await recovered.flush(["file:2"]);
          } finally { await recovered.close(); }
          assert(counts.active === 0, "selective recovery releases every real sync handle");
        }, undefined, (file, access) => new Proxy(access, {
          get(target, key) {
            if (key === "flush") return () => { if (observe) flushed.push(file.name); target.flush(); };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }));
      },
    },
    {
      label: "all corrupt OPFS snapshots reject instead of resetting existing storage",
      async run(name, open) {
        const storage = await open();
        for (let generation = 1; generation <= 3; generation++) await storage.persist(batch(generation));
        await storage.close();
        const metadata = await metadataDirectory(name);
        let corrupted = 0;
        for await (const [name, entry] of metadata.entries()) {
          if (entry.kind !== "file" || !name.startsWith("snapshot-")) continue;
          const writable = await (entry as FileSystemFileHandle).createWritable();
          try { await writable.write(bytes("not a checksummed snapshot")); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
          corrupted++;
        }
        assert(corrupted > 0, "must corrupt at least one actual snapshot");
        const reopened = await open();
        await rejects(reopened.load(), "corrupt");
        await rejects(reopened.persist(batch(2)), "corrupt");
      },
    },
  ];
}

/** The exact same contract callbacks as IndexedDB, plus OPFS-specific fault/resource cases. */
export function opfsStorageTests(): BrowserStorageTest[] {
  const shared: OpfsCase[] = storageContractCases().map(({ label, run }) => ({
    label, run: (name, open) => run(name, open),
  }));
  return shared.concat(focusedCases()).map(({ label, run }) => ({
    label,
    async run() {
      const name = `bun-wasm-opfs-test-${crypto.randomUUID()}`;
      const opened: OpfsStorage[] = [];
      const open = async (options?: OpfsStorageOptions) => {
        const storage = await OpfsStorage.open(name, options); opened.push(storage); return storage;
      };
      try { await run(name, open); }
      finally {
        for (const storage of opened) await storage.close().catch(() => {});
        await OpfsStorage.delete(name);
      }
    },
  }));
}

export async function runOpfsStorageTests(filter?: string): Promise<string[]> {
  const passed: string[] = [];
  for (const test of opfsStorageTests()) if (!filter || test.label.includes(filter)) {
    await test.run(); passed.push(test.label);
  }
  return passed;
}
