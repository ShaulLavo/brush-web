import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, cp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, release } from "node:os";
import { createServer } from "node:net";
import { workerInstrumentation, browserInstrumentation } from "./performance-instrumentation.mjs";
const root = resolve(import.meta.dirname, "..");
const baselineSource = resolve(
  process.env.BRUSH_BASELINE_DIST ?? resolve(root, ".scratch/baseline-dist"),
);
const trials = Number(process.env.BRUSH_PROOF_TRIALS ?? 30);
const outputPath = resolve(
  process.env.BRUSH_PROOF_OUTPUT ?? resolve(root, "docs/evidence/performance-proof.json"),
);
if (!Number.isInteger(trials) || trials < 5 || trials > 100)
  throw new Error("Proof trials must be 5 to 100");
const fixtureDefinitions = [
  [
    "arithmetic-2000",
    "sum=0; for ((i=0;i<2000;i++)); do sum=$((sum+i)); done; echo sum:$sum",
    "sum:1999000",
  ],
  [
    "arithmetic-20000",
    "sum=0; for ((i=0;i<20000;i++)); do sum=$((sum+i)); done; echo sum:$sum",
    "sum:199990000",
  ],
  [
    "substitutions-100",
    `sum=0; for ((i=1;i<=100;i++)); do v=$(printf '%s' "$i"); sum=$((sum+v)); done; echo sub:$sum`,
    "sub:5050",
  ],
  [
    "substitutions-1000",
    `sum=0; for ((i=1;i<=1000;i++)); do v=$(printf '%s' "$i"); sum=$((sum+v)); done; echo sub:$sum`,
    "sub:500500",
  ],
  [
    "files-5000",
    "seq 5000 > source; cat source | cat > copy; mapfile -t lines < copy; echo file:${#lines[@]}:${lines[0]}:${lines[4999]}",
    "file:5000:1:5000",
  ],
  [
    "files-10000",
    "seq 10000 > source; cat source | cat > copy; mapfile -t lines < copy; echo file:${#lines[@]}:${lines[0]}:${lines[9999]}",
    "file:10000:1:10000",
  ],
  ["terminal-10000", "seq 10000", "10000"],
];
let browser;
const servers = [];
const artifacts = [];
const result = {
  recordedAt: new Date().toISOString(),
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  platform: platform(),
  kernel: release(),
  cpu: cpus()[0]?.model,
  browser: "",
  renderer: "canvas2d",
  terminalGrid:
    "same viewport; baseline disclosure hidden only during measurement to equalize mount height",
  trials,
  artifacts: [],
  samples: [],
  summary: [],
  functional: [],
  cleanup: {},
  resources: { portsCheckedFree: [], serverPids: [], temporaryBundles: artifacts },
  limitations: [
    "All input goes through real Ghostty keyboard input. Execution time is measured inside the browser worker from running to next prompt; it includes host I/O and output backpressure but excludes editing and terminal rendering.",
    "Visible completion includes browser polling and renderer frame submission, not physical display presentation. Fast workloads can hit this scheduling floor.",
    "Instrumentation adds per-import timestamp overhead to import-profiled runs. Separate runs with only phase timestamps measure worker and visible time.",
    "Baseline copied-file allocation/copy volumes are derived from the pinned shim exact-growth algorithm. Optimized allocation counters are direct profile measurements.",
    "just-bash host-import counters are not applicable; it executes in JavaScript and returns aggregate output. Its stock implementation and enabled command set remain unchanged.",
    "Only one bounded correction round is evaluated. Results on this host do not certify all devices, command coverage, concurrent pipelines or persistent storage.",
  ],
};
const q = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
function checkInterrupted() {
  if (result.interrupted) throw new Error("Proof interrupted");
}
async function checkPort(port) {
  checkInterrupted();
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  result.resources.portsCheckedFree.push(port);
}
async function freeze(source, index, instrumented) {
  checkInterrupted();
  const dir = await mkdtemp(resolve(root, ".scratch/proof-"));
  artifacts.push(dir);
  await cp(source, dir, { recursive: true });
  checkInterrupted();
  const names = await readdir(resolve(dir, "assets"));
  const assetHashes = await Promise.all(
    names
      .filter((name) => name.endsWith(".js") || name.endsWith(".wasm"))
      .map(async (name) => {
        const data = await readFile(resolve(dir, "assets", name));
        return {
          name,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
      }),
  );
  const worker = names.find((name) => name.startsWith("shell.worker-") && name.endsWith(".js"));
  if (!worker) throw new Error("Worker bundle missing");
  {
    const path = resolve(dir, "assets", worker);
    await writeFile(
      path,
      `globalThis.__profileIO=${instrumented};\n` +
        workerInstrumentation +
        "\n" +
        (await readFile(path, "utf8")),
    );
  }
  const bytes = await readFile(resolve(dir, "brush/brush-browser.wasm"));
  result.artifacts.push({
    label: index,
    instrumented,
    assetHashes,
    wasmBytes: bytes.length,
    wasmSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const port = 4200 + index;
  const server = spawn(process.execPath, [resolve(dir, "serve.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  servers.push(server);
  result.resources.serverPids.push(server.pid);
  for (let i = 0; i < 100; i++) {
    checkInterrupted();
    if (server.exitCode !== null) throw new Error("Proof server exited");
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return `http://127.0.0.1:${port}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Proof server on port ${port} did not become ready`);
}
async function open(base, engine, instrumented) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  await page.addInitScript(browserInstrumentation);
  await page.goto(
    `${base}/?test=1&renderer=canvas&engine=${engine}${instrumented && base.includes(":4201") ? "&profile=1" : ""}`,
  );
  await page.waitForFunction(() => window.brushWeb?.snapshot().state === "ready");
  await page.addStyleTag({ content: ".baseline-note {display:none!important}" });
  await page.waitForTimeout(60);
  await page.locator("textarea").focus();
  await page.evaluate(() => {
    window.targetMarker = "";
    window.submittedMarker = "";
    window.brushWeb.terminal.onFrame(() => {
      const marker = window.targetMarker;
      if (
        marker &&
        window.brushWeb.visibleLines().some((line) => line.trim().startsWith(marker + ":"))
      )
        window.submittedMarker = marker;
    });
  });
  return { context, page };
}
let sequence = 0;
async function submit(page, command, expected, instrumented) {
  const marker = `PROOF_${++sequence}`;
  const begin = marker + "_BEGIN";
  const before = await page.evaluate(() => window.performanceSamples.length);
  await page.evaluate((marker) => {
    window.targetMarker = marker;
    window.submittedMarker = "";
  }, marker);
  await page.keyboard.insertText(
    `printf '%s\\n' '${begin}'; ${command}; proof_status=$?; printf '\\n%s:%s\\n' '${marker}' "$proof_status"`,
  );
  const start = performance.now();
  await page.keyboard.press("Enter");
  await page.waitForFunction((marker) => window.submittedMarker === marker, marker, { polling: 4 });
  const visibleMs = performance.now() - start;
  const lines = await page.evaluate(() => window.brushWeb.readLines().map((line) => line.trim()));
  const statusLine = lines.findLast(
    (line) => line.startsWith(marker + ":") && /^\d+$/.test(line.slice(marker.length + 1)),
  );
  if (statusLine !== marker + ":0")
    throw new Error(`Workload failed ${statusLine}: ${lines.slice(-14).join(" | ")}`);
  const end = lines.lastIndexOf(statusLine);
  const beginIndex = lines.lastIndexOf(begin);
  const actual = lines.slice(beginIndex < 0 ? Math.max(0, end - 3) : beginIndex + 1, end);
  if (end < 0 || !actual.includes(expected)) throw new Error(`Incorrect result for ${command}`);
  let worker;
  {
    await page.waitForFunction((before) => window.performanceSamples.length > before, before, {
      polling: 4,
    });
    if (page.url().includes(":4201"))
      await page.waitForFunction(
        () =>
          window.brushWeb.metrics().lastExecution?.sequence ===
          window.performanceSamples.at(-1)?.sequence,
        null,
        { polling: 2 },
      );
    worker = await page.evaluate(() => ({
      external: window.performanceSamples.at(-1),
      direct: window.brushWeb.metrics().lastExecution,
    }));
  }
  return { visibleMs, worker };
}
async function replay(page) {
  return page.evaluate(async () => {
    const terminal = window.brushWeb.terminal;
    const bytes = new TextEncoder().encode(
      Array.from({ length: 10000 }, (_, index) => String(index + 1)).join("\r\n") +
        "\r\nREPLAY_DONE\r\n",
    );
    const times = [];
    for (let trial = 0; trial < 10; trial++) {
      const completed = new Promise((resolve) => {
        const subscription = terminal.onFrame(() => {
          if (window.brushWeb.visibleLines().some((line) => line.trim() === "REPLAY_DONE")) {
            subscription.dispose();
            resolve(performance.now());
          }
        });
      });
      terminal.write(new TextEncoder().encode("\x1b[H\x1b[2J"));
      const start = performance.now();
      for (let offset = 0; offset < bytes.length; offset += 32768)
        terminal.write(bytes.subarray(offset, offset + 32768));
      times.push((await completed) - start);
    }
    return {
      bytes: bytes.length,
      chunkBytes: 32768,
      trials: times,
      medianMs: times.toSorted((a, b) => a - b)[5],
    };
  });
}
async function checkInteraction(page, engine) {
  await page.evaluate(() => window.brushWeb.metrics().inputLatenciesMs.splice(0));
  await page.keyboard.type("echo latency-check", { delay: 35 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => window.brushWeb.readLines().some((line) => line.trim() === "latency-check"),
    null,
    { polling: 2 },
  );
  const delays = [];
  for (const command of ["while :; do :; done", "sleep 30"].concat(
    engine === "brush" ? ["cat"] : [],
  )) {
    await page.keyboard.insertText(command);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.brushWeb.snapshot().state === "running", null, {
      polling: 2,
    });
    const start = performance.now();
    await page.keyboard.press("Control+c");
    await page.waitForFunction(() => window.brushWeb.snapshot().state === "ready", null, {
      polling: 2,
    });
    delays.push({ command, recoveryMs: performance.now() - start });
  }
  const metrics = await page.evaluate(() => window.brushWeb.metrics());
  return {
    engine,
    interruptions: delays,
    inputFrameSamples: metrics.inputLatenciesMs,
    memoryBytes: metrics.memoryBytes,
  };
}
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const stopped = new Promise((resolve) => server.once("exit", resolve));
  const force = setTimeout(() => server.kill("SIGKILL"), 2000);
  try {
    server.kill("SIGTERM");
    await stopped;
  } finally {
    clearTimeout(force);
  }
}
async function stop() {
  const consumers = await Promise.allSettled(
    [browser?.isConnected() ? browser.close() : Promise.resolve()].concat(servers.map(stopServer)),
  );
  result.cleanup = {
    browsersClosed: consumers[0].status === "fulfilled",
    serversStopped: consumers.slice(1).every((entry) => entry.status === "fulfilled"),
    temporaryBundlesRemoved: false,
  };
  if (!result.cleanup.browsersClosed || !result.cleanup.serversStopped)
    throw new Error("Could not stop every benchmark consumer; temporary bundles retained");
  const removed = await Promise.allSettled(artifacts.map((dir) => rm(dir, { recursive: true })));
  result.cleanup.temporaryBundlesRemoved = removed.every((entry) => entry.status === "fulfilled");
  if (!result.cleanup.temporaryBundlesRemoved)
    throw new Error("Could not remove every temporary bundle");
}
function interrupt() {
  result.interrupted = true;
  process.exitCode = 130;
  void browser?.close().catch(() => undefined);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  for (const port of [4200, 4201, 4202, 4203]) await checkPort(port);
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  const bases = [
    await freeze(baselineSource, 0, true),
    await freeze(resolve(root, "dist"), 1, true),
    await freeze(baselineSource, 2, false),
    await freeze(resolve(root, "dist"), 3, false),
  ];
  checkInterrupted();
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless: true,
  });
  checkInterrupted();
  result.browser = browser.version();
  for (const instrumented of [true, false]) {
    const sessions = [];
    try {
      for (const [build, engine, base] of [
        ["baseline", "brush", bases[instrumented ? 0 : 2]],
        ["optimized", "brush", bases[instrumented ? 1 : 3]],
        ["optimized", "just-bash", bases[instrumented ? 1 : 3]],
        ["baseline", "just-bash", bases[instrumented ? 0 : 2]],
      ])
        sessions.push({ build, engine, ...(await open(base, engine, instrumented)) });
      for (const [id, command, expected] of fixtureDefinitions) {
        for (const session of sessions) await submit(session.page, command, expected, instrumented);
        for (let trial = 0; trial < trials; trial++) {
          const order = trial % 2 ? sessions.toReversed() : sessions;
          for (const session of order) {
            const data = await submit(session.page, command, expected, instrumented);
            result.samples.push({
              build: session.build,
              engine: session.engine,
              instrumented,
              fixture: id,
              trial: trial + 1,
              ...data,
            });
          }
        }
        process.stdout.write(
          `${instrumented ? "worker" : "visible"} ${id} verified ${trials} trials per build/engine\n`,
        );
      }
      if (!instrumented)
        for (const session of sessions.filter((session) => session.build === "optimized")) {
          result.functional.push({
            ...(await checkInteraction(session.page, session.engine)),
            matchedTerminalReplay: await replay(session.page),
          });
        }
    } finally {
      for (const session of sessions) await session.context.close();
    }
  }
  for (const build of ["baseline", "optimized"])
    for (const engine of ["brush", "just-bash"])
      for (const [id] of fixtureDefinitions) {
        const worker = result.samples.filter(
          (s) => s.build === build && s.engine === engine && s.fixture === id && s.instrumented,
        );
        const visible = result.samples.filter(
          (s) => s.build === build && s.engine === engine && s.fixture === id && !s.instrumented,
        );
        result.summary.push({
          build,
          engine,
          fixture: id,
          workerMedianMs: q(
            visible.map((s) => s.worker.external.elapsedMs),
            0.5,
          ),
          workerP95Ms: q(
            visible.map((s) => s.worker.external.elapsedMs),
            0.95,
          ),
          visibleMedianMs: q(
            visible.map((s) => s.visibleMs),
            0.5,
          ),
          visibleP95Ms: q(
            visible.map((s) => s.visibleMs),
            0.95,
          ),
          io: worker.at(-1)?.worker,
        });
      }
} catch (error) {
  result.error = String(error);
  process.exitCode = result.interrupted ? 130 : 1;
} finally {
  try {
    await stop();
  } catch (error) {
    result.cleanup.error = String(error);
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
}
