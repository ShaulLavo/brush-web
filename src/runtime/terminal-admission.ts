// Original browser adapter: process-local admission for bounded shared-terminal critical sections.
import { SharedBridge, control } from "../bridge";

export interface TerminalAdmission {
  state: SharedArrayBuffer;
  buffers: SharedArrayBuffer[];
}
export function createTerminalAdmission(): TerminalAdmission {
  return { state: new SharedArrayBuffer(8), buffers: [] };
}
export function attachTerminal(admission: TerminalAdmission, buffer: SharedArrayBuffer): void {
  if (!admission.buffers.includes(buffer)) admission.buffers.push(buffer);
}
export function revokeTerminal(admission: TerminalAdmission): void {
  Atomics.store(new Int32Array(admission.state), 0, 1);
  for (const buffer of admission.buffers) new SharedBridge(buffer).signal();
}
/** Count before checking revocation. A revoke-then-zero observation proves later entrants
 * cannot acquire a ring lock. Never hold admission across a blocking read/write retry or await. */
export function terminalSection(admission: TerminalAdmission, operation: () => number): number {
  const cells = new Int32Array(admission.state);
  Atomics.add(cells, 1, 1);
  try {
    return Atomics.load(cells, 0) ? -29 : operation();
  } finally {
    if (Atomics.sub(cells, 1, 1) === 1) Atomics.notify(cells, 1);
  }
}
/** Browser terminate() has no physical-death acknowledgement. Fence live workers BEFORE
 * termination; never clear another worker's ring lock. A crashed holder cannot be recovered
 * safely: fail the whole affected terminal closed, rather than hang cleanup or reuse its lock. */
export async function quiesceTerminal(
  admission: TerminalAdmission,
  timeoutMs = 2000,
): Promise<boolean> {
  revokeTerminal(admission);
  const cells = new Int32Array(admission.state);
  const deadline = performance.now() + timeoutMs;
  while (Atomics.load(cells, 1)) {
    if (performance.now() >= deadline) {
      for (const buffer of admission.buffers) {
        const bridge = new SharedBridge(buffer);
        Atomics.store(bridge.state, control.status, 1);
        Atomics.store(bridge.state, control.phase, 4);
        bridge.close();
      }
      console.error("Shared terminal failed: a stopped process did not leave its I/O section");
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return true;
}
