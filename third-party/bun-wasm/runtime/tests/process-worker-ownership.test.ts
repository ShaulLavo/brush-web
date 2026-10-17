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
function expectErrno(operation: () => unknown, errno: number): void {
  let error: unknown;
  try { operation(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ name: "ProcessError", errno });
}
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
function fixture(options: { capacity?: number; activate?: (supervisor: ProcessSupervisor) => Promise<ProcessSupervisor>; beforeActivation?(supervisor: ProcessSupervisor): void; terminate?(): void | Promise<void>; quiesce?(pid: number): void | Promise<void>; rejectedQuiesce?(pid: number): void | Promise<void> } = {}) {
  const transport = createWorkerProcessTransport({ capacity: options.capacity });
  const state = workerProcessState(transport);
  const registry = new ExecutableRegistry(); registry.register("fixture", { module: emptyModule, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const supervisor = new ProcessSupervisor({ registry, quiesce: options.quiesce, launch(context) { contexts.set(context.pid, context); return { terminate() { return options.terminate?.(); } }; } });
  supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
  options.beforeActivation?.(supervisor);
  const { codec, source } = fakeCodec();
  const messages: WorkerProcessMessage[] = [];
  const revoked: number[] = [];
  const broker = new WorkerProcessBroker({ supervisor: () => options.activate?.(supervisor) ?? Promise.resolve(supervisor), codec, quiesce: options.rejectedQuiesce });
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

test("worker job wait requires confirmed descendants and retains the directly-reaped leader outcome", async () => {
  const f = fixture();
  const leaderPid = f.root.spawn(1, request()); await f.flush();
  const leader = f.client(f.broker.get(leaderPid)!);
  const descendantPid = leader.spawn(leaderPid, request({ job: leader.job })); await f.flush();
  const descendant = f.client(f.broker.get(descendantPid)!);
  leader.exit(23);
  expect(f.root.jobEmpty(1, leader.job)).toBe(false);
  expect(f.root.waitJob(1, leader.job)).toBeNull();
  await f.flush();
  expect(f.supervisor.reap(1, leaderPid)?.code).toBe(23);
  expect(f.root.jobEmpty(1, leader.job)).toBe(false);
  descendant.exit(7);
  expect(f.root.waitJob(1, leader.job)).toBeNull();
  await f.flush();
  expect(f.root.jobEmpty(1, leader.job)).toBe(true);
  expect(f.root.jobEmpty(1, leader.job)).toBe(true);
  expect(f.root.waitJob(1, leader.job)).toEqual({ kind: "exited", code: 23, status: 23 });
  expectErrno(() => f.root.waitJob(1, leader.job), 12);
  expectErrno(() => f.root.jobEmpty(1, leader.job), 12);
  expectErrno(() => f.root.wait(1, leaderPid), 12);
  expectErrno(() => f.root.jobOf(descendantPid), 71);
  expectErrno(() => f.root.kill(leaderPid, 9), 71);
  await f.flush();
  expect(f.supervisor.get(descendantPid)).toBeUndefined();
  expect(f.broker.get(leaderPid)).toBeUndefined();
  expect(f.broker.get(descendantPid)).toBeUndefined();
});

test("worker process and job completion both await the host-work fence", async () => {
  let finish!: () => void;
  const fence = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture({ quiesce: () => fence });
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(0); await f.flush();
  const state = workerProcessState(f.broker.get(pid)!);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(Atomics.load(state.confirmed, 0)).toBe(0);
  expect(Atomics.load(state.jobConfirmed, 0)).toBe(0);
  expect(f.root.waitJob(1, child.job)).toBeNull();
  const before = Atomics.load(f.root.wake, 0);
  finish(); await fence; await Promise.resolve();
  expect(Atomics.load(f.root.wake, 0)).toBeGreaterThan(before);
  expect(f.root.wait(1, pid)?.status).toBe(0);
  expect(Atomics.load(state.confirmed, 0)).toBe(1);
  expect(f.root.jobEmpty(1, child.job)).toBe(true);
  expect(f.root.waitJob(1, child.job)?.status).toBe(0);
  await f.flush();
});

test("rejected worker admissions fence host work before publishing safe job completion", async () => {
  let finish!: () => void, began!: () => void;
  const fence = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = fixture({ activate: async () => { throw new Error("chunk failed"); }, rejectedQuiesce: () => { began(); return fence; } });
  const pid = f.root.spawn(1, request());
  const pending = f.flush();
  await started;
  expect(f.root.wait(1, pid)).toBeNull();
  const job = f.root.jobOf(pid);
  expect(f.root.jobEmpty(1, job)).toBe(false);
  finish(); await expect(pending).rejects.toThrow("chunk failed");
  expect(f.root.wait(1, pid)?.status).toBe(126);
  expect(f.root.jobEmpty(1, job)).toBe(true);
});

test("worker job wait has retained owner ancestry and rejects siblings and unknown jobs", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request()), siblingPid = f.root.spawn(1, request()); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!), sibling = f.client(f.broker.get(siblingPid)!);
  const memberPid = owner.spawn(ownerPid, request()); await f.flush();
  const member = f.client(f.broker.get(memberPid)!);
  owner.exit(0); await f.flush();
  expect(f.root.waitJob(1, owner.job)?.status).toBe(0); await f.flush();
  expectErrno(() => f.root.jobOf(ownerPid), 71);
  expect(f.root.canSignal(1, memberPid)).toBe(true);
  expect(f.root.jobEmpty(1, member.job)).toBe(false);
  expectErrno(() => sibling.waitJob(siblingPid, member.job), 63);
  expectErrno(() => f.root.waitJob(siblingPid, member.job), 63);
  expectErrno(() => f.root.waitJob(1, 999999), 71);
  member.exit(0); await f.flush();
  expect(f.root.waitJob(1, member.job)?.status).toBe(0);
  await f.flush();
  expect(f.supervisor.get(memberPid)).toBeUndefined();
});

test("queued worker reap notices retain authority after their caller is itself reaped", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request()); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!);
  const childPid = owner.spawn(ownerPid, request()); await f.flush();
  const child = f.client(f.broker.get(childPid)!);
  child.exit(8); await f.flush();
  expect(owner.waitJob(ownerPid, child.job)?.status).toBe(8);
  const delayed = f.messages.shift()!;
  owner.exit(0); await f.flush();
  expect(f.root.waitJob(1, owner.job)?.status).toBe(0); await f.flush();
  expect(f.supervisor.get(ownerPid)).toBeUndefined();
  expect(f.supervisor.get(childPid)).toBeDefined();
  await f.broker.handle(delayed, ownerPid);
  expect(f.supervisor.get(childPid)).toBeUndefined();
  expect(f.broker.get(childPid)).toBeUndefined();
});

test("accepted separate-job spawns keep their descriptors after the parent job is reaped", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request()); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!);
  const { fd, counts } = f.source(owner.options.descriptors, "directory");
  const childPid = owner.spawn(ownerPid, request({ job: -1, fds: [{ child: 19, parent: fd }] }));
  owner.options.descriptors.close(fd);
  const delayed = f.messages.shift()!;
  owner.exit(0); await f.flush();
  expect(f.root.waitJob(1, owner.job)?.status).toBe(0); await f.flush();
  expect(f.broker.get(ownerPid)).toBeUndefined();
  const identity = f.broker.getIdentity(ownerPid)!;
  expect(identity.bindings).toEqual([]); expect(identity.resources).toEqual([]); expect(identity.data).toBeUndefined();
  await f.broker.handle(delayed, ownerPid); await f.supervisor.start(childPid);
  expect(f.contexts.get(childPid)!.descriptors.get(19)!.resource.kind).toBe("directory");
  expect(counts[0]).toBe(1);
  const child = f.client(f.broker.get(childPid)!);
  child.exit(0); await f.flush();
  expect(f.root.waitJob(1, child.job)?.status).toBe(0); await f.flush();
  expect(counts[0]).toBe(0);
});

test("worker job membership cannot reopen safely completed or reaped jobs", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(0);
  // Selected outcomes alone do not seal a job: cleanup is still pending.
  const joined = f.root.spawn(1, request({ job: child.job }));
  await f.broker.handle(f.messages.shift()!);
  // The host has not received the accepted join yet; its shared-directory guard
  // must prevent a direct host waiter from reaping the incomplete job.
  expect(f.supervisor.waitJob(1, child.job)).toBeNull();
  await f.flush();
  const member = f.client(f.broker.get(joined)!);
  expect(f.root.jobEmpty(1, child.job)).toBe(false);
  member.exit(0); await f.flush();
  expectErrno(() => f.root.spawn(1, request({ job: child.job })), 12);
  expect(f.root.waitJob(1, child.job)?.status).toBe(0);
  expectErrno(() => f.root.spawn(1, request({ job: child.job })), 12);
  await f.flush();
});

test("worker transfer fences precede membership reservation and cancel on directory exhaustion", () => {
  const f = fixture({ capacity: 1 });
  let prepared = 0, cancelled = 0;
  const client = new WorkerProcessClient({ ...f.root.options, prepareSpawn() {
    expect(Atomics.load(new Int32Array(f.transport.directory), 0)).toBe(1);
    prepared++;
    return { cancel() { cancelled++; } };
  } });
  expectErrno(() => client.spawn(1, request({ job: f.root.job })), 6);
  expect(prepared).toBe(1); expect(cancelled).toBe(1);
  expect(Atomics.load(workerProcessState(f.transport).jobPending, 0)).toBe(1);
});

test("failed leader imports retain host leader identity and outcome for queued job members", async () => {
  const f = fixture();
  const { fd } = f.source(f.root.options.descriptors, "directory");
  const leaderPid = f.root.spawn(1, request({ fds: [{ child: 19, parent: fd }] }));
  const job = f.root.jobOf(leaderPid);
  const joinedPid = f.root.spawn(1, request({ job }));
  const original = f.codec.import;
  let imports = 0;
  f.codec.import = (token, pid) => { if (++imports === 1) throw new Error("import failed"); return original(token, pid); };
  await expect(f.flush()).rejects.toThrow("import failed");
  expect(f.supervisor.get(leaderPid)?.result?.status).toBe(126);
  expect(f.root.jobEmpty(1, job)).toBe(false);
  await f.flush();
  const joined = f.client(f.broker.get(joinedPid)!);
  joined.exit(7); await f.flush();
  expect(f.root.waitJob(1, job)?.status).toBe(126); await f.flush();
  expect(f.supervisor.get(joinedPid)).toBeUndefined();
});

test("guest job claims exclude host consumers until the broker acknowledges them", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(8); await f.flush();
  expect(f.root.waitJob(1, child.job)?.status).toBe(8);
  expectErrno(() => f.supervisor.waitJob(1, child.job), 12);
  expectErrno(() => f.supervisor.jobEmpty(1, child.job), 12);
  expect(f.supervisor.get(pid)).toBeDefined();
  await f.flush();
  expect(f.supervisor.get(pid)).toBeUndefined();
  expectErrno(() => f.supervisor.waitJob(1, child.job), 12);
});

test("guest claims racing after host readiness win before host metadata is consumed", async () => {
  let race: (() => void) | undefined;
  const f = fixture({ beforeActivation(supervisor) {
    supervisor.registerJobReapClaim(() => {
      const claim = race; race = undefined;
      claim?.();
      return true;
    });
  } });
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(8); await f.flush();
  let status: number | undefined;
  race = () => { status = f.root.waitJob(1, child.job)?.status; };
  expectErrno(() => f.supervisor.waitJob(1, child.job), 12);
  expect(status).toBe(8);
  expect(f.supervisor.get(pid)).toBeDefined();
  await f.flush();
  expect(f.supervisor.get(pid)).toBeUndefined();
});

test("host job reap tombstones worker-visible processes synchronously", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request()); await f.flush();
  const child = f.client(f.broker.get(pid)!);
  child.exit(0); await f.flush();
  f.supervisor.registerJobReapClaim(() => {
    // This hook runs after the broker claim but before host metadata deletion.
    expectErrno(() => f.root.waitJob(1, child.job), 12);
    return true;
  });
  expect(f.supervisor.waitJob(1, child.job)?.status).toBe(0);
  expectErrno(() => f.root.waitJob(1, child.job), 12);
  expectErrno(() => f.root.jobOf(pid), 71);
  expect(f.broker.get(pid)).toBeUndefined();
  expect(f.broker.getIdentity(pid)?.resources).toEqual([]);
});

test("failed synchronous worker transfers confirm cleanup and allow one atomic job reap", async () => {
  const f = fixture();
  const { fd } = f.source(f.root.options.descriptors);
  const client = new WorkerProcessClient({ ...f.root.options, codec: { ...f.codec, export() { throw new Error("transfer failed"); } } });
  expect(() => client.spawn(1, request({ fds: [{ child: 1, parent: fd }] }))).toThrow("transfer failed");
  const childTransport = { ...f.transport, slot: 1 };
  const job = workerProcessState(childTransport).job;
  const otherRoot = f.client(structuredClone(f.transport));
  expect(f.root.jobEmpty(1, job)).toBe(true);
  expect(f.root.waitJob(1, job)?.status).toBe(126);
  expectErrno(() => otherRoot.waitJob(1, job), 12);
  await f.flush();
});

test("broker rejects a foreign sender without accepting its process reservation", async () => {
  const f = fixture();
  const pid = f.root.spawn(1, request());
  await expect(f.broker.handle(f.messages.shift()!, 999)).rejects.toThrow("wrong sender");
  expect(f.broker.get(pid)).toBeUndefined();
});


test("shared job leader, owner and foreground survive reordered successful admissions", async () => {
  for (const selection of [0, -1]) {
    const f = fixture();
    const ownerPid = f.root.spawn(1, request({ job: -1 })); await f.flush();
    const owner = f.client(f.broker.get(ownerPid)!);
    const leaderPid = owner.spawn(ownerPid, request({ job: selection }));
    const job = owner.jobOf(leaderPid);
    const leaderMessage = f.messages.shift()!;
    const memberPid = f.root.spawn(1, request({ job }));
    await f.broker.handle(f.messages.shift()!);
    expect(f.supervisor.job(job)).toMatchObject({ ownerPid, leaderPid, foreground: selection === 0, leaderResult: null });
    expect(f.supervisor.canWaitJob(ownerPid, job)).toBe(true);
    const member = f.client(f.broker.get(memberPid)!);
    member.exit(19); await f.flush();
    expect(f.supervisor.waitJob(ownerPid, job)).toBeNull();
    expect(f.supervisor.job(job)?.leaderResult).toBeNull();
    await f.broker.handle(leaderMessage);
    const leader = f.client(f.broker.get(leaderPid)!);
    leader.exit(4); await f.flush();
    expect(f.supervisor.waitJob(ownerPid, job)).toEqual({ kind: "exited", code: 4, status: 4 });
    expectErrno(() => f.root.waitJob(1, job), 12);
  }
});

test("a locally failed unposted leader remains authoritative for its admitted shared member", async () => {
  const f = fixture();
  const ownerPid = f.root.spawn(1, request({ job: -1 })); await f.flush();
  const owner = f.client(f.broker.get(ownerPid)!);
  const { fd } = f.source(owner.options.descriptors);
  let leaderTransport!: WorkerProcessTransport;
  let memberPid = 0, released = false;
  const client = new WorkerProcessClient({ ...owner.options,
    prepareSpawn() { return {
      release() {
        const state = workerProcessState(leaderTransport);
        expect(Atomics.load(state.confirmed, 0)).toBe(1);
        expect(Atomics.load(state.jobConfirmed, 0)).toBe(1);
        expect(Atomics.load(state.jobPending, 0)).toBe(1);
        released = true;
      },
    }; },
    codec: { ...f.codec, export() {
      // The reservation is visible to another live worker before this exporter fails.
      leaderTransport = { ...f.transport, slot: 2 };
      memberPid = f.root.spawn(1, request({ job: workerProcessState(leaderTransport).job }));
      throw new Error("local export failed");
    } },
  });
  expect(() => client.spawn(ownerPid, request({ fds: [{ child: 1, parent: fd }] }))).toThrow("local export failed");
  expect(released).toBe(true);
  const state = workerProcessState(leaderTransport);
  expect(f.messages.length).toBe(1);
  await f.flush();
  expect(f.supervisor.get(state.pid)).toBeUndefined();
  expect(f.supervisor.job(state.job)).toMatchObject({ ownerPid, leaderPid: state.pid, foreground: true, leaderResult: null });
  expect(f.supervisor.canWaitJob(ownerPid, state.job)).toBe(true);
  const member = f.client(f.broker.get(memberPid)!);
  member.exit(7); await f.flush();
  expect(f.supervisor.waitJob(ownerPid, state.job)).toEqual({ kind: "exited", code: 126, status: 126 });
});

test("worker transfer release follows published commit or failed cancellation confirmation", () => {
  const f = fixture();
  const order: string[] = [];
  const client = new WorkerProcessClient({ ...f.root.options, prepareSpawn() { return {
    commit() { expect(f.messages.length).toBe(1); order.push("commit"); },
    release() { order.push("release"); },
  }; } });
  client.spawn(1, request());
  expect(order).toEqual(["commit", "release"]);
  const failed = new WorkerProcessClient({ ...f.root.options,
    postMessage() { throw new Error("publication failed"); },
    prepareSpawn() { return {
      cancel() { order.push("cancel"); },
      release() {
        const state = workerProcessState({ ...f.transport, slot: 2 });
        expect(Atomics.load(state.confirmed, 0)).toBe(1);
        expect(Atomics.load(state.jobConfirmed, 0)).toBe(1);
        expect(Atomics.load(state.jobPending, 0)).toBe(0);
        order.push("failed-release");
      },
    }; },
  });
  expect(() => failed.spawn(1, request())).toThrow("publication failed");
  expect(order).toEqual(["commit", "release", "cancel", "failed-release"]);
});

test("broker disposal preserves safe confirmation after listener cleanup without awaiting physical termination", async () => {
  let finishFence!: () => void, finishTermination!: () => void;
  const fence = new Promise<void>(resolve => { finishFence = resolve; });
  const termination = new Promise<void>(resolve => { finishTermination = resolve; });
  let terminationStarted = false, physicallyTerminated = false;
  const f = fixture({ quiesce: () => fence, terminate() {
    terminationStarted = true;
    return termination.then(() => { physicallyTerminated = true; });
  } });
  const pid = f.root.spawn(1, request()); await f.flush(); await f.supervisor.start(pid);
  const transport = f.broker.get(pid)!;
  const state = workerProcessState(transport);
  try {
    f.broker.dispose();
    // Embeddings may immediately dispose their supervisor and remove every listener too.
    f.supervisor.dispose();
    expect(terminationStarted).toBe(true);
    expect(physicallyTerminated).toBe(false);
    expect(f.broker.get(pid)).toBeUndefined();
    expect(f.broker.getIdentity(pid)).toBeUndefined();
    expect(Atomics.load(state.confirmed, 0)).toBe(0);
    expect(Atomics.load(state.jobConfirmed, 0)).toBe(0);
    expect(f.root.wait(1, pid)).toBeNull();
    const before = Atomics.load(state.wake, 0);
    finishFence(); await fence; await Promise.resolve();
    expect(physicallyTerminated).toBe(false);
    expect(Atomics.load(state.confirmed, 0)).toBe(1);
    expect(Atomics.load(state.jobConfirmed, 0)).toBe(1);
    expect(Atomics.load(state.jobPending, 0)).toBe(0);
    expect(Atomics.load(state.wake, 0)).toBeGreaterThan(before);
    expect(f.root.wait(1, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { finishFence(); finishTermination(); await termination; }
});

test("broker disposal remains unconfirmed when the host-work fence fails", async () => {
  let failFence!: (error: unknown) => void;
  const fence = new Promise<void>((_resolve, reject) => { failFence = reject; });
  const f = fixture({ quiesce: () => fence });
  const pid = f.root.spawn(1, request()); await f.flush();
  const state = workerProcessState(f.broker.get(pid)!);
  f.broker.dispose(); f.supervisor.dispose();
  failFence(new Error("fence failed"));
  await fence.catch(() => {}); await Promise.resolve();
  expect(Atomics.load(state.confirmed, 0)).toBe(0);
  expect(Atomics.load(state.jobConfirmed, 0)).toBe(0);
  expect(f.root.wait(1, pid)).toBeNull();
  expect(f.broker.getIdentity(pid)).toBeUndefined();
});
