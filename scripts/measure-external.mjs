import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import { cpus } from "node:os";

const port = 4299;
const url = `http://127.0.0.1:${port}`;
try {
  await fetch(url);
  throw new Error(`Port ${port} is already occupied`);
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
}
const server = spawn(process.execPath, ["dist/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});
let browser;
async function teardown() {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void teardown().finally(() => process.exit(1));
  });
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(url);
      break;
    } catch {
      if (attempt === 100) throw new Error("Server did not start");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.goto(`${url}/?test=1&renderer=canvas`);
  const ready = () => page.waitForFunction(() => window.brushWeb?.snapshot().state === "ready");
  await ready();
  await page.locator("textarea").focus();
  async function run(command, count) {
    await page.keyboard.insertText(command);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (n) => (window.brushWeb?.metrics()?.externalCommands.length ?? 0) >= n,
      count,
    );
    await ready();
  }
  await run(`bun -e 'console.log(1)'`, 1);
  for (let i = 0; i < 5; i++) await run(`bun -e 'console.log(1)'`, i + 2);
  await run(`for i in {1..20}; do bun -e '0'; done`, 26);
  await page.screenshot({ path: "docs/evidence/external-commands.png" });
  const samples = await page.evaluate(() => window.brushWeb.metrics().externalCommands);
  const elapsed = (sample) => sample.finishedAt - sample.startedAt;
  const first = (sample) => sample.firstOutputAt - sample.startedAt;
  const average = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    cpu: cpus()[0].model,
    engine: "QuickJS bun.wasm",
    shell: "Brush wasm32-wasip1",
    command: "bun -e 'console.log(1)'",
    cold: { firstOutputMs: first(samples[0]), totalMs: elapsed(samples[0]) },
    warm: {
      trials: 5,
      firstOutputMs: average(samples.slice(1, 6).map(first)),
      totalMs: average(samples.slice(1, 6).map(elapsed)),
    },
    loop: {
      command: "for i in {1..20}; do bun -e '0'; done",
      count: 20,
      perCommandMs: average(samples.slice(6).map(elapsed)),
      wallMs: samples.at(-1).finishedAt - samples[6].startedAt,
    },
    samples,
  };
  await writeFile("docs/evidence/external-commands.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ cold: result.cold, warm: result.warm, loop: result.loop }, null, 2));
} finally {
  await teardown();
}
