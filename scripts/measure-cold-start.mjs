// Cold and repeat-visit load timing for every engine behind a compressing, caching static server.
// This script owns its HTTP server, browser processes, cgroup scopes and temporary profiles; every
// exit path closes the browser, stops the server and removes the profile root.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { wasmOpt } from "./binaryen.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const cache = resolve(root, ".build/cold-start");
const port = Number(process.env.BRUSH_COLD_PORT ?? 4211);
const origin = `http://127.0.0.1:${port}`;
const trials = Number(process.env.BRUSH_COLD_TRIALS ?? 10);
const lingerMs = Number(process.env.BRUSH_COLD_LINGER_MS ?? 1000);
const output = resolve(
  root,
  "docs/evidence",
  `${process.env.BRUSH_COLD_PREFIX ?? "cold-start"}.json`,
);
// Chrome writes the HTTP cache while reading a response, so a slow profile disk slows "downloads".
// The default is the OS temp directory (tmpfs on the measurement host); profiles are a few MB each.
const profileRoot = process.env.BRUSH_COLD_PROFILE_ROOT ?? tmpdir();
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// Chrome DevTools presets (front_end/core/sdk/NetworkManager.ts): bytes per second and added RTT.
const networks = {
  none: undefined,
  fast4g: { latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 },
  slow4g: { latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 },
};
const conditionTable = {
  unthrottled: { network: "none", cpu: "none" },
  "fast4g-cdp4x": { network: "fast4g", cpu: "cdp4x" },
  "slow4g-cdp4x": { network: "slow4g", cpu: "cdp4x" },
  "fast4g-cgroup4x": { network: "fast4g", cpu: "cgroup4x" },
  "slow4g-cgroup4x": { network: "slow4g", cpu: "cgroup4x" },
};
const variantTable = {
  brush: { engine: "brush" },
  "brush-oz": { engine: "brush", optimize: "brush" },
  "just-bash": { engine: "just-bash" },
  bashkit: { engine: "bashkit" },
  "bashkit-terminal": { engine: "bashkit-terminal" },
  "bashkit-terminal-oz": { engine: "bashkit-terminal", optimize: "bashkit-terminal" },
};
const variants = (
  process.env.BRUSH_COLD_VARIANTS ??
  "brush,brush-oz,just-bash,bashkit,bashkit-terminal,bashkit-terminal-oz"
).split(",");
const conditions = (
  process.env.BRUSH_COLD_CONDITIONS ??
  "unthrottled,fast4g-cdp4x,slow4g-cdp4x,fast4g-cgroup4x,slow4g-cgroup4x"
).split(",");
if (variants.some((name) => !variantTable[name])) throw new Error("Invalid cold-start variant");
if (conditions.some((name) => !conditionTable[name]))
  throw new Error("Invalid cold-start condition");
const visits = ["cold", "warm1", "warm2"];
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = new Map();
const overrides = new Map();
let server;
let browserContext;
let profiles;
let interrupted = false;

// Chrome's on-disk V8 code cache, read after the browser has closed and flushed it.
async function directoryBytes(directory) {
  let total = 0;
  for (const path of await walk(directory).catch(() => []))
    total += (await stat(path).catch(() => ({ size: 0 }))).size;
  return total;
}

async function walk(directory) {
  let found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    found = found.concat(entry.isDirectory() ? await walk(path) : [path]);
  }
  return found;
}

// Precompressed static bytes, as a CDN serving build-time .br/.gz files would hold them.
async function encode(bytes) {
  const hash = sha256(bytes);
  const encoded = {};
  for (const [name, compress] of [
    [
      "br",
      (input) =>
        brotli(input, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_LGWIN]: 24,
            [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          },
        }),
    ],
    ["gzip", (input) => gzipAsync(input, { level: 9 })],
  ]) {
    const path = resolve(cache, "encoded", `${hash}.${name}`);
    let data = await readFile(path).catch(() => undefined);
    if (!data) {
      data = await compress(bytes);
      await writeFile(path, data);
    }
    encoded[name] = data;
  }
  return { raw: bytes, hash, ...encoded };
}

async function optimized(source) {
  const input = await readFile(source);
  const { binary, flags, version } = await wasmOpt();
  const path = resolve(cache, `${sha256(input)}-binaryen-${version}-oz.wasm`);
  try {
    await access(path);
  } catch {
    execFileSync(binary, flags.concat([source, "-o", path]), { stdio: "inherit" });
  }
  return readFile(path);
}

async function prepare() {
  await mkdir(resolve(cache, "encoded"), { recursive: true });
  try {
    await access(resolve(dist, "index.html"));
  } catch {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const paths = (await walk(dist)).filter((path) => !path.endsWith("serve.mjs"));
  await Promise.all(
    paths.map(async (path) =>
      files.set(
        "/" + relative(dist, path).split(sep).join("/"),
        await encode(await readFile(path)),
      ),
    ),
  );
  const terminalHash = sha256(
    await readFile(resolve(root, ".sources/bashkit/pkg/bashkit_wasm_bg.wasm")),
  );
  const terminalPath = Array.from(files).find(([, file]) => file.hash === terminalHash)?.[0];
  if (!terminalPath) throw new Error("Built Bashkit Terminal WASM not found in dist/");
  const targets = {
    brush: { path: "/brush/brush-browser.wasm", source: resolve(dist, "brush/brush-browser.wasm") },
    "bashkit-terminal": { path: terminalPath, source: resolve(dist, terminalPath.slice(1)) },
  };
  for (const name of variants) {
    const target = targets[variantTable[name].optimize];
    if (!target) continue;
    overrides.set(name, { path: target.path, file: await encode(await optimized(target.source)) });
  }
}

function serve(request, response) {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname === "/blank") {
    response.setHeader("Content-Type", types[".html"]);
    response.end("<!doctype html><title>blank</title>");
    return;
  }
  // /v/<variant>/... keeps one variant's overrides apart from another's.
  const match = /^\/v\/([^/]+)(\/.*)$/.exec(url.pathname);
  const path = match?.[2] === "/" ? "/index.html" : match?.[2];
  const override = match ? overrides.get(match[1]) : undefined;
  const file = override && override.path === path ? override.file : files.get(path ?? "");
  if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(404);
    response.end();
    return;
  }
  const accepted = request.headers["accept-encoding"] ?? "";
  const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : undefined;
  const body = encoding ? file[encoding] : file.raw;
  const etag = `"${file.hash.slice(0, 32)}${encoding ? `-${encoding}` : ""}"`;
  response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
  response.setHeader("Vary", "Accept-Encoding");
  response.setHeader("ETag", etag);
  // Vite's hashed assets are immutable; index.html and the unhashed Brush WASM revalidate.
  response.setHeader(
    "Cache-Control",
    path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  if (encoding) response.setHeader("Content-Encoding", encoding);
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304);
    response.end();
    return;
  }
  response.setHeader("Content-Length", body.length);
  response.end(request.method === "HEAD" ? undefined : body);
}

async function cgroupLauncher() {
  const chrome = chromium.executablePath();
  const path = resolve(cache, "cgroup-chromium.sh");
  // Quarter of one CPU for the whole browser, refilled every 10 ms to avoid long stalls.
  await writeFile(
    path,
    `#!/bin/sh\nexec systemd-run --user --scope --quiet --collect -p CPUQuota=25% -p CPUQuotaPeriodSec=10ms -- "${chrome}" "$@"\n`,
  );
  await chmod(path, 0o755);
  return path;
}

async function visit({ variant, condition, profile, launcher, visitName }) {
  const { engine } = variantTable[variant];
  const { network, cpu } = conditionTable[condition];
  browserContext = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    executablePath: cpu === "cgroup4x" ? launcher : undefined,
    viewport: { width: 1200, height: 800 },
  });
  try {
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());
    const cdp = await browserContext.newCDPSession(page);
    await page.goto(`${origin}/blank`);
    if (networks[network]) {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        ...networks[network],
      });
    }
    if (cpu === "cdp4x") await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const requests = [];
    page.on("request", (request) => requests.push({ url: request.url(), at: Date.now() }));
    await page.goto(
      `${origin}/v/${variant}/?test=1&renderer=canvas&startupTimeout=180000&engine=${engine}`,
      { timeout: 180000 },
    );
    await page.waitForFunction(
      () =>
        performance.getEntriesByName("brush:prompt-frame").length > 0 ||
        window.brushWeb?.snapshot().state === "failed",
      null,
      { timeout: 180000, polling: 20 },
    );
    const startup = await page.evaluate(() => {
      const mark = (name) => performance.getEntriesByName(name)[0]?.startTime;
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        timeOrigin: performance.timeOrigin,
        snapshot: window.brushWeb?.snapshot(),
        navigation: {
          responseEnd: navigation.responseEnd,
          domContentLoaded: navigation.domContentLoadedEventEnd,
          load: navigation.loadEventEnd,
          transferSize: navigation.transferSize,
        },
        marks: {
          terminalOpened: mark("brush:terminal-opened"),
          sessionStart: mark("brush:session-start"),
          ready: mark("brush:ready"),
          promptFrame: mark("brush:prompt-frame"),
        },
        resources: Array.from(performance.getEntriesByType("resource"), (entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          responseStart: entry.responseStart,
          responseEnd: entry.responseEnd,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        })),
        worker: window.brushWeb?.metrics()?.startup,
      };
    });
    if (startup.snapshot?.state === "failed") throw new Error(startup.snapshot.error);
    const promptAt = Date.now();
    await page.evaluate(() => {
      const state = { enterAt: undefined, hiAt: undefined };
      Reflect.set(window, "coldStart", state);
      window.brushWeb.terminal.textarea.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter") state.enterAt ??= performance.now();
        },
        { capture: true },
      );
      window.brushWeb.terminal.onFrame(() => {
        if (state.enterAt === undefined || state.hiAt !== undefined) return;
        if (window.brushWeb.readLines().some((line) => line.trim() === "hi"))
          state.hiAt = performance.now();
      });
    });
    await page.locator("textarea").focus();
    await page.keyboard.insertText("echo hi");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => Reflect.get(window, "coldStart").hiAt !== undefined, null, {
      timeout: 60000,
      polling: 20,
    });
    const command = await page.evaluate(() => Reflect.get(window, "coldStart"));
    const mainThreadSpinMs = await page.evaluate(() => {
      const started = performance.now();
      let value = 0;
      for (let index = 0; index < 2e7; index++) value += index % 7;
      return value < 0 ? 0 : performance.now() - started;
    });
    if (lingerMs && visitName !== "warm2") await page.waitForTimeout(lingerMs);
    const local = (name) => name.replace(`${origin}/v/${variant}`, "");
    const trim = (entries) => entries?.map((entry) => ({ ...entry, name: local(entry.name) }));
    return {
      ...startup,
      resources: trim(startup.resources),
      worker: startup.worker && { ...startup.worker, resources: trim(startup.worker.resources) },
      command,
      mainThreadSpinMs,
      requestsAfterPrompt: requests
        .filter((request) => request.at >= promptAt)
        .map((request) => local(request.url)),
      requests: requests.length,
    };
  } finally {
    await browserContext.close();
    browserContext = undefined;
  }
}

function filesystem(path) {
  try {
    return execFileSync("findmnt", ["-no", "FSTYPE", "--target", path], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function hostDetails(browserVersion) {
  return {
    recordedAt: new Date().toISOString(),
    platform: platform(),
    kernel: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
    browser: browserVersion,
    headless: true,
    renderer: "canvas",
    profileRoot,
    profileFilesystem: filesystem(profileRoot),
    loadAverageAtStart: loadavg(),
  };
}

// Partial results stay under .build so a long run that stops early keeps its samples.
async function save(result, complete) {
  const partial = resolve(cache, "partial.json");
  await writeFile(partial, JSON.stringify({ ...result, complete }) + "\n");
  if (!complete) return;
  await mkdir(resolve(root, "docs/evidence"), { recursive: true });
  await rename(partial, output);
}

async function stop() {
  await browserContext?.close().catch(() => {});
  await new Promise((done) => (server?.listening ? server.close(done) : done()));
  if (profiles) await rm(profiles, { recursive: true, force: true });
}
// Closing the browser ends the current visit; the main loop then stops and cleans up once.
const onSignal = () => {
  interrupted = true;
  process.exitCode = 130;
  void browserContext?.close().catch(() => {});
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  await prepare();
  server = createServer((request, response) => {
    try {
      serve(request, response);
    } catch (error) {
      process.stderr.write(`server error: ${error}\n`);
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((done, fail) => server.once("error", fail).listen(port, "127.0.0.1", done));
  const launcher = conditions.some((name) => conditionTable[name].cpu === "cgroup4x")
    ? await cgroupLauncher()
    : undefined;
  profiles = await mkdtemp(resolve(profileRoot, "brush-cold-start-"));
  const probe = await chromium.launch({ channel: "chromium" });
  const browserVersion = probe.version();
  await probe.close();
  const result = {
    ...hostDetails(browserVersion),
    trials,
    lingerMs,
    networks,
    conditions: Object.fromEntries(conditions.map((name) => [name, conditionTable[name]])),
    variants: Object.fromEntries(variants.map((name) => [name, variantTable[name]])),
    files: Object.fromEntries(
      Array.from(files, ([path, file]) => [
        path,
        { raw: file.raw.length, gzip: file.gzip.length, br: file.br.length, sha256: file.hash },
      ]),
    ),
    overrides: Object.fromEntries(
      Array.from(overrides, ([name, { path, file }]) => [
        name,
        {
          path,
          raw: file.raw.length,
          gzip: file.gzip.length,
          br: file.br.length,
          sha256: file.hash,
        },
      ]),
    ),
    samples: [],
    failures: [],
  };
  for (let trial = 0; trial < trials && !interrupted; trial++) {
    // Alternate direction and rotate the start so no engine always runs first or last.
    const shift = trial % variants.length;
    const rotated = variants.slice(shift).concat(variants.slice(0, shift));
    const order = trial % 2 ? rotated.toReversed() : rotated;
    for (const condition of conditions) {
      for (const variant of order) {
        if (interrupted) break;
        const profile = resolve(profiles, `${trial}-${condition}-${variant}`);
        try {
          for (const visitName of visits) {
            if (interrupted) throw new Error("Interrupted");
            const sample = await visit({ variant, condition, profile, launcher, visitName });
            const codeCacheBytes = {
              wasm: await directoryBytes(resolve(profile, "Default/Code Cache/wasm")),
              js: await directoryBytes(resolve(profile, "Default/Code Cache/js")),
            };
            result.samples.push({
              trial,
              condition,
              variant,
              visit: visitName,
              ...sample,
              codeCacheBytes,
            });
          }
          process.stdout.write(`trial ${trial} ${condition} ${variant} ok\n`);
          await save(result, false);
        } catch (error) {
          result.failures.push({
            trial,
            condition,
            variant,
            error: String(error?.message ?? error),
          });
          process.stdout.write(
            `trial ${trial} ${condition} ${variant} failed: ${error?.message}\n`,
          );
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      }
    }
  }
  result.loadAverageAtEnd = loadavg();
  result.finishedAt = new Date().toISOString();
  if (interrupted)
    throw new Error("Measurement interrupted; partial samples are in .build/cold-start");
  await save(result, true);
  process.stdout.write(`Cold-start evidence: ${output}\n`);
} finally {
  await stop();
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
