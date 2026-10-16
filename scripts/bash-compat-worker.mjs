// One engine per worker thread. The parent terminates a worker that exceeds the case timeout.
import { parentPort, workerData } from "node:worker_threads";
import { WASI } from "node:wasi";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pythonList } from "./bash-compat-helpers.mjs";

const { engine, modulePath, scratch, home, tmp, env } = workerData;

const helpers = {
  "argv.py": (args) => pythonList(args),
  "printenv.py": (args, exported) => args.map((name) => `${exported[name] ?? "None"}\n`).join(""),
};

async function createRunner() {
  if (engine === "brush" || engine === "own-shell") return brushRunner();
  if (engine === "just-bash") return justBashRunner();
  return bashkitRunner();
}

function brushRunner() {
  const module = new WebAssembly.Module(readFileSync(modulePath));
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const browser = {
    sleep(ms) {
      Atomics.wait(sleeper, 0, 0, ms);
      return 0;
    },
    raw_mode() {},
    columns: () => 80,
    rows: () => 24,
    read: () => 0,
    cancelled: () => 0,
  };
  return async (code) => {
    const directory = mkdtempSync(resolve(scratch, "brush-"));
    const root = resolve(directory, "root");
    for (const path of [tmp, home, "/dev", "/.compat"])
      mkdirSync(resolve(root, "." + path), { recursive: true });
    writeFileSync(resolve(root, "dev/null"), "");
    writeFileSync(resolve(root, ".compat/case.sh"), code);
    const stdin = openSync("/dev/null", "r");
    const stdout = openSync(resolve(directory, "stdout"), "w");
    const stderr = openSync(resolve(directory, "stderr"), "w");
    let status;
    let crash;
    try {
      const wasi = new WASI({
        version: "preview1",
        args: engine === "own-shell" ? ["shell-engine", "-c", code] : ["bash", "/.compat/case.sh"],
        env: { ...env, PWD: tmp },
        preopens: engine === "own-shell" ? {} : { "/": root },
        stdin,
        stdout,
        stderr,
        returnOnExit: true,
      });
      let written = 0;
      let instance;
      const wasiImports = { ...wasi.wasiImport };
      if (engine === "own-shell")
        wasiImports.fd_write = (fd, iovs, count, result) => {
          const memory = new DataView(instance.exports.memory.buffer);
          for (let index = 0; index < count; index++)
            written += memory.getUint32(iovs + index * 8 + 4, true);
          if (written > 4 * 1024 * 1024) throw new Error("compatibility output limit exceeded");
          return wasi.wasiImport.fd_write(fd, iovs, count, result);
        };
      instance = new WebAssembly.Instance(module, {
        wasi_snapshot_preview1: wasiImports,
        browser,
      });
      status = wasi.start(instance);
    } catch (error) {
      crash = String(error?.message ?? error);
    } finally {
      for (const fd of [stdin, stdout, stderr]) closeSync(fd);
    }
    const result = {
      stdout: readFileSync(resolve(directory, "stdout")),
      stderr: readFileSync(resolve(directory, "stderr")),
      status,
      crash,
    };
    rmSync(directory, { recursive: true, force: true });
    return result;
  };
}

async function justBashRunner() {
  const { Bash, InMemoryFs, defineCommand } = await import("just-bash");
  const commands = Object.entries(helpers).map(([name, helper]) =>
    defineCommand(name, async (args, context) => ({
      stdout: helper(args, context.exportedEnv ?? Object.fromEntries(context.env)),
      stderr: "",
      exitCode: 0,
    })),
  );
  return async (code) => {
    const fs = new InMemoryFs({}, { maxTotalBytes: 16 * 1024 * 1024 });
    for (const path of [tmp, home]) await fs.mkdir(path, { recursive: true });
    // Same limits as the workbench adapter (src/baseline-session.ts).
    const bash = new Bash({
      fs,
      cwd: tmp,
      env,
      python: false,
      javascript: false,
      defenseInDepth: false,
      customCommands: commands,
      executionLimits: {
        maxOutputSize: 4 * 1024 * 1024,
        maxStringLength: 4 * 1024 * 1024,
        maxLiveBytes: 32 * 1024 * 1024,
        maxCommandCount: 10000000,
        maxLoopIterations: 10000000,
        maxWorkUnits: 100000000,
        maxExecutionTimeMs: 60000,
      },
    });
    const result = await bash.exec(code, { rawScript: true });
    return {
      stdout: Buffer.from(result.stdout, "utf8"),
      stderr: Buffer.from(result.stderr, "utf8"),
      status: result.exitCode,
    };
  };
}

async function bashkitRunner() {
  const { initBashkit, Bash } = await import(resolve(modulePath, "index.js"));
  await initBashkit(readFileSync(resolve(modulePath, "bashkit_wasm_bg.wasm")));
  const customBuiltins = Object.fromEntries(
    Object.entries(helpers).map(([name, helper]) => [
      name,
      (request) => helper(request.argv, request.env),
    ]),
  );
  return async (code) => {
    // Same options as the workbench Bashkit sessions, with a shorter deadline.
    const bash = new Bash({
      profile: "interactive",
      cwd: tmp,
      env,
      maxCommands: 10000000,
      maxLoopIterations: 10000000,
      maxMemory: 32 * 1024 * 1024,
      timeoutMs: 20000,
      customBuiltins,
    });
    for (const path of [tmp, home]) bash.mkdir(path);
    let result;
    try {
      result = await bash.execute(code);
    } catch (error) {
      // Bashkit rejects a script that fails to parse; bash reports status 2 instead.
      const message = String(error?.message ?? error);
      if (!message.startsWith("parse error")) throw error;
      return { stdout: Buffer.alloc(0), stderr: Buffer.from(message + "\n"), status: 2 };
    }
    return {
      stdout: Buffer.from(result.stdoutBytes),
      stderr: Buffer.from(result.stderrBytes),
      status: result.exitCode,
      truncated: result.stdoutTruncated || result.stderrTruncated || undefined,
    };
  };
}

const run = await createRunner();
parentPort.on("message", async ({ id, code }) => {
  try {
    parentPort.postMessage({ id, ...(await run(code)) });
  } catch (error) {
    parentPort.postMessage({
      id,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      crash: String(error?.message ?? error),
    });
  }
});
parentPort.postMessage({ ready: true });
