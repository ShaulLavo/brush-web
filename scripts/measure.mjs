import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, release } from "node:os";
const root = resolve(import.meta.dirname, "..");
const headed = process.env.BRUSH_HEADED === "1";
const renderer = process.env.BRUSH_RENDERER ?? "canvas";
const output = resolve(root, "docs/evidence", `${headed ? "headed" : "headless"}-${renderer}.json`);
const port = 4197;
// This script owns this server and its browser; finally stops both on success and failure.
const server = spawn(process.execPath, ["dist/serve.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});
let browser;
const result = {
  recordedAt: new Date().toISOString(),
  platform: platform(),
  kernel: release(),
  cpu: cpus()[0]?.model,
  headed,
  renderer,
  browser: "",
  gpu: null,
  samples: [],
  limitations: [
    "Cold means a new browser context. HTTP cache is disabled for the cold navigation; OS caches and driver caches remain warm.",
    "Warm means a new terminal and shell worker on the same page with browser caching enabled.",
    "Latency ends at Ghostty onFrame after worker output. It excludes physical display scanout and compositor presentation.",
    "WASM memory is linear memory committed at prompt/command phase events. Chromium JS heap is main-page reporting, not comparable worker process RSS.",
    "Brush pipeline stages buffer sequentially, while terminal output streams. just-bash public exec aggregates output and resets shell state.",
  ],
};
function stopServer() {
  server.kill("SIGTERM");
}
process.once("SIGINT", stopServer);
process.once("SIGTERM", stopServer);
try {
  for (let tries = 0; tries < 100; tries++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error("Static measurement server exited");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    headless: !headed,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: headed
      ? ["--ozone-platform=wayland", "--enable-unsafe-webgpu"]
      : ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-vulkan-surface"],
  });
  result.browser = browser.version();
  for (const engine of ["brush", "just-bash"]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await page.goto(
        `http://127.0.0.1:${port}/?test=1&engine=${engine}${renderer === "canvas" ? "&renderer=canvas" : ""}`,
      );
      await page.waitForFunction(
        () =>
          window.brushWeb?.snapshot().state === "ready" &&
          window.brushWeb.snapshot().firstFrameMs !== undefined,
      );
      result.gpu = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        return adapter
          ? {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
              isFallbackAdapter: adapter.info.isFallbackAdapter,
            }
          : null;
      });
      const cold = await page.evaluate(() => ({
        snapshot: window.brushWeb.snapshot(),
        metrics: window.brushWeb.metrics(),
      }));
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      const warm = [];
      for (let iteration = 0; iteration < 3; iteration++) {
        await page.getByRole("button", { name: "Restart", exact: true }).click();
        await page.waitForFunction(
          () =>
            window.brushWeb?.snapshot().state === "ready" &&
            window.brushWeb.snapshot().firstFrameMs !== undefined,
        );
        warm.push(
          await page.evaluate(() => ({
            snapshot: window.brushWeb.snapshot(),
            metrics: window.brushWeb.metrics(),
          })),
        );
      }
      await page.locator("textarea").focus();
      for (const key of "echo latency-fixture") {
        await page.keyboard.type(key);
        await page.waitForTimeout(30);
      }
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        window.brushWeb.readLines().some((line) => line.trim() === "latency-fixture"),
      );
      const latency = await page.evaluate(() => window.brushWeb.metrics().inputLatenciesMs);
      await page.keyboard.insertText("echo stream-start; sleep 0.3; echo stream-end");
      const streamingStart = performance.now();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        window.brushWeb.readLines().some((line) => line.trim() === "stream-start"),
      );
      const firstChunkMs = performance.now() - streamingStart;
      await page.waitForFunction(() =>
        window.brushWeb.readLines().some((line) => line.trim() === "stream-end"),
      );
      const completedMs = performance.now() - streamingStart;
      await page.keyboard.insertText('echo Browser worker; echo "Unicode: שלום 世界 😀"; pwd');
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        window.brushWeb.readLines().some((line) => line.trim() === "Browser worker"),
      );
      await page.screenshot({
        path: resolve(
          root,
          "docs/evidence",
          `${headed ? "headed" : "headless"}-${renderer}-${engine}.png`,
        ),
      });
      result.samples.push({
        engine,
        cold,
        warm,
        inputLatenciesMs: latency,
        streaming: { firstChunkMs, completedMs },
        mainPageJSHeap: await page.evaluate(
          () => Reflect.get(performance, "memory")?.usedJSHeapSize ?? null,
        ),
      });
    } finally {
      await context.close();
    }
  }
  await mkdir(resolve(root, "docs/evidence"), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`Measurement evidence: ${output}\n`);
} finally {
  await browser?.close();
  stopServer();
  await new Promise((resolve) =>
    server.exitCode !== null ? resolve() : server.once("exit", resolve),
  );
  process.removeListener("SIGINT", stopServer);
  process.removeListener("SIGTERM", stopServer);
}
