import { parentPort, workerData } from "node:worker_threads";
import { ProcessABI, type ProcessService } from "../../proc/abi";
import { readOutcome } from "../../proc/outcome";
import type { SignalTransport } from "../../proc/signals";
import { DescriptorTable } from "../../core/descriptors";
import { MemFS } from "../../fs/memory";

const { mode, pid, child, childOutcome, wake, signals } = workerData as {
  mode: "signal" | "child"; pid: number; child: number; childOutcome: BigInt64Array; wake: Int32Array; signals: SignalTransport;
};
const descriptors = new DescriptorTable();
const memory = new WebAssembly.Memory({ initial: 1 });
const unused = (): never => { throw new Error("unexpected process service operation"); };
// The parent's real local supervisor publishes this outcome without notifying the pipe wake.
const service: ProcessService = { spawn: unused, wait: () => readOutcome(childOutcome), kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused };
const abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid, service, signals, wake });
const view = new DataView(memory.buffer);
const fd = descriptors.open({ kind: "pipe", notification: wake, read: unused, write: unused, readiness: () => ({ readable: false, writable: false, hangup: false }) }, (1n << 29n) - 1n, 0n);
view.setUint32(256, mode === "child" ? 2 : 0, true);
view.setUint32(260, mode === "child" ? child : fd, true);
view.setBigUint64(264, 77n, true);
const wait = Atomics.wait;
Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
  parentPort!.postMessage({ phase: "waiting" });
  return Reflect.apply(wait, Atomics, args);
}) as typeof Atomics.wait;
try {
  const ready = abi.imports.poll!(256, 1, -1, 512);
  parentPort!.postMessage({ phase: "done", ready, interrupt: Atomics.load(signals.interrupt, 0), code: mode === "child" ? readOutcome(childOutcome)!.code : 0 });
} finally { Atomics.wait = wait; descriptors.dispose(); }
