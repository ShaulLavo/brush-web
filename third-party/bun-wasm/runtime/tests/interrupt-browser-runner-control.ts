/** Host-only runner teardown. A responsive browser gets rescue grace, but a wedged page
 * must never prevent physical teardown of browsers, listeners and temporary files.
 */
export interface InterruptCleanupStep { name: string; run(): void | Promise<void>; timeoutMs?: number; }
export interface InterruptCleanupResult { name: string; ok: boolean; error?: string; }
export async function cleanupInterruptResources(steps: readonly InterruptCleanupStep[]): Promise<InterruptCleanupResult[]> {
  const results: InterruptCleanupResult[] = [];
  for (const step of steps) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = Promise.resolve().then(() => step.run());
      if (step.timeoutMs === undefined) await operation;
      else await Promise.race([operation, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`${step.name} exceeded ${step.timeoutMs} ms grace`)), step.timeoutMs);
      })]);
      results.push({ name: step.name, ok: true });
    } catch (error) { results.push({ name: step.name, ok: false, error: String(error) }); }
    finally { if (deadline !== undefined) clearTimeout(deadline); }
  }
  return results;
}
/** Normal completion, watchdog and signals use the same finalizer, including durable failure output. */
export async function finishInterruptCleanup<T>(cleanup: () => Promise<T>, persist: () => Promise<void>): Promise<T> {
  try { return await cleanup(); } finally { await persist(); }
}
