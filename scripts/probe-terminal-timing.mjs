import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const port = 4208;
let browser, server;
const result = {
  sourcePins: JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")),
  browser: "",
  samples: [],
  cleanup: {},
  limitations: [
    "Five echo turns per engine and presentation mode. This validates the new timing API, not a replacement for the twenty-trial workload matrices.",
    "presentedAt is the first task after the page update. It is not a GPU timestamp or physical display scanout. Times use the page performance clock.",
  ],
};
const interrupt = () => {
  void browser?.close().catch(() => undefined);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const check = createServer();
  await new Promise((r, j) => {
    check.once("error", j);
    check.listen(port, "127.0.0.1", r);
  });
  await new Promise((r) => check.close(r));
  server = spawn(process.execPath, [resolve(root, "dist/serve.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  result.browser = browser.version();
  for (const presentation of ["frame", "immediate"])
    for (const engine of ["brush", "just-bash", "bashkit", "bashkit-terminal"])
      await measure(engine, presentation);
  async function measure(engine, presentation) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.goto(
        `http://127.0.0.1:${port}/?test=1&trace=1&profile=phase&engine=${engine}&presentation=${presentation}`,
      );
      await page.waitForFunction(() => window.brushWeb?.snapshot().state === "ready");
      const snapshot = await page.evaluate(() => window.brushWeb.snapshot());
      if (snapshot.renderer !== "webgpu") throw new Error("WebGPU renderer fell back");
      await page.waitForTimeout(200);
      await page.locator("textarea").focus();
      for (let trial = 1; trial <= 5; trial++) await turn(page, engine, presentation, trial);
    } finally {
      await page.close();
    }
  }
  async function turn(page, engine, presentation, trial) {
    const marker = `TIMING_${engine}_${presentation}_${trial}`;
    await page.keyboard.insertText(`echo ${marker}`);
    await page.waitForTimeout(180);
    const before = await page.evaluate(() => performance.now());
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      ({ before, marker }) =>
        window.brushWeb.visibleLines().some((x) => x.trim() === marker) &&
        window.brushWeb.outputTimings().some((x) => x.inputAt >= before),
      { before, marker },
    );
    const data = await page.evaluate(
      (before) => ({
        timing: window.brushWeb.outputTimings().find((x) => x.inputAt >= before),
        execution: window.brushWeb.metrics().lastExecution,
        origin: performance.timeOrigin,
      }),
      before,
    );
    const t = data.timing;
    if (
      !Number.isFinite(t.inputAt) ||
      !Number.isFinite(t.drawnAt) ||
      !Number.isFinite(t.presentedAt) ||
      t.hidden
    )
      throw new Error("Incomplete timing event");
    if (
      t.inputAt > t.firstOutputAt ||
      t.firstOutputAt > t.lastOutputAt ||
      t.lastOutputAt > t.drawnAt ||
      t.drawnAt > t.presentedAt
    )
      throw new Error("Timing event is out of order");
    result.samples.push({
      engine,
      presentation,
      trial,
      ...data,
      inputToOutputMs: t.firstOutputAt - t.inputAt,
      outputToDrawnMs: t.drawnAt - t.lastOutputAt,
      drawnToPresentedMs: t.presentedAt - t.drawnAt,
      inputToPresentedMs: t.presentedAt - t.inputAt,
    });
  }
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await stopped;
  }
  result.cleanup = { browserClosed: true, serverStopped: true };
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(
    resolve(root, "docs/evidence/ghostty-new-timing.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
