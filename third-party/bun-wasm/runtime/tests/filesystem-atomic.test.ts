import { afterEach, expect, test } from "bun:test";
import { MemFS } from "../fs/memory";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection, createFilesystemIdentity, connectFilesystemIdentity, revokeFilesystem, reapFilesystem } from "../fs";
import { PAGE } from "../fs/protocol";
import { atomicHost } from "./fixtures/wasi-atomic-host";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
function fixture(backend = new MemoryBackend()) {
  const service = new FilesystemService(backend);
  // Use a connected root client to create sibling sessions with the same epoch.
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => { sibling.dispose(); client.dispose(); service.dispose(); });
  return { client, sibling, service };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("service creates atomically reuse an entry for O_CREAT and reject it for O_EXCL or mkdir", async () => {
  const { client, sibling } = fixture();
  const roots = await Promise.all([client.asyncCall("preopen", ["/"]), sibling.asyncCall("preopen", ["/"])]);
  for (const exclusive of [false, true]) {
    const name = exclusive ? "exclusive" : "shared";
    const paths = await Promise.all([client.asyncCall("resolve", [roots[0], name]), sibling.asyncCall("resolve", [roots[1], name])]);
    expect(paths.map(path => path.node)).toEqual([undefined, undefined]);
    const results = await Promise.all([client.asyncCall("create", [paths[0], "file", exclusive]), sibling.asyncCall("create", [paths[1], "file", exclusive])]);
    if (exclusive) {
      expect(results.filter(result => typeof result === "number")).toHaveLength(1);
      expect(results.filter(result => typeof result !== "number")).toEqual([{ error: 20 }]);
    } else {
      expect(typeof results[0]).toBe("number");
      expect(results[1]).toBe(results[0]);
      // Returning the existing handle must also pin it in the second session.
      expect(await sibling.asyncCall("stat", [results[1]])).toEqual(await client.asyncCall("stat", [results[0]]));
    }
  }
  const paths = await Promise.all([client.asyncCall("resolve", [roots[0], "dir"]), sibling.asyncCall("resolve", [roots[1], "dir"])]);
  const results = await Promise.all([client.asyncCall("create", [paths[0], "directory"]), sibling.asyncCall("create", [paths[1], "directory"])]);
  expect(results.filter(result => typeof result === "number")).toHaveLength(1);
  expect(results.filter(result => typeof result !== "number")).toEqual([{ error: 20 }]);
});

test("serialized append requests choose EOF with their writes and return each writer's own end offset", async () => {
  const { client, sibling } = fixture();
  await client.asyncCall("writeFile", ["/shared"], encode("seed"));
  const root = await client.asyncCall("preopen", ["/"]);
  const siblingRoot = await sibling.asyncCall("preopen", ["/"]);
  const first = await client.asyncCall("resolve", [root, "shared"]);
  const second = await sibling.asyncCall("resolve", [siblingRoot, "shared"]);
  const results = await Promise.all([
    client.asyncCall("append", [first.node], encode("first")),
    sibling.asyncCall("append", [second.node], encode("second")),
  ]);
  const ordered = results.map((result, index) => ({ ...result, text: ["first", "second"][index] })).sort((a, b) => a.offset - b.offset);
  expect(ordered[0].offset).toBe(4 + ordered[0].written);
  expect(ordered[1].offset).toBe(4 + ordered[0].written + ordered[1].written);
  expect(decode(await client.asyncCall("readFile", ["/shared"]))).toBe("seed" + ordered[0].text + ordered[1].text);
  await expect(sibling.asyncCall("append", [999999], encode("bad"))).rejects.toMatchObject({ errno: 8 });
});

for (const exclusive of [false, true]) test(`WASI path_open handles a creator between resolve and create (exclusive=${exclusive})`, () => {
  const fs = new MemFS();
  const first = atomicHost(fs);
  const second = atomicHost(fs);
  cleanups.push(() => { first.wasi.descriptors.dispose(); second.wasi.descriptors.dispose(); });
  const resolve = fs.resolve.bind(fs);
  let competingFd: number | undefined;
  fs.resolve = (directory, path) => {
    const snapshot = resolve(directory, path);
    if (path === "raced" && typeof snapshot !== "number" && snapshot.node === undefined && competingFd === undefined) {
      // Restore before the nested open, retaining the first caller's missing-path snapshot.
      fs.resolve = resolve;
      const competing = second.open("raced", 1);
      expect(competing.error).toBe(0);
      competingFd = competing.fd;
      fs.writeFile("/raced", "do not replace");
    }
    return snapshot;
  };
  const opened = first.open("raced", exclusive ? 5 : 1);
  expect(opened.error).toBe(exclusive ? 20 : 0);
  expect(decode(fs.readFile("/raced"))).toBe("do not replace");
  if (exclusive) expect(opened.fd).toBe(0xdeadbeef);
  else expect(first.wasi.descriptors.get(opened.fd)!.resource).toMatchObject({ handle: (second.wasi.descriptors.get(competingFd!)!.resource as { handle: number }).handle });
  expect(first.errors).toEqual([]);
});

for (const exclusive of [false, true]) test(`worker-backed WASI passes O_EXCL through the create transport (exclusive=${exclusive})`, async () => {
  class RacingBackend extends MemoryBackend {
    execute(operation: string, args: any[], data: Uint8Array): unknown {
      const result = super.execute(operation, args, data);
      if (operation === "resolve" && args[1] === "raced") {
        const path = result as import("../core").ResolvedPath;
        expect(path.node).toBeUndefined();
        expect(typeof this.fs.create(path, "file")).toBe("number");
        this.fs.writeFile("/raced", "winner");
      }
      return result;
    }
  }
  const { client } = fixture(new RacingBackend());
  const worker = new Worker(new URL("./fixtures/filesystem-atomic-guest.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const result = new Promise<{ error: number; fd: number; errors: string[] }>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
  const connection = client.fork();
  worker.postMessage({ scenario: "create", connection, exclusive }, [connection.port]);
  const opened = await result;
  expect(opened.error).toBe(exclusive ? 20 : 0);
  if (exclusive) expect(opened.fd).toBe(0xdeadbeef);
  expect(opened.errors).toEqual([]);
  expect(decode(await client.asyncCall("readFile", ["/raced"]))).toBe("winner");
});

test("WASI append uses the atomic end offset, refreshes grown guest memory, and leaves pwrite positioned", () => {
  const fs = new MemFS();
  fs.writeFile("/shared", "seed");
  const host = atomicHost(fs);
  cleanups.push(() => host.wasi.descriptors.dispose());
  const { fd } = host.open("shared", 0, 1);
  const duplicate = host.wasi.descriptors.dup(fd);
  host.iovecs([encode("a"), encode("bc")]);
  const append = fs.append.bind(fs);
  let appendCalls = 0;
  fs.append = (handle, chunks) => {
    appendCalls++;
    // Another writer got there first. The caller must use the offset selected inside append.
    fs.writeFile("/shared", "other", true);
    const result = append(handle, chunks);
    host.memory.grow(1);
    return result;
  };
  fs.stat = () => { throw new Error("append must not sample EOF in a separate stat"); };
  expect(host.calls.fd_write!(duplicate, 0, 2, 1024)).toBe(0);
  expect(appendCalls).toBe(1);
  expect(host.view().getUint32(1024, true)).toBe(3);
  expect(host.tell(fd)).toBe(12);
  expect(decode(fs.readFile("/shared"))).toBe("seedotherabc");
  host.iovecs([encode("P")]);
  expect(host.calls.fd_pwrite!(fd, 0, 1, 0n, 1024)).toBe(0);
  expect(appendCalls).toBe(1);
  expect(host.tell(fd)).toBe(12);
  expect(decode(fs.readFile("/shared"))).toBe("Peedotherabc");
  expect(host.errors).toEqual([]);
});

test("WASI failed and empty appends preserve the description offset and failed output count", () => {
  const fs = new MemFS();
  fs.writeFile("/shared", "seed");
  const host = atomicHost(fs);
  cleanups.push(() => host.wasi.descriptors.dispose());
  const { fd } = host.open("shared", 0, 1);
  fs.append = () => -51;
  host.iovecs([encode("no")]);
  host.view().setUint32(1024, 1234, true);
  expect(host.calls.fd_write!(fd, 0, 1, 1024)).toBe(51);
  expect(host.view().getUint32(1024, true)).toBe(1234);
  expect(host.tell(fd)).toBe(0);
  fs.append = () => { throw new Error("zero-length append must not run"); };
  host.iovecs([new Uint8Array()]);
  expect(host.calls.fd_write!(fd, 0, 1, 1024)).toBe(0);
  expect(host.view().getUint32(1024, true)).toBe(0);
  expect(host.tell(fd)).toBe(0);
  expect(host.errors).toEqual([]);
});

test("two real WASI workers append multi-page iovecs atomically without append RPC", async () => {
  const appendSizes: number[] = [];
  class TrackingAppendBackend extends MemoryBackend {
    execute(operation: string, args: any[], data: Uint8Array): unknown {
      if (operation === "append") appendSizes.push(data.length);
      return super.execute(operation, args, data);
    }
  }
  const { client } = fixture(new TrackingAppendBackend());
  await client.asyncCall("writeFile", ["/shared"], encode("seed"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "shared"]);
  await client.asyncCall("grow", [path.node, PAGE * 4]);
  const workers = [65, 66].map(byte => {
    const worker = new Worker(new URL("./fixtures/filesystem-atomic-guest.ts", import.meta.url).href);
    cleanups.push(() => worker.terminate());
    const ready = deferred();
    const writing = deferred();
    let resolve!: (result: { error: number; written: number; offset: number; errors: string[]; byte: number }) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<{ error: number; written: number; offset: number; errors: string[]; byte: number }>((done, fail) => { resolve = done; reject = fail; });
    worker.onmessage = ({ data }) => {
      if (data.ready) ready.resolve();
      else if (data.writing) writing.resolve();
      else resolve({ ...data, byte });
    };
    worker.onerror = error => { ready.resolve(); writing.resolve(); reject(error); };
    const connection = client.fork();
    worker.postMessage({ connection, byte }, [connection.port]);
    return { worker, ready: ready.promise, writing: writing.promise, result };
  });
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.worker.postMessage("write");
  await Promise.all(workers.map(worker => worker.writing));
  const results = await Promise.all(workers.map(worker => worker.result));
  results.sort((a, b) => a.offset - b.offset);
  const size = PAGE + 20;
  expect(appendSizes).toEqual([]);
  expect(results.map(result => ({ error: result.error, written: result.written, offset: result.offset, errors: result.errors }))).toEqual([
    { error: 0, written: size, offset: 4 + size, errors: [] },
    { error: 0, written: size, offset: 4 + size * 2, errors: [] },
  ]);
  const bytes = await client.asyncCall("readFile", ["/shared"]) as Uint8Array;
  expect(bytes.length).toBe(4 + size * 2);
  expect(bytes.subarray(0, 4)).toEqual(encode("seed"));
  expect(bytes.subarray(4, 4 + size)).toEqual(new Uint8Array(size).fill(results[0]!.byte));
  expect(bytes.subarray(4 + size)).toEqual(new Uint8Array(size).fill(results[1]!.byte));
});


test("a WASI fd_write returns ENOSPC when the configured shared pool is full", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = connectFilesystemIdentity(createFilesystemIdentity(undefined, PAGE * 256));
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => { client.dispose(); service.dispose(); });
  await client.asyncCall("writeFile", ["/full"], new Uint8Array(PAGE * 255));
  await client.asyncCall("writeFile", ["/shared"], new Uint8Array());
  const worker = new Worker(new URL("./fixtures/filesystem-atomic-guest.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const result = new Promise<{ error: number; errors: string[] }>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
  const guest = client.fork();
  worker.postMessage({ connection: guest, scenario: "enospc", byte: 0 }, [guest.port]);
  expect(await result).toEqual({ error: 51, errors: [] });
  expect(await client.asyncCall("readFile", ["/shared"])).toEqual(new Uint8Array());
});


test("killing a direct writer recovers its global and file locks and leaves siblings writable", async () => {
  const { client, service } = fixture();
  await client.asyncCall("writeFile", ["/shared"], encode("seed"));
  const worker = new Worker(new URL("./fixtures/filesystem-atomic-guest.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const parked = new Promise<{ writing: boolean; owner: number }>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
  const guest = client.fork();
  worker.postMessage({ connection: guest, scenario: "killwrite", byte: 0 }, [guest.port]);
  const observed = await parked;
  // Fail before requesting service I/O if the owner tag is wrong: the old bug would spin
  // the service forever while trying to acquire the abandoned global lock.
  worker.terminate();
  reapFilesystem(guest);
  service.sweep();
  expect(observed).toEqual({ writing: true, owner: guest.owner });
  expect(Atomics.load(new Int32Array(client.connection.epoch), 0) & 1).toBe(0);
  await client.asyncCall("writeFile", ["/shared"], encode("live"));
  expect(await client.asyncCall("readFile", ["/shared"])).toEqual(encode("live"));
});


test("service mutations cannot publish an even epoch during a direct write", async () => {
  let epoch!: Int32Array;
  class InspectingBackend extends MemoryBackend {
    execute(operation: string, args: any[], data: Uint8Array): unknown {
      if (operation === "mkdirp" && args[0] === "/inspect") return Atomics.load(epoch, 0);
      return super.execute(operation, args, data);
    }
  }
  const { client } = fixture(new InspectingBackend());
  epoch = new Int32Array(client.connection.epoch);
  await client.asyncCall("writeFile", ["/shared"], encode("seed"));
  const worker = new Worker(new URL("./fixtures/filesystem-atomic-guest.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const parked = new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve(); worker.onerror = reject;
  });
  const guest = client.fork();
  worker.postMessage({ connection: guest, scenario: "epochwrite", byte: 0 }, [guest.port]);
  await parked;
  const insideService = await client.asyncCall("mkdirp", ["/inspect"]);
  expect(insideService & 1).toBe(1);
});
