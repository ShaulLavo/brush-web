import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, webkit, type Browser } from "../../web/node_modules/playwright";

// Own all resources before setup: ephemeral listener, browser/process profile, and build output.
let scratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let cleaning: Promise<void> | undefined;
const previousTmp = process.env.TMPDIR;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
      if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("storage browser tests timed out"); void cleanup().finally(() => process.exit(1)); }, 90_000);
try {
  scratch = await mkdtemp("/work/tmp/bun-wasm-storage-");
  process.env.TMPDIR = scratch;
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "storage-browser.ts")], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, "Storage test bundle failed");
  const script = build.outputs[0]!;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/tests.js" ? new Response(script, { headers: { "content-type": "text/javascript" } })
      : new Response("<!doctype html><title>Storage tests</title>", { headers: { "content-type": "text/html" } });
  } });
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]) {
    const engine = { chromium, firefox, webkit }[name];
    if (!engine) throw new Error(`Unknown browser: ${name}`);
    launch = engine.launch({ headless: true, downloadsPath: scratch, tracesDir: scratch }); browser = await launch;
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const passed = await page.evaluate(async filter => {
      const modulePath = "/tests.js";
      const module = await import(modulePath);
      return module.runStorageTests(filter) as Promise<string[]>;
    }, process.env.STORAGE_TEST_FILTER);
    console.log(`${name} ${browser.version()}: ${passed.length} storage tests passed`);
    for (const label of passed) console.log(`  ${label}`);
    await browser.close(); browser = undefined; launch = undefined;
  }
} finally { clearTimeout(deadline); await cleanup(); }
