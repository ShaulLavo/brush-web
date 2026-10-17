import { afterEach, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { DescriptorTable, type Stream } from "../core/descriptors";
import { FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity, createFilesystemConnection, createProcessFilesystemIdentity } from "../fs";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec";
import { PipeController, PipeEndpoint, PipeErrno, PipePublicationRegistry, type PipeEndpointHandle, type PipePublicationRegistryHandle } from "../proc/pipes";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { WorkerProcessBroker } from "../proc/worker-broker";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "../proc/worker-client";
import { WorkerPipeBroker, WorkerPipeHost, createWorkerPipeCodec, isWorkerPipeDescriptorToken } from "../proc/worker-pipes";
import { ProcessError, type ProcessContext, type SpawnRequest } from "../proc/types";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({ executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: 0, fds: [], ...overrides });
function output(endpoint: PipeEndpoint, capacity = 64): number | string {
  const bytes = new Uint8Array(capacity);
  const size = endpoint.tryRead([bytes]);
  return size < 0 ? size : decoder.decode(bytes.subarray(0, size));
}
async function expectRetired(broker: WorkerPipeBroker): Promise<void> {
  const deadline = performance.now() + 1000;
  while (broker.size !== 0 && performance.now() < deadline) await Bun.sleep(1);
  expect(broker.size).toBe(0);
}
function pairFixture(relay: "auto" | "manual" = "manual", cellsPerProcess = 32, processCapacity = 16) {
  const transport = createWorkerProcessTransport({ capacity: processCapacity });
  const messages: WorkerProcessMessage[] = [];
  const registry = new PipePublicationRegistry({ processCapacity, cellsPerProcess, wake: workerProcessState(transport).wake });
  const broker = new WorkerPipeBroker({ relay });
  const host = new WorkerPipeHost({ transport, registry, postMessage: message => messages.push(structuredClone(message)), pipe: { capacity: 8, maxWriters: 4, maxReaders: 4 } });
  cleanups.push(() => broker.dispose());
  return { transport, messages, registry, broker, host };
}
function processFixture(cellsPerProcess = 32, processCapacity = 16) {
  const pair = pairFixture("manual", cellsPerProcess, processCapacity);
  const executableRegistry = new ExecutableRegistry(); executableRegistry.register("fixture", { module: emptyModule, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const supervisor = new ProcessSupervisor({ registry: executableRegistry, launch(context) { contexts.set(context.pid, context); return { terminate() {} }; } });
  const rootState = workerProcessState(pair.transport);
  supervisor.createRoot({ pid: rootState.pid, job: rootState.job, ...rootState.signals });
  const processes = new WorkerProcessBroker({ supervisor: async () => supervisor, codec: () => pair.broker.codec(),
    onPipe: handle => pair.broker.attach(handle as PipeEndpointHandle), pumpPipes: () => pair.broker.pump(),
  });
  processes.adoptRoot(pair.transport);
  const tables: DescriptorTable[] = [];
  cleanups.push(() => { for (const table of tables) table.dispose(); processes.dispose(); supervisor.dispose(); });
  function client(transport: WorkerProcessTransport, host: WorkerPipeHost) {
    const descriptors = new DescriptorTable(); tables.push(descriptors);
    return new WorkerProcessClient({ transport, descriptors, codec: host.codec(),
      createPipe: () => host.createPipe(), revokeProcess: pid => host.revokeProcess(pid),
      postMessage: message => pair.messages.push(structuredClone(message)),
      prepareSpawn: () => ({ data: { pipeRegistry: host.registry.handle() } }),
    });
  }
  const root = client(pair.transport, pair.host);
  return { ...pair, contexts, processes, supervisor, root,
    child(pid: number) {
      const transport = structuredClone(processes.get(pid)!);
      const data = transport.data as { pipeRegistry: PipePublicationRegistryHandle };
      const host = new WorkerPipeHost({ transport, registry: data.pipeRegistry,
        postMessage: message => pair.messages.push(structuredClone(message)), pipe: { capacity: 8, maxWriters: 4, maxReaders: 4 },
      });
      const guest = client(transport, host); guest.installBindings();
      return { host, guest };
    },
    async flush() { while (pair.messages.length) await processes.handle(pair.messages.shift()!); },
  };
}

test("worker pipe factory synchronously creates shared-wake endpoints and announces a manual controller", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => { reader.close(); writer.close(); });
  expect(reader).toBeInstanceOf(PipeEndpoint);
  expect(f.messages).toHaveLength(1);
  const notice = f.messages[0]!;
  expect(notice.operation).toBe("pipe");
  if (notice.operation !== "pipe") throw new Error("not a pipe notice");
  // Attaching succeeds only when the worker has not already claimed the relay supervisor.
  f.broker.attach(notice.handle as PipeEndpointHandle);
  expect(writer.tryWrite([encoder.encode("hello")])).toBe(5);
  expect(output(reader)).toBe("hello");
  expect(Atomics.load(workerProcessState(f.transport).wake, 0)).toBeGreaterThan(0);
});

test("broker deduplicates structured-cloned SAB wrappers using the stable pipe id", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => { reader.close(); writer.close(); });
  const first = f.broker.attach(structuredClone(reader.handle()));
  const second = f.broker.attach(structuredClone(writer.handle()));
  expect(second).toBe(first);
  expect(f.broker.size).toBe(1);
});

test("broker retires closed pipes across repeated default-capacity shell pipelines", () => {
  const transport = createWorkerProcessTransport();
  const broker = new WorkerPipeBroker({ relay: "manual" });
  const host = new WorkerPipeHost({ transport, postMessage() {} });
  cleanups.push(() => broker.dispose());
  for (let iteration = 0; iteration < 4; iteration++) {
    const [reader, writer] = host.createPipe();
    cleanups.push(() => { reader.close(); writer.close(); });
    broker.attach(structuredClone(reader.handle()));
    expect(broker.size).toBe(1);
    reader.close(); writer.close();
    broker.pump();
    expect(broker.size).toBe(0);
  }
});

test("automatic broker retires final-closed pipes without another embedding pump", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => { reader.close(); writer.close(); });
  f.broker.attach(structuredClone(reader.handle()));
  reader.close(); writer.close();
  await expectRetired(f.broker);
});

test("automatic broker retires registry-revoked endpoints without guest cleanup", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => { reader.close(); writer.close(); });
  f.broker.attach(structuredClone(reader.handle()));
  f.host.revokeProcess(1);
  await expectRetired(f.broker);
});

test("broker keeps pipes alive for transferred descendants and EOF readers", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const inherited = writer.forProcess(2);
  cleanups.push(() => { reader.close(); writer.close(); inherited.close(); });
  f.broker.attach(structuredClone(reader.handle()));
  writer.close(); f.broker.pump();
  expect(f.broker.size).toBe(1);
  expect(inherited.tryWrite([encoder.encode("child")])).toBe(5);
  inherited.close(); f.broker.pump();
  expect(f.broker.size).toBe(1);
  expect(output(reader)).toBe("child");
  expect(output(reader)).toBe("");
  reader.close(); f.broker.pump();
  expect(f.broker.size).toBe(0);
});

test("already-closed pipe announcements do not retain a relay controller", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  const handle = structuredClone(reader.handle());
  cleanups.push(() => { reader.close(); writer.close(); });
  reader.close(); writer.close();
  f.broker.attach(handle);
  await expectRetired(f.broker);
  // A duplicated/delayed notice cannot resurrect the same dead pipe's background relay.
  f.broker.attach(structuredClone(handle));
  await expectRetired(f.broker);
});

test("codec reserves inherited endpoint refs before return and preserves data after the parent closes", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const parent = new DescriptorTable(); cleanups.push(() => parent.dispose());
  const fd = parent.open(writer, 127n, 63n);
  const token = f.host.codec().export(parent.get(fd)!, 2);
  expect(isWorkerPipeDescriptorToken(token)).toBe(true);
  parent.close(fd);
  const child = new DescriptorTable(); cleanups.push(() => child.dispose());
  child.add(f.broker.codec().import(structuredClone(token), 2), { rightsBase: 127n, rightsInheriting: 63n });
  const inherited = child.get(0)!.resource as PipeEndpoint;
  expect(inherited.tryWrite([encoder.encode("child")])).toBe(5);
  expect(output(reader)).toBe("child");
  child.dispose();
  expect(output(reader)).toBe("");
});

test("controller and worker imports release one transferred lifetime idempotently", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  cleanups.push(() => { reader.close(); writer.close(); });
  const parent = new DescriptorTable(); cleanups.push(() => parent.dispose());
  const fd = parent.open(writer, 3n, 3n);
  const token = f.host.codec().export(parent.get(fd)!, 2);
  const control = new DescriptorTable(), guest = new DescriptorTable();
  cleanups.push(() => { control.dispose(); guest.dispose(); });
  control.add(f.broker.codec().import(structuredClone(token), 2), { rightsBase: 3n, rightsInheriting: 3n });
  guest.add(f.host.codec().import(structuredClone(token), 2), { rightsBase: 3n, rightsInheriting: 3n });
  const alias = guest.dup(0);
  guest.close(0);
  expect((guest.get(alias)!.resource as PipeEndpoint).tryWrite([encoder.encode("x")])).toBe(1);
  guest.close(alias); control.dispose(); f.host.codec().discard(structuredClone(token));
  expect(output(reader)).toBe("x");
  // Parent's independent writer remains live after the transferred child reference closes.
  expect(output(reader)).toBe(-PipeErrno.AGAIN);
  writer.close(); expect(output(reader)).toBe("");
});

test("shared pipe tokens reject imports into the wrong process", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const table = new DescriptorTable(); cleanups.push(() => { table.dispose(); reader.close(); });
  const fd = table.open(writer, 3n, 3n);
  const token = f.host.codec().export(table.get(fd)!, 2);
  expect(() => f.host.codec().import(token, 3)).toThrow("another process");
  f.host.codec().discard(token);
});

test("broker owns relay pumping for readers inherited into another process", () => {
  const f = pairFixture();
  const [reader, writer] = f.host.createPipe();
  const source = new DescriptorTable(); cleanups.push(() => source.dispose());
  const fd = source.open(reader, 3n, 3n);
  const token = f.host.codec().export(source.get(fd)!, 2);
  const target = new DescriptorTable(); cleanups.push(() => { target.dispose(); writer.close(); });
  target.add(f.broker.codec().import(structuredClone(token), 2), { rightsBase: 3n, rightsInheriting: 3n });
  const inherited = target.get(0)!.resource as PipeEndpoint;
  source.close(fd);
  expect(writer.tryWrite([encoder.encode("relay")])).toBe(5);
  expect(output(inherited)).toBe(-PipeErrno.AGAIN);
  f.broker.pump();
  expect(output(inherited)).toBe("relay");
  writer.close(); f.broker.pump(); expect(output(inherited)).toBe("");
});

test("codec import automatically attaches the one responsive relay supervisor", async () => {
  const f = pairFixture("auto");
  const [reader, writer] = f.host.createPipe();
  const source = new DescriptorTable(); cleanups.push(() => source.dispose());
  const fd = source.open(reader, 3n, 3n);
  const token = f.host.codec().export(source.get(fd)!, 2);
  const target = new DescriptorTable(); cleanups.push(() => { target.dispose(); writer.close(); });
  target.add(f.broker.codec().import(structuredClone(token), 2), { rightsBase: 3n, rightsInheriting: 3n });
  const inherited = target.get(0)!.resource as PipeEndpoint;
  source.close(fd);
  writer.tryWrite([encoder.encode("auto")]);
  // Readiness does not reserve shared pipe bytes. A nonblocking read posts the demand
  // that lets the responsive controller deliver them to this reader's process ring.
  let result = output(inherited);
  const deadline = performance.now() + 1000;
  while (result === -PipeErrno.AGAIN && performance.now() < deadline) {
    await inherited.waitReadable();
    result = output(inherited);
  }
  expect(result).toBe("auto");
});

async function runChildPipeTransfers(f: ReturnType<typeof processFixture>, pid: number, iterations: number): Promise<void> {
  const worker = new Worker(new URL("./fixtures/worker-pipe-transfer-guest.ts", import.meta.url), {
    workerData: { transport: f.processes.get(pid), registry: f.registry.handle(), iterations },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`child pipe IPC timed out after ${received}/${iterations} transfers`)), 3000);
      worker.once("error", reject);
      worker.once("exit", code => {
        if (received !== iterations || code !== 0) reject(new Error(`child pipe worker exited ${code} after ${received} transfers`));
      });
      worker.on("message", message => {
        try {
          if (message.type === "runtime-proc" && message.operation === "pipe") {
            f.broker.attach(message.handle);
          } else if (message.phase === "transfer") {
            const target = new DescriptorTable();
            try {
              expect(message.sequence).toBe(received);
              target.add(f.broker.codec().import(message.token, 1), { rightsBase: 3n, rightsInheriting: 3n });
              const endpoint = target.get(0)!.resource as PipeEndpoint;
              let payload = output(endpoint);
              if (payload === -PipeErrno.AGAIN) { f.broker.pump(); payload = output(endpoint); }
              expect(payload).toBe(`child pipe ${received}`);
              f.broker.pump();
              expect(output(endpoint)).toBe("");
            } finally { target.dispose(); f.broker.pump(); }
            expect(f.broker.size).toBe(0);
            received++;
            worker.postMessage({ sequence: message.sequence });
          } else if (message.phase === "done") {
            expect(received).toBe(iterations);
            expect(message.iterations).toBe(iterations);
            resolve();
          } else if (message.phase === "failed") reject(new Error(message.error));
        } catch (error) { reject(error); }
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

test("a real child worker repeatedly creates and transfers pipes beyond one registry page", async () => {
  const f = processFixture(128);
  const pid = f.root.spawn(1, request());
  await f.flush(); await f.supervisor.start(pid);
  await runChildPipeTransfers(f, pid, 40);
});

test("sixteen distinct child workers each use IPC across shared registry growth", async () => {
  const f = processFixture(1, 32);
  const originalBytes = f.registry.handle().buffer.byteLength;
  const pids = new Set<number>();
  for (let child = 0; child < 16; child++) {
    const pid = f.root.spawn(1, request());
    pids.add(pid);
    await f.flush(); await f.supervisor.start(pid);
    // Three pipes per child exceed 32 total pipelines as well as the tiny shared hint.
    // Workers are serial so every iteration owns and joins only one actual child thread.
    await runChildPipeTransfers(f, pid, 3);
    f.supervisor.exit(pid, 0);
  }
  expect(pids.size).toBe(16);
  expect(f.registry.handle().buffer.byteLength).toBeGreaterThan(originalBytes);
  expect(f.broker.size).toBe(0);
});

test("authorized worker kill freezes publication before parent-visible completion", async () => {
  const f = processFixture();
  const [reader, writer] = f.host.createPipe();
  const fd = f.root.options.descriptors.open(writer, 127n, 63n);
  const pid = f.root.spawn(1, request({ fds: [{ child: 17, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  await f.flush(); await f.supervisor.start(pid);
  const { guest } = f.child(pid);
  const inherited = guest.options.descriptors.get(17)!.resource as PipeEndpoint;
  expect(inherited.tryWrite([encoder.encode("good")])).toBe(4);
  const late = encoder.encode("late"), subarray = late.subarray.bind(late);
  late.subarray = (start, end) => { f.root.kill(pid, 9); return subarray(start, end); };
  expect(inherited.tryWrite([late])).toBe(-PipeErrno.BADF);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(output(reader)).toBe("good");
  expect(output(reader)).toBe("");
  await f.flush();
  expect(f.root.wait(1, pid)?.status).toBe(137);
  reader.close();
});

test("a parent kill freezes descendant-created pipes not yet known to the broker", async () => {
  const f = processFixture();
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const { host } = f.child(pid);
  const [reader, writer] = host.createPipe();
  expect(f.broker.size).toBe(0);
  expect(writer.tryWrite([encoder.encode("queued")])).toBe(6);
  f.root.kill(pid, 9);
  expect(writer.tryWrite([encoder.encode("late")])).toBe(-PipeErrno.BADF);
  expect(reader.tryRead([new Uint8Array(8)])).toBe(-PipeErrno.BADF);
  expect(f.registry.isRevoked(pid)).toBe(true);
  expect(f.root.wait(1, pid)).toBeNull();
  await f.flush();
  expect(f.root.wait(1, pid)?.status).toBe(137);
  reader.close(); writer.close();
});

test("pipe codec composes actual filesystem transfers without stealing file ownership", async () => {
  const f = pairFixture();
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection(); service.connect(connection.server);
  const filesystem = new FilesystemClient(connection.client);
  cleanups.push(() => { filesystem.dispose(); service.dispose(); });
  await filesystem.asyncCall("writeFile", ["/file"], encoder.encode("file contents"));
  const directory = await filesystem.asyncCall("preopen", ["/"]);
  const { node } = await filesystem.asyncCall("resolve", [directory, "file"]);
  filesystem.retain(node);
  const parent = new DescriptorTable(); cleanups.push(() => parent.dispose());
  const fileFd = parent.open({ kind: "file", handle: node, offset: 0, append: false }, 127n, 63n, () => filesystem.release(node));
  const [reader, writer] = f.host.createPipe();
  const pipeFd = parent.open(writer, 127n, 63n); cleanups.push(() => reader.close());
  const identity = createProcessFilesystemIdentity(filesystem.connection);
  const exporter = f.host.codec(createFilesystemDescriptorCodec(filesystem, identity));
  const file = exporter.export(parent.get(fileFd)!, 2), pipe = exporter.export(parent.get(pipeFd)!, 2);
  expect(isWorkerPipeDescriptorToken(file)).toBe(false);
  expect(isWorkerPipeDescriptorToken(pipe)).toBe(true);
  parent.close(fileFd); parent.close(pipeFd);
  const targetConnection = connectFilesystemIdentity(identity); service.connect(targetConnection.server);
  const childFilesystem = new FilesystemClient(targetConnection.client); cleanups.push(() => childFilesystem.dispose());
  const target = new DescriptorTable(); cleanups.push(() => target.dispose());
  const importer = f.broker.codec(createFilesystemDescriptorCodec(childFilesystem));
  target.add(importer.import(structuredClone(file), 2), { rightsBase: 127n, rightsInheriting: 63n });
  target.add(importer.import(structuredClone(pipe), 2), { rightsBase: 127n, rightsInheriting: 63n });
  const resource = target.get(0)!.resource;
  if (resource.kind !== "file") throw new Error("not a file");
  const bytes = new Uint8Array(32);
  expect(childFilesystem.read(resource.handle, [bytes], resource.offset)).toBe(13);
  expect(decoder.decode(bytes.subarray(0, 13))).toBe("file contents");
  expect((target.get(1)!.resource as PipeEndpoint).tryWrite([encoder.encode("pipe")])).toBe(4);
  expect(output(reader)).toBe("pipe");
  target.dispose(); exporter.discard(file); exporter.discard(pipe);
  expect(output(reader)).toBe("");
});

for (const preserveExisting of [false, true]) {
  test(`pipe capacity failure rolls back a partial pair${preserveExisting ? " without damaging existing pipes" : ""}`, () => {
    const transport = createWorkerProcessTransport();
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 1, maxCells: preserveExisting ? 7 : 3 });
    const broker = new WorkerPipeBroker({ relay: "manual" });
    const messages: WorkerProcessMessage[] = [];
    cleanups.push(() => broker.dispose());
    const host = new WorkerPipeHost({ transport, registry: structuredClone(registry.handle()),
      pipe: { capacity: 8, maxReaders: 4, maxWriters: 4 },
      postMessage(message) {
        messages.push(message);
        if (message.operation === "pipe") broker.attach(message.handle as PipeEndpointHandle);
      },
    });
    const existing = preserveExisting ? host.createPipe() : undefined;
    cleanups.push(() => { existing?.[0].close(); existing?.[1].close(); });
    let partial: PipeEndpoint | undefined;
    let failedController: PipeController | undefined;
    const retain = PipeController.prototype.retain;
    const retainSpy = spyOn(PipeController.prototype, "retain").mockImplementation(function(this: PipeController, pid, mode) {
      const endpoint = retain.call(this, pid, mode);
      partial = endpoint; failedController = this;
      return endpoint;
    });
    cleanups.push(() => retainSpy.mockRestore());
    let failure: unknown;
    try { host.createPipe(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ProcessError);
    expect((failure as ProcessError).errno).toBe(PipeErrno.NFILE);
    // The reader was retained successfully before the writer exhausted the global budget.
    expect(partial?.mode).toBe("read");
    expect(Atomics.load(new Int32Array(partial!.handle().lifetime), 0)).toBe(1);
    expect(partial!.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.BADF);
    expect(failedController!.closed).toBe(true);
    expect(messages).toHaveLength(preserveExisting ? 1 : 0);
    expect(broker.size).toBe(preserveExisting ? 1 : 0);
    expect(host.registry.isRevoked(1)).toBe(false);
    if (existing) {
      expect(existing[1].tryWrite([encoder.encode("kept")])).toBe(4);
      expect(output(existing[0])).toBe("kept");
    }
  });
}

test("failed pipe announcement closes only the unpublished local pair", () => {
  const transport = createWorkerProcessTransport();
  const host = new WorkerPipeHost({ transport, pipe: { capacity: 8 }, postMessage() { throw new Error("post failed"); } });
  expect(() => host.createPipe()).toThrow("post failed");
  // Pipe creation failure cannot revoke the entire creating process or its later pipes.
  expect(host.registry.isRevoked(1)).toBe(false);
});

test("uncomposed codecs fail explicitly on unsupported streams and tokens", () => {
  const codec = createWorkerPipeCodec();
  const descriptors = new DescriptorTable(); cleanups.push(() => descriptors.dispose());
  const terminal: Stream = { kind: "terminal", read: () => 0, write: () => 0, readiness: () => ({ readable: true, writable: true, hangup: false }) };
  const fd = descriptors.open(terminal, 3n, 3n);
  expect(() => codec.export(descriptors.get(fd)!, 2)).toThrow("unsupported");
  expect(() => codec.import({ kind: "unknown" }, 2)).toThrow("unsupported");
});
