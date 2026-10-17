import { rewriteInterrupts } from "../interrupt/rewriter";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { outcomeWord, readOutcome } from "../proc/outcome";
import { interruptFixtureMemory, interruptLoopFixture, interruptShapes, InterruptWord, type InterruptShape } from "./fixtures/interrupt-browser-loops";
import type { InterruptWorkerRequest } from "./fixtures/interrupt-browser-worker";
import { runInterruptBenchmarks } from "./interrupt-browser-benchmark";

import { cleanInterruptWorkers, ownInterruptWorker, pause, releaseInterruptWorker, until } from "./interrupt-browser-control";

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Negative controls prove teardown can rescue the actual running ORIGINAL CPU loops. */
async function rescueOriginal(module: WebAssembly.Module, shape: InterruptShape) {
  const memory = interruptFixtureMemory(), words = new Int32Array(memory.buffer), owned = ownInterruptWorker(words);
  let returned = false, error = "";
  owned.worker.onmessage = ({ data }) => {
    if (data.kind === "returned") { returned = true; owned.settled = true; }
    else if (data.kind !== "running") { error = data.error ?? data.kind; owned.settled = true; }
  };
  owned.worker.onerror = event => { event.preventDefault(); error = event.message; owned.settled = true; };
  try {
    owned.worker.postMessage({ kind: "loop", module, memory, shape, interrupt: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord() } satisfies InterruptWorkerRequest);
    await until(() => !!error || Atomics.load(words, InterruptWord.heartbeat) !== 0, "original guest heartbeat");
    check(!error, error);
    check(Atomics.load(words, InterruptWord.rescue) === 0, "original rescue fired before teardown");
    Atomics.store(words, InterruptWord.rescue, 1);
    await until(() => !!error || returned, "original rescue return acknowledgement");
    check(!error, error);
    check(Atomics.load(words, InterruptWord.returned) === 1 && Atomics.load(words, InterruptWord.trapped) === 0, "original did not return through rescue");
    return { shape, returned: true, trapped: false, originalUninstrumented: true };
  } finally { await releaseInterruptWorker(owned); }
}

async function cancellation(module: WebAssembly.Module, shape: InterruptShape, signal: 2 | 15, repetition: number) {
  const memory = interruptFixtureMemory(), words = new Int32Array(memory.buffer), owned = ownInterruptWorker(words);
  const registry = new ExecutableRegistry(); registry.register("interrupt-fixture", { module, adapter: "preview1" });
  let running = false, trapped = false, workerError = "", terminateRequests = 0, messageRescue = -1;
  const supervisor = new ProcessSupervisor({ registry, launch(context) {
    owned.worker.onmessage = ({ data }) => {
      if (data.kind === "running") running = true;
      else if (data.kind === "trapped") { trapped = true; messageRescue = data.rescue; owned.settled = true; context.fail(new Error(data.error)); }
      else if (data.kind === "returned") { owned.settled = true; context.exit(0); }
      else { owned.settled = true; workerError = data.error; context.fail(new Error(workerError)); }
    };
    owned.worker.onerror = event => { event.preventDefault(); workerError = event.message; owned.settled = true; context.fail(new Error(workerError)); };
    owned.worker.postMessage({ kind: "loop", module: context.module, memory, shape, interrupt: context.interrupt, outcome: context.outcome } satisfies InterruptWorkerRequest);
    // Deliberately do NOT physically terminate on the supervisor's request. A passing test
    // must prove injected shared-flag cancellation, not depend on browser terminate().
    return { terminate() { terminateRequests++; } };
  } });
  const root = supervisor.createRoot();
  const pid = supervisor.reserveSpawn(root, { executable: "interrupt-fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  try {
    await supervisor.start(pid);
    await until(() => !!workerError || (running && Atomics.load(words, InterruptWord.heartbeat) !== 0), "guest heartbeat");
    check(!workerError, workerError); check(Atomics.load(words, InterruptWord.rescue) === 0, "rescue fired before cancellation");
    await pause(10);
    const started = performance.now();
    const delivery = signal === 2 ? "Ctrl+C foreground job" : "SIGTERM process";
    if (signal === 2) supervisor.killJob(supervisor.jobOf(pid), signal);
    else supervisor.kill(pid, signal);
    const result = await supervisor.waitForExit(root, pid);
    check(result.kind === "signaled" && result.code === signal && result.status === 128 + signal, `wrong supervisor outcome ${JSON.stringify(result)}`);
    await until(() => !!workerError || (trapped && Atomics.load(words, InterruptWord.trapped) === 1), "shared trap AND message acknowledgement");
    check(!workerError, workerError);
    check(messageRescue === 0 && Atomics.load(words, InterruptWord.rescue) === 0, "rescue must not count as cancellation");
    check(Atomics.load(words, InterruptWord.returned) === 0, "guest returned rather than trapping");
    check(Atomics.load(supervisor.get(pid)!.interrupt, 0) !== 0, "no shared interrupt flag published");
    check(JSON.stringify(readOutcome(supervisor.get(pid)!.outcome)) === JSON.stringify(result), "terminal outcome changed after trap");
    const acknowledgedMs = performance.now() - started, heartbeat = Atomics.load(words, InterruptWord.heartbeat);
    await pause(30);
    check(Atomics.load(words, InterruptWord.heartbeat) === heartbeat, "heartbeat changed after acknowledged trap");
    check(terminateRequests === 1, "supervisor did not request physical teardown");
    check(supervisor.reap(root, pid).status === 128 + signal, "reaped status changed");
    return { shape, signal, delivery, repetition, status: result.status, acknowledgedMs, heartbeat, trapped: true, sharedTrapFlag: 1, messageRescue, terminateRequests, physicalTerminationDeferred: true };
  } finally { await releaseInterruptWorker(owned); supervisor.dispose(); }
}

export async function runInterruptBrowserTests(options: { repetitions?: number; benchmark?: boolean } = {}) {
  check(crossOriginIsolated, "interrupt gate requires COOP/COEP and SharedArrayBuffer");
  const original = interruptLoopFixture();
  check(WebAssembly.validate(original), "original loop fixture invalid (tail calls/threads required)");
  const rewritten = rewriteInterrupts(original), module = await WebAssembly.compile(rewritten);
  const cancellations = [], rescues = [];
  try {
    const originalModule = await WebAssembly.compile(original);
    for (const shape of interruptShapes) rescues.push(await rescueOriginal(originalModule, shape));
    for (let repetition = 0; repetition < (options.repetitions ?? 5); repetition++)
      for (const shape of interruptShapes) for (const signal of [2, 15] as const) cancellations.push(await cancellation(module, shape, signal, repetition));
    const benchmark = options.benchmark ? await runInterruptBenchmarks() : undefined;
    return { ok: true, userAgent: navigator.userAgent, crossOriginIsolated, rescues, cancellations, benchmark,
      qualifications: ["Termination is deliberately deferred until trap acknowledgement; no terminate-only guarantee is claimed.", "Latency samples are observations, not hard cancellation deadlines.", "Independent fixture rescue stays zero throughout measured cancellation and is set only in teardown."] };
  } finally { await cleanInterruptWorkers(); }
}
(globalThis as any).interruptHarness = { run: runInterruptBrowserTests, clean: cleanInterruptWorkers };
