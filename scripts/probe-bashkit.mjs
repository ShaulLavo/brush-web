import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
const root = resolve(import.meta.dirname, "..");
const port = 4206;
let browser,
  server,
  directory,
  interrupted = false;
const result = {
  package: "@everruns/bashkit-wasm",
  version: "0.18.2",
  browser: "",
  cases: [],
  cleanup: {},
};
const interrupt = () => {
  interrupted = true;
  void browser?.close().catch(() => undefined);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const workerSource = `import {Bash,initBashkit} from './package/index.js';
await initBashkit();const bash=new Bash({profile:"interactive",timeoutMs:60000,maxCommands:10000000,maxLoopIterations:10000000,maxMemory:33554432});
const clock=()=>performance.timeOrigin+performance.now();
postMessage({kind:'ready'});
onmessage=async({data})=>{
 if(data.kind==='cancel'){bash.cancel();postMessage({kind:'cancelCalled',at:clock()});return;}
 bash.clearCancel();postMessage({kind:'started',at:clock()});
 try{const r=data.stream?await bash.executeWithOutput(data.command,(stdout,stderr)=>postMessage({kind:'output',stdout,stderr,at:clock()})):await bash.execute(data.command);
 postMessage({kind:'finished',stdout:r.stdout,stderr:r.stderr,exitCode:r.exitCode,at:clock()});
 }catch(error){postMessage({kind:'finished',error:String(error),at:clock()});}
};`;
async function cleanup() {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  if (directory) await rm(directory, { recursive: true });
  result.cleanup = { browserClosed: true, serverStopped: true, snapshotRemoved: true };
}
try {
  const check = createServer();
  await new Promise((resolve, reject) => {
    check.once("error", reject);
    check.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => check.close(resolve));
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  directory = await mkdtemp(resolve(root, ".scratch/bashkit-probe-"));
  await cp(resolve(root, "node_modules/@everruns/bashkit-wasm"), resolve(directory, "package"), {
    recursive: true,
  });
  await cp(resolve(root, "dist/serve.mjs"), resolve(directory, "serve.mjs"));
  await writeFile(
    resolve(directory, "index.html"),
    "<!doctype html><title>Bashkit API probe</title>",
  );
  await writeFile(resolve(directory, "probe.worker.js"), workerSource);
  if (interrupted) throw new Error("Interrupted");
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
  result.cases = await page.evaluate(async () => {
    const worker = new Worker("./probe.worker.js", { type: "module" });
    function waitReady() {
      return new Promise((resolve, reject) => {
        worker.onmessage = (e) => e.data.kind === "ready" && resolve();
        worker.onerror = (e) => reject(new Error(e.message));
      });
    }
    async function run(id, command, cancel, stream = false) {
      return new Promise((resolve, reject) => {
        const events = [];
        let timer;
        const timeout = setTimeout(() => finish(new Error("Bashkit probe timeout")), 10000);
        function finish(error) {
          clearTimeout(timer);
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve({ id, events });
        }
        worker.onmessage = ({ data }) => {
          events.push(data);
          if (data.kind === "started" && cancel)
            timer = setTimeout(() => {
              events.push({ kind: "cancelSent", at: performance.timeOrigin + performance.now() });
              worker.postMessage({ kind: "cancel" });
            }, 30);
          if (
            events.some((e) => e.kind === "finished") &&
            (!cancel || events.some((e) => e.kind === "cancelCalled"))
          )
            finish();
        };
        worker.postMessage({ kind: "execute", command, stream });
      });
    }
    try {
      await waitReady();
      return [
        await run("stream", "echo STREAM_BEGIN; sleep 0.3; echo STREAM_END", false, true),
        await run("sleep-cancel", "sleep 0.3; echo AFTER_SLEEP", true),
        await run(
          "cpu-cancel",
          "COUNT=0; while ((COUNT<200000)); do ((COUNT++)); done; echo COUNT:$COUNT",
          true,
        ),
        await run(
          "file-repeat",
          "for ((R=0;R<20;R++)); do seq 10000 > source; cat source | cat > copy; mapfile -t rows < copy; echo FILE:$R:${#rows[@]}; done",
          false,
        ),
      ];
    } finally {
      worker.terminate();
    }
  });
} catch (error) {
  result.error = String(error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  await cleanup();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(
    resolve(root, "docs/evidence/bashkit-capabilities.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
