import { InterruptWord } from "./fixtures/interrupt-browser-loops";

export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function until(condition: () => boolean, label: string, timeout = 5000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!condition()) { if (performance.now() > deadline) throw new Error(`${label} timed out`); await pause(2); }
}
interface OwnedWorker { worker: Worker; words?: Int32Array; settled: boolean; rescueTimer?: ReturnType<typeof setTimeout>; }
const workers = new Set<OwnedWorker>();
export function ownInterruptWorker(words?: Int32Array): OwnedWorker {
  const owned: OwnedWorker = { worker: new Worker("/interrupt-browser-worker.js", { type: "module" }), words, settled: false };
  workers.add(owned);
  // Independent of any rewriter/worker callback. Rescue NEVER counts as interrupt success.
  if (words) owned.rescueTimer = setTimeout(() => Atomics.store(words, InterruptWord.rescue, 1), 10_000);
  return owned;
}
export async function releaseInterruptWorker(owned: OwnedWorker): Promise<void> {
  if (owned.rescueTimer) clearTimeout(owned.rescueTimer);
  if (owned.words) {
    Atomics.store(owned.words, InterruptWord.rescue, 1);
    // Give the original, host-call-free rescue a chance before Safari terminate().
    await until(() => owned.settled, "rescue acknowledgement", 1000).catch(() => undefined);
  }
  owned.worker.terminate(); workers.delete(owned);
}
export async function cleanInterruptWorkers(): Promise<void> {
  // Publish every rescue first; never await one while another stays in an infinite loop.
  for (const owned of workers) if (owned.words) Atomics.store(owned.words, InterruptWord.rescue, 1);
  await Promise.all(Array.from(workers, releaseInterruptWorker));
}
if (typeof addEventListener === "function") addEventListener("pagehide", () => {
  for (const owned of workers) {
    if (owned.words) Atomics.store(owned.words, InterruptWord.rescue, 1);
    owned.worker.terminate();
  }
});
