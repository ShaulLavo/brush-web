import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const port = 4207;
let browser, server, directory;
const result = {
  source: JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")).bashkitTerminal,
  browser: "",
  wasmSha256: "",
  data: null,
  cleanup: {},
};
async function probe() {
  const { initBashkit, Bash, Terminal } = await import("./package/index.js");
  await initBashkit();
  const options = {
    profile: "interactive",
    maxCommands: 10000000,
    maxLoopIterations: 10000000,
    maxMemory: 33554432,
    timeoutMs: 60000,
  };
  const bash = new Bash(options);
  const terminal = new Terminal(options);
  await terminal.runUntilIdle();
  terminal.takeOutput();
  const fixtures = [
    {
      id: "arithmetic-20000",
      command: "sum=0; for ((i=0;i<20000;i++)); do sum=$((sum+i)); done; echo sum:$sum",
      expected: "sum:199990000",
    },
    {
      id: "substitutions-1000",
      command:
        "sum=0; for ((i=1;i<=1000;i++)); do v=$(printf '%s' \"$i\"); sum=$((sum+v)); done; echo sub:$sum",
      expected: "sub:500500",
    },
    { id: "terminal-10000", command: "seq 10000", expected: "10000" },
  ];
  const samples = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  async function run(api, fixture, trial) {
    let text, bytes;
    const start = performance.now();
    if (api === "Bash.execute") {
      const output = await bash.execute(fixture.command);
      text = output.stdout;
      bytes = encoder.encode(text).length;
      if (output.exitCode !== 0) throw new Error(`Script failed: ${output.stderr}`);
    } else {
      terminal.sendBytes(encoder.encode(fixture.command + "\r"));
      await terminal.runUntilIdle();
      const output = terminal.takeOutput();
      bytes = output.length;
      text = decoder.decode(output);
    }
    const elapsedMs = performance.now() - start;
    if (!text.split(/\r?\n/).includes(fixture.expected))
      throw new Error(`Wrong ${api} result for ${fixture.id}`);
    if (trial) samples.push({ api, fixture: fixture.id, trial, elapsedMs, bytes });
  }
  for (const fixture of fixtures) {
    await run("Bash.execute", fixture, 0);
    await run("Terminal", fixture, 0);
    for (let trial = 1; trial <= 20; trial++) {
      const order = trial % 2 ? ["Bash.execute", "Terminal"] : ["Terminal", "Bash.execute"];
      for (const api of order) await run(api, fixture, trial);
    }
  }
  return {
    samples,
    limitations: [
      "Same WASM module, feature set and options in one browser worker. Measures each API plus output extraction/conversion, without Ghostty, the shared bridge or frame scheduling.",
      "Terminal also includes native input editing, echo, the vt100 parser and transcript capture. The differential is combined terminal machinery, not isolated vt100 time.",
      "Bash.execute returns collected output. Terminal output includes input echo and a prompt; payload sizes differ. Each fixture initializes its own working variables.",
    ],
  };
}
const interrupt = () => {
  void browser?.close().catch(() => undefined);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const check = createServer();
  await new Promise((resolve, reject) => {
    check.once("error", reject);
    check.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => check.close(resolve));
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  directory = await mkdtemp(resolve(root, ".scratch/bashkit-apis-"));
  await cp(resolve(root, ".sources/bashkit/pkg"), resolve(directory, "package"), {
    recursive: true,
  });
  result.wasmSha256 = createHash("sha256")
    .update(await readFile(resolve(directory, "package/bashkit_wasm_bg.wasm")))
    .digest("hex");
  await cp(resolve(root, "scripts/serve.mjs"), resolve(directory, "serve.mjs"));
  await writeFile(
    resolve(directory, "index.html"),
    "<!doctype html><title>Same-binary Bashkit API probe</title>",
  );
  await writeFile(
    resolve(directory, "probe.worker.js"),
    `onmessage=async()=>{try{postMessage({data:await (${probe})()})}catch(error){postMessage({error:String(error)})}}`,
  );
  server = spawn(process.execPath, [resolve(directory, "serve.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  result.browser = browser.version();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  result.data = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker("./probe.worker.js", { type: "module" });
        const timeout = setTimeout(() => finish(new Error("API probe exceeded 60 seconds")), 60000);
        function finish(error, data) {
          clearTimeout(timeout);
          worker.terminate();
          if (error) reject(error);
          else resolve(data);
        }
        worker.onmessage = ({ data }) =>
          data.error ? finish(new Error(data.error)) : finish(undefined, data.data);
        worker.onerror = (event) => finish(new Error(event.message));
        worker.postMessage(null);
      }),
  );
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  if (directory) await rm(directory, { recursive: true });
  result.cleanup = { browserClosed: true, serverStopped: true, snapshotRemoved: true };
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(
    resolve(root, "docs/evidence/bashkit-same-binary-apis.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
