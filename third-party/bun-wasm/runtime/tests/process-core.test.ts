import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { ExecutableRegistry, FirstSpawnStub, ProcessIdentityAllocator, ProcessSupervisor, Signal, SignalDisposition, SIGNAL_PENDING, createSignalState, signalDisposition, setSignalDisposition, publishSignal, requestSignal, takeSignal, outcomeWord, claimOutcome, type ProcessContext, type SpawnRequest } from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  executable: "fixture", argv: ["fixture"], env: {}, cwd: "/", job: 0, fds: [], ...overrides,
});
function fixture() {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const terminated: number[] = [];
  const supervisor = new ProcessSupervisor({ registry, launch(context) {
    contexts.set(context.pid, context);
    return { terminate() { terminated.push(context.pid); } };
  } });
  const root = supervisor.createRoot();
  return { registry, supervisor, root, contexts, terminated };
}

for (const recovery of ["retry", "dispose"] as const) test(`throwing completion gate stays pending and permits ${recovery} cleanup`, async () => {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  let throwGate = true, closed = 0, revoked = 0, terminated = 0;
  const supervisor = new ProcessSupervisor({ registry,
    launch: () => ({ terminate() { terminated++; } }),
    canConfirmExit() { if (throwGate) throw new Error("completion gate failed"); return true; },
  });
  try {
    const root = supervisor.createRoot(), pid = supervisor.reserveSpawn(root, request());
    await supervisor.start(pid);
    supervisor.get(pid)!.descriptors.open({ kind: "directory", handle: 42 }, 7n, 3n, () => closed++);
    supervisor.registerRevocation(pid, () => revoked++);
    expect(() => supervisor.exit(pid, 23)).toThrow("completion gate failed");
    expect(supervisor.get(pid)!.result).toBeNull();
    expect(supervisor.get(pid)!.revoked).toBe(false);
    expect([closed, revoked, terminated]).toEqual([0, 0, 0]);
    if (recovery === "retry") {
      throwGate = false;
      supervisor.exit(pid, 23);
      expect(supervisor.wait(root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
    } else supervisor.dispose();
    expect([closed, revoked, terminated]).toEqual([1, 1, 1]);
  } finally { supervisor.dispose(); }
});

test("shared allocators reserve independent pid and job number spaces without reuse", () => {
  const first = new ProcessIdentityAllocator();
  const second = new ProcessIdentityAllocator(first.buffer);
  expect(first.pid()).toBe(1);
  expect(second.pid()).toBe(2);
  expect(second.job()).toBe(1);
  expect(first.pid()).toBe(3);
  expect(first.job()).toBe(2);
});

test("registry shares concurrent compilation by loader, not executable name or adapter", async () => {
  const registry = new ExecutableRegistry();
  let loads = 0;
  const compilation = deferred<WebAssembly.Module>();
  const load = () => { loads++; return compilation.promise; };
  registry.register("a", { module: load, adapter: "preview1" });
  registry.register("b", { module: load, adapter: "other" });
  const a = registry.resolve("a"), b = registry.resolve("b");
  compilation.resolve(module);
  expect((await a).module).toBe(module);
  expect((await b).adapter).toBe("other");
  expect(loads).toBe(1);
});

test("first-spawn returns and retains arbitrary descriptor references before activation", async () => {
  const { supervisor, root, contexts } = fixture();
  let closed = 0;
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open({ kind: "directory", handle: 42 }, 7n, 3n, () => closed++);
  const activation = deferred<ProcessSupervisor>();
  let activations = 0;
  const stub = new FirstSpawnStub({
    reserve: (parent, spec) => supervisor.reserveSpawn(parent, spec),
    activate: () => { activations++; return activation.promise; },
    fail: (pid, error) => supervisor.failStart(pid, error),
  });
  const pid = stub.spawn(root, request({ fds: [{ child: 9, parent: fd }] }));
  descriptors.close(fd);
  expect(supervisor.wait(root, pid)).toBeNull();
  expect(closed).toBe(0);
  expect(contexts.size).toBe(0);
  let unrelatedTask = false;
  await new Promise<void>(resolve => setTimeout(() => { unrelatedTask = true; resolve(); }, 0));
  expect(unrelatedTask).toBe(true);
  expect(contexts.size).toBe(0);
  const sibling = stub.spawn(root, request());
  activation.resolve(supervisor);
  await stub.activated();
  await supervisor.start(pid);
  await supervisor.start(sibling);
  expect(activations).toBe(1);
  expect(contexts.get(pid)!.descriptors.get(9)!.resource).toEqual({ kind: "directory", handle: 42 });
  contexts.get(pid)!.exit(3);
  contexts.get(sibling)!.exit(0);
  expect(await supervisor.waitForExit(root, pid)).toEqual({ kind: "exited", code: 3, status: 3 });
  expect(closed).toBe(1);
});

test("activation rejection becomes exit 126 for every reserved child and releases fds", async () => {
  const { supervisor, root } = fixture();
  const stub = new FirstSpawnStub({
    reserve: (parent, spec) => supervisor.reserveSpawn(parent, spec),
    activate: async () => { throw new Error("chunk unavailable"); },
    fail: (pid, error) => supervisor.failStart(pid, error),
  });
  const a = stub.spawn(root, request()), b = stub.spawn(root, request());
  expect(await supervisor.waitForExit(root, a)).toEqual({ kind: "exited", code: 126, status: 126 });
  expect(await supervisor.waitForExit(root, b)).toEqual({ kind: "exited", code: 126, status: 126 });
});

test("missing and unrunnable executables report 127/126 via wait and child-exit events", async () => {
  const { registry, supervisor, root } = fixture();
  registry.register("bad", { module: async () => { throw new Error("invalid wasm"); }, adapter: "preview1" });
  const events: number[] = [];
  const unsubscribe = supervisor.onChildExit(event => events.push(event.pid));
  const missing = supervisor.spawn(root, request({ executable: "missing" }));
  const bad = supervisor.spawn(root, request({ executable: "bad" }));
  expect(await supervisor.waitForExit(root, missing)).toEqual({ kind: "exited", code: 127, status: 127 });
  expect(await supervisor.waitForExit(root, bad)).toEqual({ kind: "exited", code: 126, status: 126 });
  expect(events.sort()).toEqual([missing, bad].sort());
  expect(supervisor.wait(root, missing)).toEqual({ kind: "exited", code: 127, status: 127 });
  supervisor.reap(root, missing);
  expect(() => supervisor.wait(root, missing)).toThrow();
  unsubscribe();
});

test("spawn snapshots request data and atomically rejects bad descriptor bindings", async () => {
  const { supervisor, root, contexts } = fixture();
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open({ kind: "directory", handle: 1 }, 7n, 3n);
  const description = descriptors.get(fd)!.description;
  expect(() => supervisor.spawn(root, request({ fds: [{ child: 3, parent: fd }, { child: 4, parent: 999 }] }))).toThrow();
  expect(description.references).toBe(1);
  expect(() => supervisor.spawn(root, request({ fds: [{ child: 3, parent: fd }, { child: 3, parent: fd }] }))).toThrow();
  expect(description.references).toBe(1);
  const spec = request({ argv: ["original"], env: { A: "original" } });
  const pid = supervisor.spawn(root, spec);
  spec.argv[0] = "changed";
  spec.env.A = "changed";
  await supervisor.start(pid);
  expect(contexts.get(pid)!.request.argv).toEqual(["original"]);
  expect(contexts.get(pid)!.request.env).toEqual({ A: "original" });
  contexts.get(pid)!.exit(0);
  descriptors.dispose();
});

test("supervisor validates both fd bindings within the signed WASM success range before retaining", () => {
  const { supervisor, root } = fixture();
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open({ kind: "directory", handle: 1 }, 7n, 3n);
  const source = descriptors.get(fd)!;
  try {
    for (const invalid of [0x80000000, 0xffffffff, -1, 1.5, NaN]) {
      for (const binding of [{ child: invalid, parent: fd }, { child: 3, parent: invalid }]) {
        let error: unknown;
        try { supervisor.reserveSpawn(root, request({ fds: [binding] })); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ name: "ProcessError", errno: 28 });
        expect(source.description.references).toBe(1);
      }
    }
    descriptors.inherit(0x7fffffff, source);
    const pid = supervisor.reserveSpawn(root, request({ fds: [{ child: 0x7fffffff, parent: 0x7fffffff }] }));
    const child = supervisor.get(pid)!.descriptors;
    expect(child.get(0x7fffffff)!.description).toBe(source.description);
    const duplicate = child.dup(0x7fffffff);
    expect(duplicate).toBeGreaterThanOrEqual(0);
    expect(duplicate).toBeLessThanOrEqual(0x7fffffff);
    expect(child.get(duplicate)!.description).toBe(source.description);
  } finally { supervisor.dispose(); }
});

test("kill records signal, interrupts, revokes and publishes logical exit before teardown", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  const order: string[] = [];
  context.registerRevocation(() => {
    expect(Atomics.load(context.interrupt, 0)).toBe(Signal.SIGINT);
    expect(Atomics.load(context.requestedSignal, 0)).toBe(Signal.SIGINT);
    order.push("revoked");
  });
  supervisor.onChildExit(event => { if (event.pid === pid) order.push("exit"); });
  supervisor.kill(pid, Signal.SIGINT);
  // No guest checkpoint or default-action acknowledgement is needed.
  expect(order).toEqual(["revoked", "exit"]);
  expect(terminated).toEqual([pid]);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGINT, status: 130 });
  expect(Atomics.exchange(context.interrupt, 0, 0)).toBe(Signal.SIGINT);
  expect(Atomics.load(context.requestedSignal, 0)).toBe(Signal.SIGINT);
  context.exit(0); // Late zombie messages cannot change recorded cancellation.
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGINT, status: 130 });
});

test("killJob includes same-job descendants but preserves explicit background jobs", async () => {
  const { supervisor, root, contexts } = fixture();
  const foreground = supervisor.spawn(root, request());
  const background = supervisor.spawn(root, request({ job: -1 }));
  await supervisor.start(foreground);
  await supervisor.start(background);
  const child = supervisor.spawn(foreground, request({ job: supervisor.jobOf(foreground) }));
  await supervisor.start(child);
  const descendant = supervisor.spawn(child, request({ job: -1 }));
  await supervisor.start(descendant);
  expect(supervisor.jobOf(child)).toBe(supervisor.jobOf(foreground));
  expect(supervisor.jobOf(descendant)).not.toBe(supervisor.jobOf(foreground));
  expect(supervisor.job(supervisor.jobOf(background))!.foreground).toBe(false);
  supervisor.killJob(supervisor.jobOf(foreground), Signal.SIGTERM);
  for (const pid of [foreground, child]) {
    expect(supervisor.get(pid)!.result).toEqual({ kind: "signaled", code: Signal.SIGTERM, status: 143 });
  }
  expect(Atomics.load(contexts.get(descendant)!.interrupt, 0)).toBe(0);
  expect(supervisor.wait(child, descendant)).toBeNull();
  contexts.get(descendant)!.exit(0);
  expect(supervisor.wait(root, background)).toBeNull();
  contexts.get(background)!.exit(11);
  expect(await supervisor.waitForExit(root, background)).toEqual({ kind: "exited", code: 11, status: 11 });
});

test("pending processes killed before module activation never launch", async () => {
  const { registry, supervisor, root, contexts } = fixture();
  const activation = deferred<WebAssembly.Module>();
  registry.register("slow", { module: () => activation.promise, adapter: "preview1" });
  const pid = supervisor.spawn(root, request({ executable: "slow" }));
  const starting = supervisor.start(pid);
  supervisor.kill(pid, Signal.SIGKILL);
  activation.resolve(module);
  await starting;
  expect(contexts.has(pid)).toBe(false);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGKILL, status: 137 });
});

test("late asynchronous launch handles are terminated and late revocation hooks run immediately", async () => {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  const handle = deferred<{ terminate(): void }>();
  let context!: ProcessContext, terminated = 0, revoked = 0;
  const supervisor = new ProcessSupervisor({ registry, launch(value) { context = value; return handle.promise; } });
  const root = supervisor.createRoot();
  const pid = supervisor.spawn(root, request());
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  supervisor.kill(pid, Signal.SIGPIPE);
  context.defaultSignal(Signal.SIGPIPE);
  context.registerRevocation(() => revoked++);
  handle.resolve({ terminate() { terminated++; } });
  await supervisor.start(pid);
  expect(terminated).toBe(1);
  expect(revoked).toBe(1);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: Signal.SIGPIPE, status: 141 });
});

test("adopted guest pid, job and signal buffers remain the authoritative identities", async () => {
  const { supervisor, contexts } = fixture();
  const root = supervisor.createRoot({ pid: 40, job: 20 });
  const interrupt = new Int32Array(new SharedArrayBuffer(4));
  const requestedSignal = new Int32Array(new SharedArrayBuffer(4));
  const pid = supervisor.reserveSpawn(root, request({ job: 20 }), { pid: 41, job: 20, interrupt, requestedSignal });
  expect(pid).toBe(41);
  await supervisor.start(pid);
  expect(contexts.get(pid)!.interrupt).toBe(interrupt);
  supervisor.kill(pid, Signal.SIGTERM);
  expect(Atomics.load(requestedSignal, 0)).toBe(Signal.SIGTERM);
  expect(supervisor.jobOf(pid)).toBe(20);
  expect(() => supervisor.reserveSpawn(root, request(), { pid: 41 })).toThrow();
});

test("revocation exceptions do not strand descriptors, waiters or other job members", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  contexts.get(a)!.registerRevocation(() => { throw new Error("broken resource"); });
  let secondHook = false;
  contexts.get(a)!.registerRevocation(() => { secondHook = true; });
  supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL);
  expect(secondHook).toBe(true);
  expect(await supervisor.waitForExit(root, a)).toEqual({ kind: "signaled", code: Signal.SIGKILL, status: 137 });
  expect(await supervisor.waitForExit(root, b)).toEqual({ kind: "signaled", code: Signal.SIGKILL, status: 137 });
  expect(terminated.sort()).toEqual([a, b].sort());
});

test("handled SIGINT may exit zero and pending requested signal never reclassifies a later trap", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const handled = supervisor.spawn(root, request());
  const crashed = supervisor.spawn(root, request());
  await supervisor.start(handled);
  await supervisor.start(crashed);
  setSignalDisposition(contexts.get(handled)!.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  setSignalDisposition(contexts.get(crashed)!.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  supervisor.kill(handled, Signal.SIGINT);
  expect(Atomics.exchange(contexts.get(handled)!.interrupt, 0, 0)).toBe(Signal.SIGINT);
  expect(supervisor.wait(root, handled)).toBeNull();
  expect(terminated).toEqual([]);
  contexts.get(handled)!.exit(0);
  expect(supervisor.wait(root, handled)).toEqual({ kind: "exited", code: 0, status: 0 });
  supervisor.kill(crashed, Signal.SIGINT);
  Atomics.exchange(contexts.get(crashed)!.interrupt, 0, 0);
  contexts.get(crashed)!.fail(new WebAssembly.RuntimeError("unrelated trap after handling"));
  expect(supervisor.wait(root, crashed)).toEqual({ kind: "exited", code: 126, status: 126 });
});

test("SIGKILL during a handler overrides later handled exits and default actions", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  setSignalDisposition(contexts.get(pid)!.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  supervisor.kill(pid, Signal.SIGINT);
  Atomics.exchange(contexts.get(pid)!.interrupt, 0, 0);
  supervisor.kill(pid, Signal.SIGKILL);
  contexts.get(pid)!.exit(0);
  contexts.get(pid)!.defaultSignal(Signal.SIGINT);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
});

test("handled EPIPE keeps its exit code but the explicit default SIGPIPE action reports141", async () => {
  const { supervisor, root, contexts } = fixture();
  const handled = supervisor.spawn(root, request()), unhandled = supervisor.spawn(root, request());
  await supervisor.start(handled);
  await supervisor.start(unhandled);
  contexts.get(handled)!.exit(23);
  contexts.get(unhandled)!.defaultSignal(Signal.SIGPIPE);
  expect(supervisor.wait(root, handled)).toEqual({ kind: "exited", code: 23, status: 23 });
  expect(supervisor.wait(root, unhandled)).toEqual({ kind: "signaled", code: 13, status: 141 });
});

test("reaping an ancestor preserves descendant job discovery and released pids cannot be reused", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  await supervisor.start(a);
  const descendant = supervisor.spawn(a, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(descendant);
  const job = supervisor.jobOf(a);
  contexts.get(a)!.exit(0);
  supervisor.reap(root, a);
  supervisor.killJob(job, Signal.SIGKILL);
  expect(supervisor.get(descendant)!.result!.status).toBe(137);
  expect(() => supervisor.reserveSpawn(root, request(), { pid: a })).toThrow();
});

test("descriptor cleanup exceptions still drain all references and dispose cancels pending starts", async () => {
  const { supervisor, root } = fixture();
  const descriptors = supervisor.get(root)!.descriptors;
  let releases = 0;
  const a = descriptors.open({ kind: "directory", handle: 1 }, 1n, 1n, () => { releases++; throw new Error("close failed"); });
  const b = descriptors.open({ kind: "directory", handle: 2 }, 1n, 1n, () => { releases++; });
  const pid = supervisor.reserveSpawn(root, request({ fds: [{ child: 3, parent: a }, { child: 4, parent: b }] }));
  descriptors.close(a);
  descriptors.close(b);
  const waiting = supervisor.waitForExit(root, pid);
  supervisor.dispose();
  expect((await waiting).status).toBe(137);
  expect(releases).toBe(2);
  expect(() => supervisor.spawn(root, request())).toThrow();
  supervisor.dispose();
});

test("job teardown tolerates exit observers reaping another target synchronously", async () => {
  const { supervisor, root } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  supervisor.onChildExit(event => {
    if (event.pid !== a) return;
    supervisor.kill(b, Signal.SIGKILL);
    supervisor.reap(root, b);
  });
  expect(() => supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL)).not.toThrow();
  supervisor.dispose();
});

test("identity exhaustion never wraps to a reused or negative pid", () => {
  const allocator = new ProcessIdentityAllocator();
  allocator.observePid(0x7ffffffe);
  expect(allocator.pid()).toBe(0x7fffffff);
  expect(() => allocator.pid()).toThrow("exhausted");
  expect(allocator.job()).toBe(1);
});

test("killJob records every member before any teardown callback can spawn more descendants", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  let rejected = false;
  contexts.get(a)!.registerRevocation(() => {
    expect(Atomics.load(contexts.get(b)!.requestedSignal, 0)).toBe(Signal.SIGKILL);
    try { supervisor.spawn(b, request()); }
    catch { rejected = true; }
  });
  supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL);
  expect(rejected).toBe(true);
});

test("job wait releases retained final-member metadata without affecting background descendants", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  await supervisor.start(a);
  const job = supervisor.jobOf(a);
  const b = supervisor.spawn(a, request({ job: -1 }));
  await supervisor.start(b);
  const descendantJob = supervisor.jobOf(b);
  contexts.get(a)!.exit(0);
  supervisor.reap(root, a);
  expect(supervisor.job(job)).toBeDefined();
  expect(supervisor.job(descendantJob)).toBeDefined();
  contexts.get(b)!.exit(0);
  supervisor.reap(a, b);
  expect(supervisor.waitJob(root, job)?.status).toBe(0);
  expect(supervisor.waitJob(root, descendantJob)?.status).toBe(0);
  expect(supervisor.job(job)).toBeUndefined();
  expect(supervisor.job(descendantJob)).toBeUndefined();
});

test("an already recorded job SIGKILL cannot be replaced by a reentrant handled exit", async () => {
  const { supervisor, root, contexts } = fixture();
  const a = supervisor.spawn(root, request());
  const b = supervisor.spawn(root, request({ job: supervisor.jobOf(a) }));
  await supervisor.start(a);
  await supervisor.start(b);
  contexts.get(a)!.registerRevocation(() => {
    supervisor.kill(b, Signal.SIGINT);
    contexts.get(b)!.exit(0);
  });
  supervisor.killJob(supervisor.jobOf(a), Signal.SIGKILL);
  expect(supervisor.wait(root, b)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(Atomics.load(contexts.get(b)!.interrupt, 0)).toBe(9);
});

test("explicit adopted job ids cannot be reused after their final member is reaped", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  const job = supervisor.jobOf(pid);
  await supervisor.start(pid);
  contexts.get(pid)!.exit(0);
  supervisor.reap(root, pid);
  expect(() => supervisor.reserveSpawn(root, request(), { job })).toThrow();
});

test("a guest-side SIGKILL recorded before a delayed broker notification wins an exit ACK", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  Atomics.store(context.requestedSignal, 0, Signal.SIGKILL);
  Atomics.store(context.interrupt, 0, Signal.SIGKILL);
  context.exit(0);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
});

test("observing an already delivered signal records it without publishing a second interrupt", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  setSignalDisposition(context.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  for (let request = 0; request < 2; request++) {
    Atomics.store(context.requestedSignal, 0, Signal.SIGINT);
    Atomics.store(context.interrupt, 0, Signal.SIGINT);
    expect(Atomics.exchange(context.interrupt, 0, 0)).toBe(Signal.SIGINT);
    supervisor.observeSignal(pid, Signal.SIGINT);
    expect(supervisor.get(pid)!.signal).toBe(Signal.SIGINT);
    expect(Atomics.load(context.interrupt, 0)).toBe(0);
  }
  context.exit(0);
  expect(supervisor.wait(root, pid)!.status).toBe(0);
});

test("observing an already published SIGKILL still revokes and completes the process", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  Atomics.store(contexts.get(pid)!.requestedSignal, 0, Signal.SIGKILL);
  supervisor.observeSignal(pid, Signal.SIGKILL);
  expect(supervisor.wait(root, pid)!.status).toBe(137);
});

for (const delivery of ["kill", "killJob", "defaultSignal", "observeSignal"] as const) {
  test(`${delivery} cannot downgrade a guest SIGKILL published before host observation`, async () => {
    const { supervisor, root, contexts } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    Atomics.store(context.requestedSignal, 0, Signal.SIGKILL);
    Atomics.store(context.interrupt, 0, Signal.SIGKILL);
    if (delivery === "killJob") supervisor.killJob(supervisor.jobOf(pid), Signal.SIGTERM);
    else supervisor[delivery](pid, Signal.SIGINT);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(Atomics.load(context.requestedSignal, 0)).toBe(9);
    expect(Atomics.load(context.interrupt, 0)).toBe(9);
    context.exit(0);
    expect(supervisor.wait(root, pid)!.status).toBe(137);
  });
}

for (const word of ["requestedSignal", "interrupt"] as const) {
  test(`SIGKILL winning a ${word} compare-exchange race cannot be overwritten`, async () => {
    const { supervisor, root, contexts } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    setSignalDisposition(context.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
    const original = Atomics.compareExchange;
    let raced = false;
    Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
      if (!raced && array === context[word]) {
        raced = true;
        Atomics.store(context.requestedSignal, 0, 9);
        Atomics.store(context.interrupt, 0, 9);
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try { supervisor.kill(pid, Signal.SIGINT); }
    finally { Atomics.compareExchange = original; }
    expect(raced).toBe(true);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(Atomics.load(context.requestedSignal, 0)).toBe(9);
    expect(Atomics.load(context.interrupt, 0)).toBe(9);
  });
}

test("persistent SIGKILL wins when its pending interrupt was consumed before a stale publication", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  const original = Atomics.compareExchange;
  setSignalDisposition(context.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  let raced = false;
  Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
    if (!raced && array === context.interrupt) {
      raced = true;
      Atomics.store(context.requestedSignal, 0, 9);
      Atomics.store(context.interrupt, 0, 9);
      Atomics.exchange(context.interrupt, 0, 0);
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try { supervisor.kill(pid, Signal.SIGINT); }
  finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(Atomics.load(context.requestedSignal, 0)).toBe(9);
  expect(Atomics.load(context.interrupt, 0)).toBe(9);
});

test("a terminal exit cannot be replaced by a later SIGKILL request", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  context.exit(23);
  supervisor.kill(pid, Signal.SIGKILL);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
  expect(Atomics.load(context.requestedSignal, 0)).toBe(0);
});

test("default action adopts a shared terminal winner even before its signal words are published", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  claimOutcome(context.outcome, { kind: "signaled", code: 9 });
  expect(() => context.defaultSignal()).not.toThrow();
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(Atomics.load(context.requestedSignal, 0)).toBe(9);
  expect(Atomics.load(context.interrupt, 0)).toBe(9);
});

test("a shared terminal winner prevents launch even before pending signal publication", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.reserveSpawn(root, request());
  claimOutcome(supervisor.get(pid)!.outcome, { kind: "signaled", code: 9 });
  await supervisor.start(pid);
  expect(contexts.size).toBe(0);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
});

test("a parent with a sealed terminal outcome cannot reserve descendants before host finalization", () => {
  const { supervisor, root } = fixture();
  claimOutcome(supervisor.get(root)!.outcome, { kind: "signaled", code: 9 });
  expect(() => supervisor.reserveSpawn(root, request())).toThrow();
});

test("signal state starts default, adopts all cells, and validates registration", () => {
  const state = createSignalState();
  expect(state.length).toBe(65);
  for (const sig of [2, 13, 15, 64]) expect(signalDisposition(state, sig)).toBe(SignalDisposition.DEFAULT);
  setSignalDisposition(state, 15, SignalDisposition.HANDLE);
  expect(createSignalState(state)).toBe(state);
  expect(signalDisposition(createSignalState(state.buffer as SharedArrayBuffer), 15)).toBe(SignalDisposition.HANDLE);
  for (const sig of [0, 9, 65, -1, 1.5]) expect(() => setSignalDisposition(state, sig, SignalDisposition.HANDLE)).toThrow();
  for (const mode of [-1, 3, 4, 1.5]) expect(() => setSignalDisposition(state, 2, mode)).toThrow();
  expect(() => createSignalState(new Int32Array(new SharedArrayBuffer(4)))).toThrow();
});

test("distinct pending signals coalesce individually and dequeue in signal order", () => {
  const state = createSignalState();
  for (const sig of [2, 13, 15]) setSignalDisposition(state, sig, SignalDisposition.HANDLE);
  expect(publishSignal(state, 15)).toBe("handled");
  expect(publishSignal(state, 2)).toBe("handled");
  expect(publishSignal(state, 13)).toBe("handled");
  expect(publishSignal(state, 2)).toBe("handled");
  expect(Atomics.load(state, 2)).toBe(SignalDisposition.HANDLE | SIGNAL_PENDING);
  expect([takeSignal(state), takeSignal(state), takeSignal(state), takeSignal(state)]).toEqual([2, 13, 15, 0]);
  expect(signalDisposition(state, 2)).toBe(SignalDisposition.HANDLE);
});

test("pending disposition changes ignore or select default atomically", () => {
  const state = createSignalState();
  setSignalDisposition(state, 13, SignalDisposition.HANDLE);
  publishSignal(state, 13);
  expect(setSignalDisposition(state, 13, SignalDisposition.IGNORE)).toBe(false);
  expect(takeSignal(state)).toBe(0);
  expect(publishSignal(state, 13)).toBe("ignore");
  setSignalDisposition(state, 2, SignalDisposition.HANDLE);
  publishSignal(state, 2);
  expect(setSignalDisposition(state, 2, SignalDisposition.DEFAULT)).toBe(true);
  expect(takeSignal(state)).toBe(0);
  expect(publishSignal(state, 15)).toBe("default");
  expect(publishSignal(state, 9)).toBe("default");
});

test("dequeue clears pending before a once handler restores default", () => {
  const state = createSignalState();
  setSignalDisposition(state, 2, SignalDisposition.HANDLE);
  publishSignal(state, 2);
  expect(takeSignal(state)).toBe(2);
  expect(setSignalDisposition(state, 2, SignalDisposition.DEFAULT)).toBe(false);
  expect(publishSignal(state, 2)).toBe("default");
});

for (const sig of [Signal.SIGINT, Signal.SIGTERM, Signal.SIGPIPE]) {
  test(`default signal ${sig} immediately revokes, terminates and preserves its typed outcome`, async () => {
    const { supervisor, root, contexts, terminated } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    let revoked = 0;
    contexts.get(pid)!.registerRevocation(() => revoked++);
    supervisor.kill(pid, sig);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: sig, status: 128 + sig });
    expect(revoked).toBe(1);
    expect(terminated).toEqual([pid]);
    contexts.get(pid)!.exit(0);
    expect(supervisor.wait(root, pid)!.kind).toBe("signaled");
  });
  test(`registered signal ${sig} leaves the guest's own exit authoritative`, async () => {
    const { supervisor, root, contexts, terminated } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    setSignalDisposition(context.signalState, sig, SignalDisposition.HANDLE);
    supervisor.kill(pid, sig);
    expect(supervisor.wait(root, pid)).toBeNull();
    expect(terminated).toEqual([]);
    expect(takeSignal(context.signalState)).toBe(sig);
    expect(setSignalDisposition(context.signalState, sig, SignalDisposition.DEFAULT)).toBe(false);
    supervisor.observeSignal(pid, sig);
    expect(takeSignal(context.signalState)).toBe(0);
    expect(supervisor.wait(root, pid)).toBeNull();
    context.exit(23);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
  });
}

test("ignored PIPE does not interrupt and preserves the EPIPE handler's exit", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  setSignalDisposition(context.signalState, 13, SignalDisposition.IGNORE);
  supervisor.kill(pid, 13);
  expect(Atomics.load(context.interrupt, 0)).toBe(0);
  expect(takeSignal(context.signalState)).toBe(0);
  expect(supervisor.wait(root, pid)).toBeNull();
  context.exit(23);
  expect(supervisor.wait(root, pid)!.status).toBe(23);
});

test("mixed jobs preclaim every default fatal outcome before reentrant teardown", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const a = supervisor.spawn(root, request());
  const job = supervisor.jobOf(a);
  const b = supervisor.spawn(root, request({ job }));
  const handled = supervisor.spawn(root, request({ job }));
  const ignored = supervisor.spawn(root, request({ job }));
  for (const pid of [a, b, handled, ignored]) await supervisor.start(pid);
  setSignalDisposition(contexts.get(handled)!.signalState, 15, SignalDisposition.HANDLE);
  setSignalDisposition(contexts.get(ignored)!.signalState, 15, SignalDisposition.IGNORE);
  let rejected = false;
  contexts.get(a)!.registerRevocation(() => {
    contexts.get(b)!.exit(0);
    try { supervisor.spawn(b, request()); } catch { rejected = true; }
  });
  supervisor.killJob(job, 15);
  expect(rejected).toBe(true);
  for (const pid of [a, b]) expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 15, status: 143 });
  expect(terminated.sort()).toEqual([a, b].sort());
  expect(takeSignal(contexts.get(handled)!.signalState)).toBe(15);
  expect(Atomics.load(contexts.get(ignored)!.interrupt, 0)).toBe(0);
  expect(supervisor.wait(root, handled)).toBeNull();
  expect(supervisor.wait(root, ignored)).toBeNull();
  supervisor.dispose();
});

test("adopted signal state is not reset and children start with independent defaults", async () => {
  const { supervisor, root, contexts } = fixture();
  setSignalDisposition(supervisor.get(root)!.signalState, 2, SignalDisposition.HANDLE);
  const state = createSignalState();
  setSignalDisposition(state, 15, SignalDisposition.HANDLE);
  const pid = supervisor.reserveSpawn(root, request(), { signalState: state });
  await supervisor.start(pid);
  expect(contexts.get(pid)!.signalState).toBe(state);
  expect(signalDisposition(state, 15)).toBe(SignalDisposition.HANDLE);
  expect(signalDisposition(state, 2)).toBe(SignalDisposition.DEFAULT);
  supervisor.dispose();
});


test("shared request preclaims default before delayed host observation", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  const result = requestSignal(context, 15);
  expect(result.action).toBe("default");
  expect(result.outcome).toEqual({ kind: "signaled", code: 15, status: 143 });
  setSignalDisposition(context.signalState, 15, SignalDisposition.HANDLE);
  context.exit(0);
  supervisor.observeSignal(pid, 15);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 15, status: 143 });
});

test("shared request does not replay handled root delivery on supervisor adoption", () => {
  const transport = {
    signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)),
    requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord(),
  };
  setSignalDisposition(transport.signalState, 2, SignalDisposition.HANDLE);
  expect(requestSignal(transport, 2)).toEqual({ action: "handled", outcome: null });
  expect(takeSignal(transport.signalState)).toBe(2);
  setSignalDisposition(transport.signalState, 2, SignalDisposition.DEFAULT);
  const { supervisor } = fixture();
  const root = supervisor.createRoot(transport);
  supervisor.observeSignal(root, 2);
  expect(supervisor.get(root)!.result).toBeNull();
  expect(supervisor.get(root)!.signalState).toBe(transport.signalState);
  expect(supervisor.get(root)!.outcome).toBe(transport.outcome);
  expect(takeSignal(transport.signalState)).toBe(0);
  supervisor.dispose();
});


for (const mode of [SignalDisposition.DEFAULT, SignalDisposition.IGNORE]) {
  test(`registration racing delivery classifies mode ${mode} without stale pending`, () => {
    const state = createSignalState();
    setSignalDisposition(state, 2, SignalDisposition.HANDLE);
    const original = Atomics.compareExchange;
    let raced = false;
    Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
      if (!raced && array === state && index === 2) {
        raced = true;
        setSignalDisposition(state, 2, mode);
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try { expect(publishSignal(state, 2)).toBe(mode === SignalDisposition.DEFAULT ? "default" : "ignore"); }
    finally { Atomics.compareExchange = original; }
    expect(raced).toBe(true);
    expect(Atomics.load(state, 2)).toBe(mode);
    expect(takeSignal(state)).toBe(0);
  });
}

test("default restoration racing a new pending delivery consumes it exactly once", () => {
  const state = createSignalState();
  setSignalDisposition(state, 15, SignalDisposition.HANDLE);
  const original = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
    if (!raced && array === state && index === 15) {
      raced = true;
      publishSignal(state, 15);
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try { expect(setSignalDisposition(state, 15, SignalDisposition.DEFAULT)).toBe(true); }
  finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  expect(Atomics.load(state, 15)).toBe(SignalDisposition.DEFAULT);
  expect(setSignalDisposition(state, 15, SignalDisposition.DEFAULT)).toBe(false);
});

test("dequeue racing ignore cannot deliver a stale handled signal", () => {
  const state = createSignalState();
  setSignalDisposition(state, 2, SignalDisposition.HANDLE);
  publishSignal(state, 2);
  const original = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
    if (!raced && array === state && index === 2) {
      raced = true;
      setSignalDisposition(state, 2, SignalDisposition.IGNORE);
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try { expect(takeSignal(state)).toBe(0); }
  finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  expect(Atomics.load(state, 2)).toBe(SignalDisposition.IGNORE);
});

for (const sig of [2, 13, 15]) {
  test(`default signal ${sig} prevents reserved and starting guests from launching`, async () => {
    const { supervisor, root, registry, contexts } = fixture();
    const reserved = supervisor.reserveSpawn(root, request());
    supervisor.kill(reserved, sig);
    await supervisor.start(reserved);
    const activation = deferred<WebAssembly.Module>();
    registry.register("slow", { module: () => activation.promise, adapter: "preview1" });
    const starting = supervisor.reserveSpawn(root, request({ executable: "slow" }));
    const launched = supervisor.start(starting);
    supervisor.kill(starting, sig);
    activation.resolve(module);
    await launched;
    for (const pid of [reserved, starting]) {
      expect(contexts.has(pid)).toBe(false);
      expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: sig, status: 128 + sig });
    }
    supervisor.dispose();
  });
}

test("changing pending handled signal to default selects immediate guest default action", async () => {
  const { supervisor, root, contexts, terminated } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  setSignalDisposition(context.signalState, 2, SignalDisposition.HANDLE);
  supervisor.kill(pid, 2);
  if (setSignalDisposition(context.signalState, 2, SignalDisposition.DEFAULT)) context.defaultSignal(2);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 2, status: 130 });
  expect(terminated).toEqual([pid]);
  expect(setSignalDisposition(context.signalState, 2, SignalDisposition.DEFAULT)).toBe(false);
});


for (const sig of [1, 10, 64]) {
  test(`self-raised signal ${sig} adopts its typed outcome without broadening kill`, async () => {
    const { supervisor, root, contexts } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    expect(() => supervisor.kill(pid, sig)).toThrow();
    expect(() => supervisor.killJob(supervisor.jobOf(pid), sig)).toThrow();
    expect(requestSignal(context, sig)).toEqual({ action: "default", outcome: { kind: "signaled", code: sig, status: 128 + sig } });
    expect(() => supervisor.observeSignal(pid, sig)).not.toThrow();
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: sig, status: 128 + sig });
  });
  test(`self-raised signal ${sig} handler removal can select explicit default action`, async () => {
    const { supervisor, root, contexts } = fixture();
    const pid = supervisor.spawn(root, request());
    await supervisor.start(pid);
    const context = contexts.get(pid)!;
    setSignalDisposition(context.signalState, sig, SignalDisposition.HANDLE);
    expect(requestSignal(context, sig).action).toBe("handled");
    expect(() => supervisor.observeSignal(pid, sig)).not.toThrow();
    expect(supervisor.wait(root, pid)).toBeNull();
    if (setSignalDisposition(context.signalState, sig, SignalDisposition.DEFAULT)) context.defaultSignal(sig);
    expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: sig, status: 128 + sig });
  });
}

test("generic self-raise rejects out-of-range signals and KILL bypasses raw ignore", async () => {
  const { supervisor, root, contexts } = fixture();
  const pid = supervisor.spawn(root, request());
  await supervisor.start(pid);
  const context = contexts.get(pid)!;
  for (const sig of [0, -1, 65, 1.5]) {
    expect(() => requestSignal(context, sig)).toThrow();
    expect(() => supervisor.observeSignal(pid, sig)).toThrow();
    expect(() => context.defaultSignal(sig)).toThrow();
  }
  Atomics.store(context.signalState, 9, SignalDisposition.IGNORE);
  expect(requestSignal(context, 9).outcome).toEqual({ kind: "signaled", code: 9, status: 137 });
  supervisor.observeSignal(pid, 9);
  expect(supervisor.wait(root, pid)!.status).toBe(137);
});


test("shared signal helper imports directly under Node strip-only TypeScript", () => {
  const url = new URL("../proc/signals.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const { createSignalState, requestSignal, setSignalDisposition, SignalDisposition, takeSignal } = await import(${JSON.stringify(url)});
    const transport = {
      signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)),
      requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: new BigInt64Array(new SharedArrayBuffer(8)),
    };
    setSignalDisposition(transport.signalState, 64, SignalDisposition.HANDLE);
    assert.equal(requestSignal(transport, 64).action, "handled");
    assert.equal(takeSignal(transport.signalState), 64);
    assert.throws(() => setSignalDisposition(transport.signalState, 9, SignalDisposition.IGNORE), { name: "ProcessError", errno: 28 });
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});


for (const finalizeParent of [false, true]) {
  test(`previously admitted foreground and background spawns survive lazy registration (parent finalized=${finalizeParent})`, async () => {
    const { supervisor, root, contexts } = fixture();
    const parent = supervisor.get(root)!;
    const foregroundOutcome = outcomeWord();
    claimOutcome(foregroundOutcome, { kind: "signaled", code: 2 });
    claimOutcome(parent.outcome, { kind: "signaled", code: 2 });
    if (finalizeParent) supervisor.observeSignal(root, 2);
    expect(() => supervisor.reserveSpawn(root, request())).toThrow();
    const state = createSignalState();
    setSignalDisposition(state, 15, SignalDisposition.HANDLE);
    const foreground = supervisor.reserveAdmittedSpawn(root, request({ job: parent.job }), {
      job: parent.job, signalState: state, outcome: foregroundOutcome,
    });
    const background = supervisor.reserveAdmittedSpawn(root, request({ job: -1 }), {});
    expect(supervisor.get(foreground)!.signalState).toBe(state);
    expect(signalDisposition(state, 15)).toBe(SignalDisposition.HANDLE);
    expect(supervisor.get(foreground)!.outcome).toBe(foregroundOutcome);
    await supervisor.start(foreground);
    await supervisor.start(background);
    expect(contexts.has(foreground)).toBe(false);
    expect(supervisor.wait(root, foreground)).toEqual({ kind: "signaled", code: 2, status: 130 });
    expect(contexts.has(background)).toBe(true);
    expect(supervisor.jobOf(background)).not.toBe(parent.job);
    expect(supervisor.wait(root, background)).toBeNull();
    let rejected = false;
    contexts.get(background)!.registerRevocation(() => {
      try { supervisor.spawn(root, request()); } catch { rejected = true; }
    });
    contexts.get(background)!.exit(23);
    expect(rejected).toBe(true);
    expect(supervisor.wait(root, background)).toEqual({ kind: "exited", code: 23, status: 23 });
    supervisor.dispose();
  });
}

test("admitted registration still validates identities, descriptors and supervisor lifetime", () => {
  const { supervisor, root } = fixture();
  claimOutcome(supervisor.get(root)!.outcome, { kind: "signaled", code: 2 });
  expect(() => supervisor.reserveAdmittedSpawn(root, request(), { pid: root })).toThrow();
  expect(() => supervisor.reserveAdmittedSpawn(root, request({ fds: [{ child: 0, parent: 99 }] }), {})).toThrow();
  expect(() => supervisor.reserveAdmittedSpawn(root, request({ job: -2 }), {})).toThrow();
  expect(() => supervisor.reserveAdmittedSpawn(999999, request(), {})).toThrow();
  supervisor.dispose();
  expect(() => supervisor.reserveAdmittedSpawn(root, request(), {})).toThrow();
});

test("spawn forks process-owned streams once and revokes before releasing inherited dups", () => {
  const { supervisor, root } = fixture();
  const events: string[] = [];
  const resources = new Map<number, import("../core/descriptors").Stream>();
  const parent = {
    kind: "pipe" as const,
    read: () => -6, write: () => 0,
    readiness: () => ({ readable: false, writable: true, hangup: false }),
    forProcess(pid: number) {
      events.push(`fork ${pid}`);
      const stream = { kind: "pipe" as const, read: () => -6, write: () => 0,
        readiness: this.readiness,
        revoke: () => events.push(`revoke ${pid}`),
        close: () => events.push(`close ${pid}`) };
      resources.set(pid, stream);
      return stream;
    },
    close: () => events.push("close parent"),
  };
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open(parent, 7n, 3n);
  const duplicate = descriptors.dup(fd);
  const pid = supervisor.reserveSpawn(root, request({ fds: [{ child: 1, parent: fd }, { child: 2, parent: duplicate }] }));
  expect(events).toEqual([`fork ${pid}`]);
  const child = supervisor.get(pid)!.descriptors;
  expect(child.get(1)!.resource).toBe(resources.get(pid));
  expect(child.get(1)!.description).toBe(child.get(2)!.description);
  descriptors.close(fd); descriptors.close(duplicate);
  expect(events).toEqual([`fork ${pid}`, "close parent"]);
  supervisor.kill(pid, 9);
  expect(events).toEqual([`fork ${pid}`, "close parent", `revoke ${pid}`, `close ${pid}`]);
  supervisor.dispose();
});

test("guest signalling authority stays with self, ancestors and the job owner", () => {
  const { supervisor, root } = fixture();
  const first = supervisor.reserveSpawn(root, request());
  const sibling = supervisor.reserveSpawn(root, request());
  const grandchild = supervisor.reserveSpawn(first, request({ job: supervisor.jobOf(first) }));
  expect(supervisor.canSignal(root, grandchild)).toBe(true);
  expect(supervisor.canSignal(first, grandchild)).toBe(true);
  expect(supervisor.canSignal(first, first)).toBe(true);
  expect(supervisor.canSignal(first, sibling)).toBe(false);
  expect(supervisor.canSignal(first, root)).toBe(false);
  expect(supervisor.canSignalJob(root, supervisor.jobOf(first))).toBe(true);
  expect(supervisor.canSignalJob(first, supervisor.jobOf(first))).toBe(false);
  supervisor.exit(first, 0);
  supervisor.reap(root, first);
  expect(supervisor.canSignal(root, grandchild)).toBe(true);
  expect(() => supervisor.canSignal(root, 123456)).toThrow("unknown process");
  expect(() => supervisor.canSignalJob(root, 123456)).toThrow("unknown job");
  supervisor.dispose();
});

test("child exit stays hidden from wait until every revocation hook and fd release finishes", () => {
  const { supervisor, root } = fixture();
  const pid = supervisor.reserveSpawn(root, request());
  const visible: unknown[] = [];
  supervisor.registerRevocation(pid, () => {
    visible.push(supervisor.wait(root, pid));
    supervisor.exit(pid, 99); // Reentrant cleanup cannot replace the chosen winner.
  });
  supervisor.get(pid)!.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
    readiness: () => ({ readable: true, writable: false, hangup: true }),
    close: () => visible.push(supervisor.wait(root, pid)) }, 0n, 0n);
  supervisor.kill(pid, 9);
  expect(visible).toEqual([null, null]);
  expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
  supervisor.dispose();
});

test.each([false, true])("inheritance shares descriptions without widening per-fd rights (fork=%s)", fork => {
  const { supervisor, root } = fixture();
  const stream = { kind: "pipe" as const, read: () => -6, write: () => 0,
    readiness: () => ({ readable: false, writable: true, hangup: false }),
    ...(fork ? { forProcess: () => ({ kind: "pipe" as const, read: () => -6, write: () => 0,
      readiness: () => ({ readable: false, writable: true, hangup: false }) }) } : {}) };
  const parent = supervisor.get(root)!.descriptors;
  const fd = parent.open(stream, 7n, 3n), dup = parent.dup(fd);
  parent.get(dup)!.rightsBase = 1n;
  parent.get(dup)!.rightsInheriting = 0n;
  const pid = supervisor.reserveSpawn(root, request({ fds: [{ child: 1, parent: fd }, { child: 2, parent: dup }] }));
  const child = supervisor.get(pid)!.descriptors;
  expect(child.get(1)!.description).toBe(child.get(2)!.description);
  expect([child.get(1)!.rightsBase, child.get(1)!.rightsInheriting]).toEqual([7n, 3n]);
  expect([child.get(2)!.rightsBase, child.get(2)!.rightsInheriting]).toEqual([1n, 0n]);
  supervisor.dispose();
});

test("failed endpoint inheritance removes only the reservation's new empty job", () => {
  const { supervisor, root } = fixture();
  const descriptors = supervisor.get(root)!.descriptors;
  let released = 0;
  const ready = descriptors.open({ kind: "pipe", read: () => 0, write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    forProcess: () => ({ kind: "pipe", read: () => 0, write: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: false }), close: () => released++ }) }, 0n, 0n);
  const failing = descriptors.open({ kind: "pipe", read: () => 0, write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    forProcess: () => { throw new Error("writer slots exhausted"); } }, 0n, 0n);
  const bindings = [{ child: 1, parent: ready }, { child: 2, parent: failing }];
  expect(() => supervisor.reserveSpawn(root, request({ fds: bindings }), { job: 200 })).toThrow("writer slots exhausted");
  expect(released).toBe(1);
  expect(supervisor.job(200)).toBeUndefined();
  const child = supervisor.reserveSpawn(root, request());
  const job = supervisor.jobOf(child);
  expect(() => supervisor.reserveSpawn(root, request({ job, fds: bindings }))).toThrow("writer slots exhausted");
  expect(released).toBe(2);
  expect(supervisor.job(job)!.members.has(child)).toBe(true);
  supervisor.dispose();
});
