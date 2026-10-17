import { readOutcome } from "../proc/outcome";

/** Injected checkpoints only unwind an already selected default action. They never consume
 * handled signals: our cooperative programs retain their normal handler-delivery checkpoint.
 * The immutable supervisor outcome, not a coincidental later trap, determines process status.
 */
export function fatalInterrupt(outcome: BigInt64Array | null): number {
  const selected = outcome && readOutcome(outcome);
  return selected && selected.kind === "signaled" ? selected.code : 0;
}
