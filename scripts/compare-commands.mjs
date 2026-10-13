import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { getCommandNames } from "just-bash/browser";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.BRUSH_COMPARE_PORT ?? 4196);
const baseUrl = `http://127.0.0.1:${port}`;
const destination = resolve(root, "docs/evidence/command-benchmarks.json");
const trialCount = 5;
const fixtures = [
  {
    id: "arithmetic-2000",
    label: "Arithmetic loop, 2,000 iterations",
    script: "sum=0; for ((i=0; i<2000; i++)); do sum=$((sum+i)); done; printf 'sum:%s\\n' \"$sum\"",
    expected: ["sum:1999000"],
  },
  {
    id: "files-5000",
    label: "5,000 lines through files and a cat pipeline",
    script:
      'seq 5000 > bench-source; cat bench-source | cat > bench-copy; mapfile -t file_lines < bench-copy; printf \'file:%s:%s:%s\\n\' "${#file_lines[@]}" "${file_lines[0]}" "${file_lines[4999]}"',
    expected: ["file:5000:1:5000"],
  },
  {
    id: "substitutions-100",
    label: "100 command substitutions with a checksum",
    script:
      "sum=0; for ((i=1; i<=100; i++)); do value=$(printf '%s' \"$i\"); sum=$((sum+value)); done; printf 'sub:%s\\n' \"$sum\"",
    expected: ["sub:5050"],
  },
  {
    id: "terminal-10000",
    label: "10,000 lines of terminal output",
    script: "seq 10000",
    expected: ["9999", "10000"],
  },
];
let markerSequence = 0;
let browser;
let server;
let artifact;
const result = {
  recordedAt: new Date().toISOString(),
  platform: platform(),
  kernel: release(),
  cpu: cpus()[0]?.model,
  browser: "",
  renderer: "canvas2d",
  headless: true,
  viewport: { width: 1200, height: 800 },
  trials: trialCount,
  sourcePins: JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")),
  artifacts: [],
  commandInventory: {},
  runs: [],
  cleanup: { browserClosed: false, serverStopped: false, artifactRemoved: false },
  limitations: [
    "Each fixture has one untimed warmup followed by five warm trials on the same engine session.",
    "Timing starts before Enter is delivered and ends when Ghostty's submitted viewport contains the standalone status marker. It includes main-thread transport, rendering, and approximately one frame of browser polling overhead.",
    "Measurements use headless Chromium and Ghostty Canvas2D, not hardware WebGPU or physical display presentation.",
    "Brush retains shell state. just-bash resets shell state after every submitted script. Each fixture initializes its own variables and overwrites its own files.",
    "The file fixture includes mapfile and first/last/count verification in its timing. It is a whole command workload, not an isolated filesystem throughput test.",
    "The published command catalog and completion inventories list names, not support for every flag or native process behavior.",
    "These are five samples per engine and fixture on one machine. Browser scheduling, caches, CPU load, and engine order can affect the result.",
  ],
};

function check(value, message) {
  if (!value) throw new Error(message);
}

async function assertPortAvailable() {
  const probe = createServer();
  await new Promise((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolvePort);
  });
  await new Promise((resolveClose) => probe.close(resolveClose));
}

async function recordArtifact(path) {
  const data = await readFile(resolve(artifact, path));
  return { path, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}

async function startServer() {
  server = spawn(process.execPath, [resolve(artifact, "serve.mjs")], {
    cwd: artifact,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  let startupError;
  server.once("error", (cause) => {
    startupError = cause;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    check(server.exitCode === null, "Owned static benchmark server exited during startup");
    const response = await fetch(baseUrl).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Owned static benchmark server did not become ready");
}

function stop() {
  void browser?.close().catch(() => undefined);
  server?.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function open(engine) {
  const context = await browser.newContext({ viewport: result.viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${baseUrl}/?test=1&renderer=canvas&engine=${engine}`);
  await page.waitForFunction(
    () =>
      window.brushWeb?.snapshot().state === "ready" &&
      window.brushWeb.snapshot().firstFrameMs !== undefined,
  );
  await page.locator("textarea").focus();
  return { context, page };
}

async function submit(page, script) {
  const marker = `BW_END_${++markerSequence}`;
  const begin = `BW_RUN_${markerSequence}_BEGIN`;
  await page.keyboard.insertText(
    `printf '%s\\n' '${begin}'; ${script}; bw_status=$?; printf '\\n%s:%s\\n' '${marker}' \"$bw_status\"`,
  );
  const start = performance.now();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (prefix) =>
      window.brushWeb
        ?.visibleLines()
        .some(
          (line) =>
            /^\d+$/.test(line.trim().slice(prefix.length)) && line.trim().startsWith(prefix),
        ),
    `${marker}:`,
  );
  const durationMs = performance.now() - start;
  const lines = await page.evaluate(() => window.brushWeb.readLines().map((line) => line.trim()));
  const end = lines.findLast(
    (line) => line.startsWith(`${marker}:`) && /^\d+$/.test(line.slice(marker.length + 1)),
  );
  check(end, "The benchmark end marker disappeared from terminal history");
  const endIndex = lines.lastIndexOf(end);
  const beginIndex = lines.lastIndexOf(begin);
  const observedOutput = lines.slice(
    beginIndex >= 0 ? beginIndex + 1 : Math.max(0, endIndex - 3),
    endIndex,
  );
  return { durationMs, status: Number(end.slice(marker.length + 1)), lines, observedOutput };
}

async function capture(page, command) {
  const begin = `BW_BEGIN_${markerSequence + 1}`;
  const run = await submit(page, `printf '%s\\n' '${begin}'; ${command}`);
  const first = run.lines.lastIndexOf(begin);
  const last = run.lines.findLastIndex((line) => line.startsWith(`BW_END_${markerSequence}:`));
  check(first >= 0 && last > first, "Command inventory markers were not retained");
  return { command, status: run.status, output: run.lines.slice(first + 1, last).filter(Boolean) };
}

function names(probe) {
  check(probe.status === 0, `Command inventory failed: ${probe.command}`);
  const values = Array.from(new Set(probe.output));
  values.sort();
  return values;
}

async function inventory(page, engine) {
  const shortBuiltins = await capture(page, "compgen -b");
  const builtinProbe =
    shortBuiltins.status === 0 && shortBuiltins.output.length
      ? shortBuiltins
      : await capture(page, "compgen -A builtin");
  const keywords = await capture(page, "compgen -k");
  const help = await capture(page, "help");
  const capabilityProbes = [];
  for (const command of [
    "bg",
    "fg",
    "kill -l",
    "umask",
    "ulimit",
    "ls -l",
    "cp welcome.txt inventory-copy",
    "grep Files welcome.txt",
  ]) {
    capabilityProbes.push(await capture(page, `${command} 2>&1`));
  }
  return {
    engine,
    builtinProbe: { command: builtinProbe.command, status: builtinProbe.status },
    shortBuiltinProbe: shortBuiltins,
    reportedBuiltins: names(builtinProbe),
    keywords: names(keywords),
    helpProbe: help,
    capabilityProbes,
    snapshot: await page.evaluate(() => window.brushWeb.snapshot()),
  };
}

function percentile(values, fraction) {
  const ordered = values.toSorted((first, second) => first - second);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

async function benchmark(page, engine, fixture) {
  const warmup = await submit(page, fixture.script);
  verify(warmup, fixture);
  const samples = [];
  for (let trial = 0; trial < trialCount; trial++) {
    const run = await submit(page, fixture.script);
    verify(run, fixture);
    samples.push({
      trial: trial + 1,
      durationMs: run.durationMs,
      exitStatus: run.status,
      observedOutput: run.observedOutput.slice(-4),
    });
  }
  const values = samples.map((sample) => sample.durationMs);
  result.runs.push({
    engine,
    fixture: fixture.id,
    label: fixture.label,
    command: fixture.script,
    expected: fixture.expected,
    warmupMs: warmup.durationMs,
    samples,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  });
  process.stdout.write(
    `${engine} ${fixture.id}: median ${percentile(values, 0.5).toFixed(1)} ms, p95 ${percentile(values, 0.95).toFixed(1)} ms\n`,
  );
}

function verify(run, fixture) {
  check(run.status === 0, `Fixture ${fixture.id} exited with status ${run.status}`);
  for (const expected of fixture.expected) {
    check(
      run.observedOutput.includes(expected),
      `Fixture ${fixture.id} did not produce ${expected}`,
    );
  }
}

async function sourceInventory() {
  const baseline = await readFile(resolve(root, "src/baseline.ts"), "utf8");
  const enabledBlock = baseline.match(/const commands: CommandName\[\] = \[([\s\S]*?)\];/)?.[1];
  check(enabledBlock, "Baseline command inventory could not be read");
  const enabled = Array.from(enabledBlock.matchAll(/"([a-z0-9-]+)"/g), (match) => match[1]);
  enabled.sort();
  const utilities = await readFile(resolve(root, "rust/brush-browser/src/utilities.rs"), "utf8");
  const utilityBlock = utilities.match(/const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1];
  check(utilityBlock, "Brush host command inventory could not be read");
  const hostUtilities = Array.from(utilityBlock.matchAll(/"([a-z0-9-]+)"/g), (match) => match[1]);
  hostUtilities.sort();
  const catalog = getCommandNames();
  catalog.sort();
  return {
    justBashEnabled: enabled,
    justBashInstalledCatalog: catalog,
    brushHostUtilities: hostUtilities,
  };
}

async function cleanup() {
  if (browser) await browser.close();
  result.cleanup.browserClosed = true;
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
    server.kill("SIGTERM");
    await exited;
  }
  result.cleanup.serverStopped = true;
  if (artifact) await rm(artifact, { recursive: true, force: true });
  result.cleanup.artifactRemoved = !artifact || !(await stat(artifact).catch(() => undefined));
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

try {
  await assertPortAvailable();
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  artifact = await mkdtemp(resolve(root, ".scratch/command-bench-"));
  await cp(resolve(root, "dist"), artifact, { recursive: true });
  result.artifacts = await Promise.all([
    recordArtifact("index.html"),
    recordArtifact("brush/brush-browser.wasm"),
  ]);
  result.commandInventory.source = await sourceInventory();
  await startServer();
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless: true,
  });
  result.browser = browser.version();
  for (const engine of ["brush", "just-bash"]) {
    const { context, page } = await open(engine);
    try {
      result.commandInventory[engine] = await inventory(page, engine);
      for (const fixture of fixtures) await benchmark(page, engine, fixture);
    } finally {
      await context.close();
    }
  }
} catch (cause) {
  result.error = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${result.error}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
  await mkdir(resolve(root, "docs/evidence"), { recursive: true });
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
}
