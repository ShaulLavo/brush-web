import { afterEach, expect, test } from "bun:test";
import { DescriptorTable, OpenDescription, type Descriptor, type Resource, type Stream } from "../core/descriptors";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { SignalDisposition, setSignalDisposition } from "../proc/signals";
import { readOutcome } from "../proc/outcome";
import { WorkerProcessBroker } from "../proc/worker-broker";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "../proc/worker-client";
import type { ProcessContext, SpawnRequest } from "../proc/types";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({ executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: 0, fds: [], ...overrides });
interface Token { state: SharedArrayBuffer; lifetime: SharedArrayBuffer; pid: number; kind: "pipe" | "directory" }
function fakeCodec() {
  const states = new WeakMap<Resource, SharedArrayBuffer>();
  const release = (token: Token) => {
    if (Atomics.compareExchange(new Int32Array(token.lifetime), 0, 0, 1) !== 0) return;
    const state = new Int32Array(token.state);
    Atomics.sub(state, 0, 1); Atomics.add(state, 1, 1);
  };
  const resource = (token: Token): Resource => {
    const value: Resource = token.kind === "directory" ? { kind: "directory", handle: 42 } : {
      kind: "pipe", read: () => 0, write: chunks => chunks.reduce((n, chunk) => n + chunk.length, 0),
      readiness: () => ({ readable: true, writable: true, hangup: false }),
      forProcess: () => value as Stream,
      revoke: () => { Atomics.add(new Int32Array(token.state), 2, 1); },
      close: () => release(token),
    };
    states.set(value, token.state);
    return value;
  };
  const codec: WorkerDescriptorCodec = {
    export(source: Descriptor, pid: number) {
      const state = states.get(source.resource);
      if (!state) throw new Error("unknown resource");
      Atomics.add(new Int32Array(state), 0, 1);
      return { state, pid, lifetime: new SharedArrayBuffer(4), kind: source.resource.kind } satisfies Token;
    },
    import(value) {
      const token = value as Token;
      return new OpenDescription(resource(token), () => release(token));
    },
    discard(value) { release(value as Token); },
  };
  return { codec, source(descriptors: DescriptorTable, kind: Token["kind"] = "pipe") {
    const state = new SharedArrayBuffer(12);
    Atomics.store(new Int32Array(state), 0, 1);
    const token = { state, lifetime: new SharedArrayBuffer(4), pid: 1, kind };
    const fd = descriptors.open(resource(token), 127n, 63n, () => release(token));
    return { fd, counts: new Int32Array(state) };
  } };
}
function fixture(options: { capacity?: number; activate?: (supervisor: ProcessSupervisor) => Promise<ProcessSupervisor> } = {}) {
  const transport = createWorkerProcessTransport({ capacity: options.capacity });
  const state = workerProcessState(transport);
  const registry = new ExecutableRegistry(); registry.register("fixture", { module: emptyModule, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const supervisor = new ProcessSupervisor({ registry, launch(context) { contexts.set(context.pid, context); return { terminate() {} }; } });
  supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
  const { codec, source } = fakeCodec();
  const messages: WorkerProcessMessage[] = [];
  const revoked: number[] = [];
  const broker = new WorkerProcessBroker({ supervisor: () => options.activate?.(supervisor) ?? Promise.resolve(supervisor), codec });
  broker.adoptRoot(transport);
  cleanups.push(() => { broker.dispose(); supervisor.dispose(); });
  const client = (value: WorkerProcessTransport) => {
    const descriptors = new DescriptorTable(); cleanups.push(() => descriptors.dispose());
    return new WorkerProcessClient({ transport: value, descriptors, codec,
      postMessage(message) { messages.push(structuredClone(message)); },
      revokeProcess(pid) { revoked.push(pid); },
    });
  };
  const root = client(transport);
  return { transport, root, broker, supervisor, contexts, messages, source, client, codec, revoked,
    async flush() { while (messages.length) await broker.handle(messages.shift()!); },
  };
}

test("worker spawn synchronously retains arbitrary bindings across lazy activation and immediate parent close", async () => {
  let activate!: (supervisor: ProcessSupervisor) => void;
  const loading = new Promise<ProcessSupervisor>(resolve => { activate = resolve; });
  const f = fixture({ activate: () => loading });
  const { fd, counts } = f.source(f.root.options.descriptors, "directory");
  const pid = f.root.spawn(1, request({ fds: [{ child: 19, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  expect(counts[0]).toBe(1);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(f.contexts.size).toBe(0);
  const admitted = f.flush();
  activate(f.supervisor);
  await admitted; await f.supervisor.start(pid);
  expect(f.contexts.get(pid)!.descriptors.get(19)!.resource.kind).toBe("directory");
  const child = f.client(structuredClone(f.broker.get(pid)!)); child.installBindings();
  expect(child.options.descriptors.get(19)!.rightsBase).toBe(127n);
  expect(child.options.descriptors.get(19)!.description.references).toBe(1);
  child.exit(7);
  expect(f.root.wait(1, pid)).toBeNull();
  await f.flush();
  expect(f.root.wait(1, pid)).toEqual({ kind: "exited", code: 7, status: 7 });
  expect(counts[0]).toBe(0);
  expect(counts[1]).toBe(2);
});

test("worker spawn validates both fd bindings within the signed WASM success range before exporting", async () => {
  const f = fixture();
  const table = f.root.options.descriptors;
  const { fd, counts } = f.source(table);
  for (const invalid of [0x80000000, 0xffffffff, -1, 1.5, NaN]) {
    for (const binding of [{ child: invalid, parent: fd }, { child: 3, parent: invalid }]) {
      let error: unknown;
      try { f.root.spawn(1, request({ fds: [binding] })); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ name: "ProcessError", errno: 28 });
      expect(counts[0]).toBe(1);
      expect(f.messages.length).toBe(0);
    }
  }
  table.inherit(0x7fffffff, table.get(fd)!);
  const pid = f.root.spawn(1, request({ fds: [{ child: 0x7fffffff, parent: 0x7fffffff }] }));
  await f.flush();
  const child = f.client(f.broker.get(pid)!); child.installBindings();
  const duplicate = child.options.descriptors.dup(0x7fffffff);
  expect(duplicate).toBeGreaterThanOrEqual(0);
  expect(duplicate).toBeLessThanOrEqual(0x7fffffff);
  expect(child.options.descriptors.get(duplicate)!.description).toBe(child.options.descriptors.get(0x7fffffff)!.description);
});

test("duplicate inherited bindings share one exported lifetime and one child description", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors);
  const alias = f.root.options.descriptors.dup(fd);
  const pid = f.root.spawn(1, request({ fds: [{ child: 4, parent: fd }, { child: 77, parent: alias }] }));
  expect(f.messages[0]!.transport.resources.length).toBe(1);
  f.root.options.descriptors.close(fd); f.root.options.descriptors.close(alias);
  expect(counts[0]).toBe(1);
  await f.flush(); await f.supervisor.start(pid);
  const child = f.client(structuredClone(f.broker.get(pid)!)); child.installBindings();
  const table = child.options.descriptors;
  expect(table.get(4)!.description).toBe(table.get(77)!.description);
  table.close(4); expect(counts[0]).toBe(1);
  table.close(77); expect(counts[0]).toBe(0);
  child.exit(0); await f.flush();
  expect(counts[1]).toBe(2);
});

test("fatal selection freezes resources synchronously but wait stays pending until broker revocation completes", async () => {
  const f = fixture();
  const { fd } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 1, parent: fd }] }));
  await f.flush(); await f.supervisor.start(pid);
  const state = workerProcessState(f.broker.get(pid)!);
  const before = Atomics.load(f.root.wake, 0);
  f.root.kill(pid, 9);
  expect(f.revoked).toEqual([pid]);
  expect(readOutcome(state.signals.outcome)?.status).toBe(137);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(Atomics.load(f.root.wake, 0)).toBeGreaterThan(before);
  await f.flush();
  expect(f.root.wait(1, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(Atomics.load(state.confirmed, 0)).toBe(1);
});

test("handled and ignored signals preserve resource authority and share the disposition state", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const child = f.client(f.broker.get(pid)!);
  setSignalDisposition(child.signals.signalState, 15, SignalDisposition.HANDLE);
  f.root.kill(pid, 15); expect(f.revoked).toEqual([]);
  expect(Atomics.load(child.signals.signalState, 15)).toBe(SignalDisposition.HANDLE | 4);
  setSignalDisposition(child.signals.signalState, 2, SignalDisposition.IGNORE);
  f.root.kill(pid, 2); expect(f.revoked).toEqual([]);
  await f.flush(); expect(f.root.wait(1, pid)).toBeNull();
  child.exit(23); await f.flush();
  expect(f.root.wait(1, pid)?.code).toBe(23);
});

test("a kill before lazy activation prevents launch and releases all inherited endpoint refs", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 8, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  f.root.kill(pid, 9);
  expect(f.root.wait(1, pid)).toBeNull();
  await f.flush(); await f.supervisor.start(pid);
  expect(f.contexts.has(pid)).toBe(false);
  expect(f.root.wait(1, pid)?.status).toBe(137);
  expect(counts[0]).toBe(0);
});

test("worker authority permits self and descendants but not sibling processes or unowned jobs", async () => {
  const f = fixture();
  const a = f.root.spawn(1, request()), b = f.root.spawn(1, request());
  await f.flush();
  const child = f.client(f.broker.get(a)!);
  expect(() => child.kill(b, 9)).toThrow("ancestry");
  expect(() => child.killJob(f.root.jobOf(b), 9)).toThrow("not owned");
  const grandchild = child.spawn(a, request({ job: child.job }));
  await f.flush();
  expect(child.canSignal(a, grandchild)).toBe(true);
  expect(f.root.canSignal(1, grandchild)).toBe(true);
  f.root.killJob(child.job, 9);
  expect(f.revoked).toEqual([a, grandchild]);
  await f.flush();
  expect(f.root.wait(1, a)?.status).toBe(137);
  expect(f.root.wait(1, b)).toBeNull();
});

test("directory exhaustion is bounded and never reuses a completed process identity", async () => {
  const f = fixture({ capacity: 2 });
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  f.contexts.get(pid)!.exit(0);
  expect(f.root.wait(1, pid)?.status).toBe(0);
  expect(() => f.root.spawn(1, request())).toThrow("directory is full");
  expect(f.messages.length).toBe(0);
});

test("failed transfer unwinds retained lifetimes and the source admission transaction", () => {
  const f = fixture();
  const one = f.source(f.root.options.descriptors), two = f.source(f.root.options.descriptors);
  let exports = 0, cancelled = 0;
  const codec: WorkerDescriptorCodec = { ...f.codec, export(source, pid) { if (++exports === 2) throw new Error("reservation failed"); return f.codec.export(source, pid); } };
  const client = new WorkerProcessClient({ ...f.root.options, prepareSpawn: () => ({ codec, cancel() { cancelled++; } }) });
  expect(() => client.spawn(1, request({ fds: [{ child: 1, parent: one.fd }, { child: 2, parent: two.fd }] }))).toThrow("reservation failed");
  expect(cancelled).toBe(1); expect(one.counts[0]).toBe(1); expect(two.counts[0]).toBe(1);
  expect(f.messages.length).toBe(0);
});

test("transfer transaction commits only after publishing its independently-owned context", () => {
  const f = fixture();
  const order: string[] = [];
  const client = new WorkerProcessClient({ ...f.root.options,
    prepareSpawn: () => ({ data: { filesystem: "child" }, commit() { order.push("commit"); }, cancel() { order.push("cancel"); } }),
    postMessage(message) { order.push("publish"); f.messages.push(structuredClone(message)); },
  });
  client.spawn(1, request());
  expect(order).toEqual(["publish", "commit"]);
  expect(f.messages[0]!.transport.data).toEqual({ filesystem: "child" });
});

test("lazy activation failure releases transferred lifetimes before confirming exit 126", async () => {
  const f = fixture({ activate: async () => { throw new Error("chunk failed"); } });
  const { fd, counts } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 17, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  await expect(f.flush()).rejects.toThrow("chunk failed");
  expect(counts[0]).toBe(0);
  expect(f.root.wait(1, pid)).toEqual({ kind: "exited", code: 126, status: 126 });
});

test("an admitted independent child survives its parent's exit before lazy activation", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors, "directory");
  const pid = f.root.spawn(1, request({ job: -1, fds: [{ child: 11, parent: fd }] }));
  f.root.options.descriptors.close(fd);
  f.supervisor.exit(1, 0);
  await f.flush(); await f.supervisor.start(pid);
  expect(f.contexts.has(pid)).toBe(true);
  expect(counts[0]).toBe(1);
  f.contexts.get(pid)!.exit(0);
  expect(counts[0]).toBe(0);
});

test("repeated spawn messages cannot close or replace the first accepted process", async () => {
  const f = fixture();
  const { fd, counts } = f.source(f.root.options.descriptors);
  const pid = f.root.spawn(1, request({ fds: [{ child: 1, parent: fd }] }));
  const duplicate = structuredClone(f.messages[0]!);
  f.root.options.descriptors.close(fd);
  await f.flush(); await f.supervisor.start(pid);
  await expect(f.broker.handle(duplicate)).rejects.toThrow("already registered");
  expect(f.broker.get(pid)).toBeDefined();
  expect(counts[0]).toBe(1);
});

test("an ordinary exit with a signal-shaped code remains ordinary after a late kill", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const child = f.client(f.broker.get(pid)!);
  child.exit(143); await f.flush();
  f.root.kill(pid, 9); await f.flush();
  expect(f.revoked).toEqual([]);
  expect(f.root.wait(1, pid)).toEqual({ kind: "exited", code: 143, status: 143 });
});

test("broker rejects a foreign sender without accepting its process reservation", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request());
  await expect(f.broker.handle(f.messages.shift()!, 999)).rejects.toThrow("wrong sender");
  expect(f.broker.get(pid)).toBeUndefined();
});
