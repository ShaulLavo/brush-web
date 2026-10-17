import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { chromium, firefox, webkit, type Browser, type BrowserContext } from "../../web/node_modules/playwright";

type Backend = "indexeddb" | "opfs";
type WorkerRequest = { kind: "list" } | { kind: "run"; backend: Backend; label: string };
type TestList = Record<Backend, string[]>;

// Bun strips the types before toString(): the worker has TypeScript source, not handwritten JS.
function storageWorker(): void {
  globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    try {
      const modulePath = "/tests.js";
      const tests = await import(modulePath) as typeof import("./storage-browser");
      const suites = { indexeddb: tests.storageTests(), opfs: tests.opfsStorageTests() };
      if (event.data.kind === "list") {
        globalThis.postMessage({ result: {
          indexeddb: suites.indexeddb.map(test => test.label), opfs: suites.opfs.map(test => test.label),
        } });
      } else {
        const { backend, label } = event.data;
        const test = suites[backend].find(test => test.label === label);
        if (!test) throw new Error(`Unknown ${backend} storage test: ${label}`);
        await test.run();
        globalThis.postMessage({ result: label });
      }
    } catch (error) {
      // WebKit's stack contains locations only: never let it replace the actual error message.
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
      const environment = {
        secureContext: globalThis.isSecureContext, crossOriginIsolated: globalThis.crossOriginIsolated,
        getDirectory: typeof navigator.storage?.getDirectory,
        syncAccess: typeof FileSystemFileHandle === "undefined" ? "undefined"
          : typeof (FileSystemFileHandle.prototype as FileSystemFileHandle & { createSyncAccessHandle?: unknown }).createSyncAccessHandle,
      };
      globalThis.postMessage({ error: `${detail}\nWorker environment: ${JSON.stringify(environment)}` });
    }
  };
}

// Own all resources before setup: ephemeral listener, contexts/workers, profiles and scratch.
let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
let firefoxScratch: string | undefined;
let firefoxScratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let persistentContext: BrowserContext | undefined;
let persistentLaunch: Promise<BrowserContext> | undefined;
let persistentProfile: string | undefined;
let persistentProfileCreation: Promise<string> | undefined;
let persistentShutdownFailed = false;
let cleaning: Promise<void> | undefined;
const previousTmp = process.env.TMPDIR;
async function closePersistent(): Promise<void> {
  const profile = persistentProfile ?? await persistentProfileCreation?.catch(() => undefined);
  const context = persistentContext ?? await persistentLaunch?.catch(() => undefined);
  // A rejection deliberately leaves all ownership records intact for the final cleanup retry.
  await context?.close();
  persistentContext = undefined; persistentLaunch = undefined;
  if (profile) await rm(profile, { recursive: true, force: true });
  persistentProfile = undefined; persistentProfileCreation = undefined;
}
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    let stopped = false;
    try {
      try { await closePersistent(); }
      finally { await (browser ?? await launch?.catch(() => undefined))?.close(); }
      stopped = true;
    } finally {
      server?.stop(true);
      try {
        scratch ??= await scratchCreation?.catch(() => undefined);
        firefoxScratch ??= await firefoxScratchCreation?.catch(() => undefined);
        if (stopped) {
          if (scratch) await rm(scratch, { recursive: true, force: true });
          if (firefoxScratch) await rm(firefoxScratch, { recursive: true, force: true });
        } else {
          console.error(`Browser shutdown unconfirmed; retaining task scratch ${scratch}, persistent profile ${persistentProfile}, Firefox scratch ${firefoxScratch}`);
        }
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
      }
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("storage browser tests timed out"); void cleanup().finally(() => process.exit(1)); }, 600_000);

/** Each case gets a fresh context/origin store, so browser quotas and leaked state cannot cross cases. */
async function inWorker<T>(browser: Browser, request: WorkerRequest, persistent = false): Promise<T> {
  if (cleaning || persistentShutdownFailed) throw new Error("Storage runner is shutting down");
  let context: BrowserContext | undefined;
  try {
    if (persistent) {
      // Register profile creation before awaiting it, so cleanup owns this allocation too.
      persistentProfileCreation = mkdtemp(resolve(scratch!, "webkit-opfs-profile-"));
      persistentProfile = await persistentProfileCreation;
      if (cleaning) throw new Error("Storage runner stopped before persistent browser launch");
      persistentLaunch = webkit.launchPersistentContext(persistentProfile, { headless: true, downloadsPath: scratch, tracesDir: scratch });
      context = persistentContext = await persistentLaunch;
    } else context = await browser.newContext();
    if (cleaning) throw new Error("Storage runner stopped before starting worker work");
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server!.port}`);
    return await page.evaluate(request => new Promise<T>((resolve, reject) => {
      const worker = new Worker("/worker.js", { type: "module" });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error("storage case worker timed out")); }, 45_000);
      const finish = () => { clearTimeout(timeout); worker.terminate(); };
      worker.onmessage = event => {
        finish();
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
      };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      worker.onmessageerror = () => { finish(); reject(new Error("Could not decode storage worker response")); };
      worker.postMessage(request);
    }), request);
  } finally {
    if (persistent) {
      try { await closePersistent(); }
      catch (error) { persistentShutdownFailed = true; throw error; }
    } else await context?.close();
  }
}

try {
  const scratchRoot = process.env.STORAGE_SCRATCH_ROOT ?? (process.platform === "darwin" ? resolve(homedir(), "tmp") : "/work/tmp");
  scratchCreation = mkdtemp(resolve(scratchRoot, "bun-wasm-storage-"));
  scratch = await scratchCreation;
  if (cleaning) throw new Error("Storage runner stopped during scratch creation");
  process.env.TMPDIR = scratch;
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "storage-browser.ts")], target: "browser" });
  if (cleaning) throw new Error("Storage runner stopped before server setup");
  if (!build.success) throw new AggregateError(build.logs, "Storage test bundle failed");
  const script = build.outputs[0]!;
  const workerScript = `(${storageWorker.toString()})();`;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    // Match the existing persistence harness's document and worker isolation policy.
    const headers = {
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
      "content-type": path === "/tests.js" || path === "/worker.js" ? "text/javascript" : "text/html",
    };
    if (path === "/tests.js") return new Response(script, { headers });
    if (path === "/worker.js") return new Response(workerScript, { headers });
    return new Response("<!doctype html><title>Storage tests</title>", { headers });
  } });
  const failures: string[] = [];
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]) {
    if (cleaning) throw new Error("Storage runner stopped before browser setup");
    const engine = { chromium, firefox, webkit }[name];
    if (!engine) throw new Error(`Unknown browser: ${name}`);
    // Firefox's profile must not live on /work's VDO filesystem. This tmpfs directory is
    // task-owned and removed after its browser stops; downloaded artifacts remain on /work.
    if (name === "firefox" && process.platform === "linux" && !firefoxScratch) {
      firefoxScratchCreation = mkdtemp("/dev/shm/bun-wasm-storage-firefox-");
      firefoxScratch = await firefoxScratchCreation;
    }
    if (cleaning) throw new Error("Storage runner stopped before browser launch");
    process.env.TMPDIR = name === "firefox" && firefoxScratch ? firefoxScratch : scratch;
    launch = engine.launch({ headless: true, downloadsPath: scratch, tracesDir: scratch }); browser = await launch;
    try {
      const listed = await inWorker<TestList>(browser, { kind: "list" });
      const passed: TestList = { indexeddb: [], opfs: [] };
      let selected = 0;
      for (const backend of ["indexeddb", "opfs"] as const) for (const label of listed[backend]) {
        if (process.env.STORAGE_TEST_FILTER && !label.includes(process.env.STORAGE_TEST_FILTER)) continue;
        selected++;
        // Mac Playwright WebKit 27.2 reports native OPFS UnknownError in ephemeral stores,
        // even with COOP/COEP. A fresh persistent profile passed the same case; keep a
        // separate disposable profile per OPFS case, not the owner's browser data.
        const persistent = name === "webkit" && backend === "opfs";
        const contextMode = persistent ? " [fresh persistent profile]" : "";
        try {
          await inWorker<string>(browser, { kind: "run", backend, label }, persistent);
          passed[backend].push(label);
          console.log(`  PASS ${name} ${backend}${contextMode}: ${label}`);
        } catch (error) {
          const failure = `${name} ${backend}${contextMode}: ${label}\n${String(error)}`;
          failures.push(failure); console.error(`  FAIL ${failure}`);
          if (persistentShutdownFailed || cleaning) throw error;
        }
      }
      if (selected === 0) throw new Error(`No storage cases match ${JSON.stringify(process.env.STORAGE_TEST_FILTER)}`);
      console.log(`${name} ${browser.version()}: ${passed.indexeddb.length} IndexedDB and ${passed.opfs.length} OPFS storage tests passed`);
    } finally { await browser.close(); browser = undefined; launch = undefined; }
  }
  if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), `${failures.length} storage browser test(s) failed`);
} finally { clearTimeout(deadline); await cleanup(); }
