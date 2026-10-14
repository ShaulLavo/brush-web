import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, cp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release } from "node:os";
import { createServer } from "node:net";
import { memoryAndBoundaryProbe } from "./cost-probes.mjs";
import { frameProbe } from "./frame-probe.mjs";

const root = resolve(import.meta.dirname, "..");
const trials = Number(process.env.BRUSH_COST_TRIALS ?? 30);
const headed = process.env.BRUSH_HEADED === "1";
const replayOnly = process.env.BRUSH_COST_REPLAY_ONLY === "1";
const renderer = process.env.BRUSH_RENDERER ?? "canvas";
const port = Number(process.env.BRUSH_COST_PORT ?? 4204);
const output = resolve(
  process.env.BRUSH_COST_OUTPUT ?? resolve(root, `docs/evidence/cost-attribution-${renderer}.json`),
);
if (!Number.isInteger(trials) || trials < 5 || trials > 100) throw new Error("Use 5 to 100 trials");
const fixtures = [
  {
    id: "arithmetic-20000",
    command: "sum=0; for ((i=0;i<20000;i++)); do sum=$((sum+i)); done; echo sum:$sum",
    expected: "sum:199990000",
  },
  {
    id: "substitutions-1000",
    command: `sum=0; for ((i=1;i<=1000;i++)); do v=$(printf '%s' "$i"); sum=$((sum+v)); done; echo sub:$sum`,
    expected: "sub:500500",
  },
  {
    id: "files-10000",
    command:
      "seq 10000 > source; cat source | cat > copy; mapfile -t rows < copy; echo file:${#rows[@]}:${rows[0]}:${rows[9999]}",
    expected: "file:10000:1:10000",
  },
  { id: "terminal-10000-settled", command: "seq 10000", expected: "10000" },
  { id: "terminal-10000-immediate", command: "seq 10000", expected: "10000", immediate: true },
  { id: "terminal-100000", command: "seq 100000", expected: "100000" },
];
let browser, server, directory;
let interrupted = false;
const result = {
  recordedAt: new Date().toISOString(),
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  cpu: cpus()[0]?.model,
  kernel: release(),
  browser: "",
  headed,
  replayOnly,
  renderer,
  trials,
  gpu: null,
  artifacts: [],
  samples: [],
  summary: [],
  replay: [],
  probes: null,
  resources: { port, serverPid: null },
  cleanup: {},
  limitations: [
    "Cost mode times all WASI imports and custom browser imports except phase events. Import spans begin after entry into JavaScript; transitions and profiler overhead remain unattributed.",
    "Host spans include normalization, copies and backpressure. Their nested children must not be added again. Worker blocked time overlaps main-thread processing.",
    "Phase mode records only command boundaries in the worker. Both modes retain identical bounded main-thread delivery/frame tracing. Instrumentation overhead is reported separately.",
    "Terminal submit measures synchronous Ghostty write, including VT parsing and terminal-state work. Last-drain-to-frame includes scheduling/drawing and is not isolated GPU time or physical presentation.",
    "Known-backlog gaps measure intervals between drains when bytes were already queued. They overlap other threads and may contain frame work; they are not extra CPU work.",
    "The just-bash execution span includes interpreter, virtual filesystem and output-string construction. It is not pure interpreter CPU time.",
  ],
};
function checkInterrupted() {
  if (interrupted) throw new Error("Cost measurement interrupted");
}
function interrupt() {
  interrupted = true;
  void browser?.close().catch(() => undefined);
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function startServer() {
  const check = createServer();
  await new Promise((resolve, reject) => {
    check.once("error", reject);
    check.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    check.close((error) => (error ? reject(error) : resolve())),
  );
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  directory = await mkdtemp(resolve(root, ".scratch/cost-"));
  await cp(resolve(root, "dist"), directory, { recursive: true });
  checkInterrupted();
  for (const name of await readdir(resolve(directory, "assets"))) await hashAsset(`assets/${name}`);
  await hashAsset("brush/brush-browser.wasm");
  server = spawn(process.execPath, [resolve(directory, "serve.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  result.resources.serverPid = server.pid;
  for (let i = 0; i < 100; i++) {
    checkInterrupted();
    if (server.exitCode !== null) throw new Error("Owned cost server exited");
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Cost server did not become ready");
}
async function hashAsset(name) {
  const bytes = await readFile(resolve(directory, name));
  result.artifacts.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
async function open(engine, mode) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(
      `http://127.0.0.1:${port}/?test=1&trace=1&profile=${mode === "cost" ? "1" : "phase"}&engine=${engine}${renderer === "canvas" ? "&renderer=canvas" : ""}`,
    );
    await page.waitForFunction(() => window.brushWeb?.snapshot().state === "ready");
    if (
      renderer === "webgpu" &&
      (await page.evaluate(() => window.brushWeb.snapshot().renderer)) !== "webgpu"
    )
      throw new Error("Requested WebGPU terminal fell back");
    await page.addStyleTag({ content: ".baseline-note{display:none!important}" });
    await page.waitForTimeout(120);
    await page.locator("textarea").focus();
    await page.evaluate(() => {
      window.costMarker = "";
      window.costEnterAt = 0;
      window.costFrameAt = 0;
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter" && window.costMarker && !window.costEnterAt)
            window.costEnterAt = performance.timeOrigin + performance.now();
        },
        { capture: true },
      );
      window.brushWeb.terminal.onFrame(() => {
        if (
          window.costMarker &&
          !window.costFrameAt &&
          window.brushWeb
            .visibleLines()
            .some((line) => line.trim().startsWith(window.costMarker + ":"))
        )
          window.costFrameAt = performance.timeOrigin + performance.now();
      });
    });
    return { context, page, engine, mode, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}
let sequence = 0;
async function submit(session, fixture) {
  checkInterrupted();
  const { page } = session;
  const marker = `COST_${++sequence}`;
  await page.waitForTimeout(100);
  const before = await page.evaluate((marker) => {
    window.costMarker = marker;
    window.costEnterAt = 0;
    window.costFrameAt = 0;
    const metrics = window.brushWeb.metrics();
    metrics.deliveries.length = 0;
    metrics.frames.length = 0;
    metrics.traceDropped = 0;
    return metrics.lastExecution?.sequence ?? 0;
  }, marker);
  await page.keyboard.insertText(
    `printf '%s\\n' '${marker}_BEGIN'; ${fixture.command}; cost_status=$?; printf '\\n%s:%s\\n' '${marker}' "$cost_status"`,
  );
  if (!fixture.immediate) await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (before) =>
      window.costFrameAt &&
      window.brushWeb.metrics().lastExecution?.sequence > before &&
      window.brushWeb.snapshot().state === "ready",
    before,
    { polling: 4 },
  );
  const data = await page.evaluate(() => ({
    enterAt: window.costEnterAt,
    frameAt: window.costFrameAt,
    metrics: structuredClone(window.brushWeb.metrics()),
    lines: window.brushWeb.readLines().map((line) => line.trim()),
    grid: window.brushWeb.snapshot(),
  }));
  if (!data.enterAt || data.metrics.traceDropped || session.errors.length)
    throw new Error("Incomplete trace or browser error");
  const end = data.lines.lastIndexOf(marker + ":0");
  const begin = data.lines.lastIndexOf(marker + "_BEGIN");
  const observed = data.lines.slice(begin >= 0 ? begin + 1 : Math.max(0, end - 4), end);
  if (end < 0 || !observed.includes(fixture.expected))
    throw new Error(`Incorrect current-trial output: ${marker}`);
  return analyzeTrace(data, session.engine);
}
function analyzeTrace(data, engine) {
  const deliveries = data.metrics.deliveries.filter(
    (span) => span.finishedAt >= data.enterAt && span.startedAt <= data.frameAt,
  );
  const sum = (fn) => deliveries.reduce((total, span, index) => total + fn(span, index), 0);
  const worker = data.metrics.lastExecution;
  const main = {
    inputToFrameMs: data.frameAt - data.enterAt,
    inputToExecutionMs: worker.startedAt - data.enterAt,
    drainMs: sum((span) => span.drainedAt - span.startedAt),
    terminalSubmitMs: sum((span) => span.finishedAt - span.drainedAt),
    knownBacklogGapMs: sum((span, index) =>
      index && deliveries[index - 1].queuedBytes > deliveries[index - 1].bytes
        ? span.startedAt - deliveries[index - 1].finishedAt
        : 0,
    ),
    lastDrainToFrameMs: data.frameAt - deliveries.at(-1).finishedAt,
    drainCount: deliveries.length,
    deliveredBytes: sum((span) => span.bytes),
    peakQueuedBytesAtDrain: Math.max(...deliveries.map((span) => span.queuedBytes)),
  };
  return {
    enterAt: data.enterAt,
    frameAt: data.frameAt,
    worker,
    main,
    deliveries,
    frames: data.metrics.frames,
    workerOutsideImportsMs: worker.elapsedMs - worker.hostMs - worker.browserMs,
    hostOtherInclusiveMs:
      engine === "brush"
        ? worker.hostMs -
          worker.normalizeMs -
          worker.ringCopyMs -
          worker.backpressureMs -
          worker.hostCopyMs
        : null,
    grid: { cols: data.grid.cols, rows: data.grid.rows, renderer: data.grid.renderer },
  };
}
async function measureFixture(sessions, fixture) {
  for (const session of sessions) await submit(session, fixture);
  for (let trial = 0; trial < trials; trial++) {
    const order = trial % 2 ? sessions.toReversed() : sessions;
    for (const session of order)
      result.samples.push({
        engine: session.engine,
        mode: session.mode,
        fixture: fixture.id,
        trial: trial + 1,
        ...(await submit(session, fixture)),
      });
  }
  process.stdout.write(`${fixture.id}: ${trials} verified trials per engine/mode\n`);
}
async function replay(session) {
  const samples = await session.page.evaluate(async () => {
    window.costMarker = "";
    const terminal = window.brushWeb.terminal;
    const bytes = new TextEncoder().encode(
      Array.from({ length: 10000 }, (_, index) => String(index + 1)).join("\r\n") +
        "\r\nCOST_REPLAY\r\n",
    );
    const samples = [];
    for (let trial = 0; trial < 10; trial++) {
      const finished = new Promise((resolve) => {
        const sub = terminal.onFrame(() => {
          if (window.brushWeb.visibleLines().some((line) => line.trim() === "COST_REPLAY")) {
            sub.dispose();
            resolve(performance.now());
          }
        });
      });
      terminal.write(new TextEncoder().encode("\x1b[H\x1b[2J"));
      const start = performance.now();
      let submitMs = 0;
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        const before = performance.now();
        terminal.write(bytes.subarray(offset, offset + 32768));
        submitMs += performance.now() - before;
      }
      samples.push({
        trial: trial + 1,
        bytes: bytes.length,
        submitMs,
        toFrameMs: (await finished) - start,
      });
    }
    return samples;
  });
  result.replay.push({ engine: session.engine, samples });
}
async function measureRenderReplay(session) {
  let timeout;
  try {
    const samples = await Promise.race([
      session.page.evaluate(frameProbe),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Render replay exceeded 30 seconds")), 30000);
      }),
    ]);
    result.replay.push({ engine: session.engine, samples });
  } finally {
    clearTimeout(timeout);
  }
}
async function runProbes(page) {
  return page.evaluate(
    (source) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(
          new Blob(
            [
              `onmessage=async()=>{try{postMessage({value:await (${source})()})}catch(error){postMessage({error:String(error)})}}`,
            ],
            { type: "text/javascript" },
          ),
        );
        const worker = new Worker(url);
        const timeout = setTimeout(() => finish(new Error("Cost probe timeout")), 60000);
        function finish(error, value) {
          clearTimeout(timeout);
          worker.terminate();
          URL.revokeObjectURL(url);
          if (error) reject(error);
          else resolve(value);
        }
        worker.onerror = (event) => finish(new Error(event.message));
        worker.onmessage = (event) =>
          event.data.error
            ? finish(new Error(event.data.error))
            : finish(undefined, event.data.value);
        worker.postMessage(null);
      }),
    memoryAndBoundaryProbe.toString(),
  );
}
function summarize() {
  const median = (values) => values.toSorted((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
  for (const fixture of fixtures)
    for (const engine of ["brush", "just-bash"]) summarizeEngine(fixture.id, engine, median);
}
function summarizeEngine(fixture, engine, median) {
  const modes = {};
  for (const mode of ["phase", "cost"]) {
    const samples = result.samples.filter(
      (s) => s.fixture === fixture && s.engine === engine && s.mode === mode,
    );
    const fields = {};
    for (const group of ["worker", "main"])
      fields[group] = Object.fromEntries(
        Object.keys(samples[0][group]).map((key) => [
          key,
          median(samples.map((s) => s[group][key])),
        ]),
      );
    modes[mode] = fields;
  }
  result.summary.push({
    fixture,
    engine,
    ...modes,
    workerInstrumentationRatio: modes.cost.worker.elapsedMs / modes.phase.worker.elapsedMs,
  });
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = new Promise((resolve) => server.once("exit", resolve));
  const force = setTimeout(() => server.kill("SIGKILL"), 2000);
  try {
    server.kill("SIGTERM");
    await stopped;
  } finally {
    clearTimeout(force);
  }
}
async function cleanup() {
  const consumers = await Promise.allSettled([browser?.close(), stopServer()]);
  result.cleanup = {
    browserClosed: consumers[0].status === "fulfilled",
    serverStopped: consumers[1].status === "fulfilled",
    snapshotRemoved: false,
  };
  if (consumers.some((value) => value.status === "rejected"))
    throw new Error("Consumer cleanup failed; snapshot retained");
  if (directory) await rm(directory, { recursive: true });
  result.cleanup.snapshotRemoved = true;
}
try {
  await startServer();
  checkInterrupted();
  browser = await chromium.launch({
    headless: !headed,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: headed ? ["--ozone-platform=wayland", "--enable-unsafe-webgpu"] : [],
  });
  result.browser = browser.version();
  checkInterrupted();
  const sessions = [];
  try {
    for (const [engine, mode] of [
      ["brush", "phase"],
      ["just-bash", "phase"],
      ["brush", "cost"],
      ["just-bash", "cost"],
    ])
      sessions.push(await open(engine, mode));
    process.stdout.write(`Cost sessions ready: ${renderer}, ${headed ? "headed" : "headless"}\n`);
    if (renderer === "webgpu")
      result.gpu = await sessions[0].page.evaluate(async () => {
        const a = await navigator.gpu.requestAdapter();
        return a
          ? {
              vendor: a.info.vendor,
              architecture: a.info.architecture,
              isFallbackAdapter: a.info.isFallbackAdapter,
            }
          : null;
      });
    if (!replayOnly) for (const fixture of fixtures) await measureFixture(sessions, fixture);
    if (headed && !replayOnly) {
      for (const session of sessions.filter((session) => session.mode === "phase"))
        await session.page.screenshot({
          path: resolve(root, `docs/evidence/cost-${renderer}-${session.engine}.png`),
        });
    }
    for (const session of sessions.filter((session) => session.mode === "phase"))
      await (replayOnly ? measureRenderReplay(session) : replay(session));
    if (!replayOnly) {
      result.probes = await runProbes(sessions[0].page);
      summarize();
    }
  } finally {
    for (const session of sessions) await session.context.close();
  }
} catch (error) {
  result.error = String(error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    result.cleanup.error = String(error);
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}
