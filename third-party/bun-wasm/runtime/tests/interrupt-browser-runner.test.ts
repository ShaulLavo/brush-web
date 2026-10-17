import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { cleanupInterruptResources, finishInterruptCleanup, type InterruptCleanupResult } from "./interrupt-browser-runner-control";

test("a never-resolving page evaluation has bounded grace, then real resources close and a failure report is persisted", async () => {
  let scratch: string | undefined, reportScratch: string | undefined, server: ReturnType<typeof Bun.serve> | undefined;
  const calls: string[] = [];
  let results: InterruptCleanupResult[] = [], port = 0;
  // Teardown exists before setup and repeats safely if the regression itself fails.
  try {
    const scratchRoot = existsSync("/work/tmp") ? "/work/tmp" : tmpdir();
    scratch = await mkdtemp(join(scratchRoot, "bun-wasm-interrupt-cleanup-"));
    reportScratch = await mkdtemp(join(scratchRoot, "bun-wasm-interrupt-report-"));
    await Bun.write(join(scratch, "fixture"), "task-owned");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch: () => new Response("task-owned") }); port = server.port!;
    const started = performance.now();
    await finishInterruptCleanup(async () => {
      results = await cleanupInterruptResources([
        { name: "pageRescue", timeoutMs: 20, run: () => { calls.push("evaluate"); return new Promise<void>(() => {}); } },
        { name: "browserClosed", run: () => { calls.push("physical close"); } },
        { name: "listenerStopped", run: () => { server!.stop(true); } },
        { name: "scratchRemoved", run: () => rm(scratch!, { recursive: true, force: true }) },
      ]);
    }, async () => { await Bun.write(join(reportScratch!, "failure.json"), JSON.stringify({ error: "deadline exceeded", cleanup: results })); });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(calls).toEqual(["evaluate", "physical close"]);
    expect(results[0]!.ok).toBe(false); expect(results[0]!.error).toContain("20 ms");
    expect(results.slice(1).every(result => result.ok)).toBe(true);
    expect(await Bun.file(join(scratch, "fixture")).exists()).toBe(false);
    const probe = Bun.serve({ hostname: "127.0.0.1", port, reusePort: false, fetch: () => new Response("rebound") }); probe.stop(true);
    const durable = await Bun.file(join(reportScratch, "failure.json")).json();
    expect(durable.error).toBe("deadline exceeded"); expect(durable.cleanup[0].ok).toBe(false);
  } finally {
    server?.stop(true);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (reportScratch) await rm(reportScratch, { recursive: true, force: true });
  }
});

test("one rejected physical cleanup does not skip later cleanup or durable failure output", async () => {
  const calls: string[] = []; let persisted = false;
  const results = await cleanupInterruptResources([
    { name: "browserClosed", run: () => { throw new Error("close failed"); } },
    { name: "listenerStopped", run: () => { calls.push("listener"); } },
    { name: "scratchRemoved", run: () => { calls.push("scratch"); } },
  ]);
  expect(results.map(result => result.ok)).toEqual([false, true, true]); expect(calls).toEqual(["listener", "scratch"]);
  await expect(finishInterruptCleanup(async () => { throw new Error("cleanup failed"); }, async () => { persisted = true; })).rejects.toThrow("cleanup failed");
  expect(persisted).toBe(true);
});
