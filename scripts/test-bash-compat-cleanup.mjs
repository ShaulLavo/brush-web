import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { drainGroup, killGroup } from "./shell-process-group.mjs";

const root = process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
await mkdir(root, { recursive: true });

async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

function fixtureOwner(t) {
  const owner = { groups: new Set(), messages: [], stderr: [] };
  // No pre-existing children or scratch belong to this fixture. Register teardown before setup.
  t.after(async () => {
    if (owner.child) {
      if (owner.child.exitCode === null && owner.child.signalCode === null) {
        if (owner.child.connected) owner.child.send("release", () => {});
        owner.child.kill("SIGTERM");
      }
      const timer = setTimeout(() => owner.child.kill("SIGKILL"), 1500).unref();
      try {
        await owner.closed;
      } finally {
        clearTimeout(timer);
      }
    }
    for (const pid of owner.groups) killGroup(pid, "SIGKILL");
    for (const pid of owner.groups) await drainGroup(pid);
    if (owner.scratch) await rm(owner.scratch, { recursive: true, force: true });
  });
  owner.start = (body, env) => {
    const script = `
      (async () => {
        try {
          ${body}
          await import(${JSON.stringify(new URL("./bash-compat.mjs", import.meta.url).href)});
        } finally {
          process.disconnect?.();
        }
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, ...env, BASH_COMPAT_SCRATCH: owner.scratch },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    owner.child = child;
    owner.closed = once(child, "close");
    child.stderr.on("data", (chunk) => owner.stderr.push(chunk));
    child.on("message", (message) => {
      owner.messages.push(message);
      if (message?.kind === "deferred") owner.groups.add(message.pid);
    });
    return child;
  };
  owner.message = (kind) =>
    waitFor(
      () => owner.messages.find((value) => value === kind || value?.kind === kind),
      `missing ${kind} message: ${Buffer.concat(owner.stderr)}`,
    );
  return owner;
}

test("live capture cancellation holds owned groups until they stop", async (t) => {
  const owner = fixtureOwner(t);
  const scratch = await mkdtemp(resolve(root, "compat-cleanup-live-"));
  owner.scratch = scratch;
  const fixture = resolve(scratch, "crates/bashkit/tests/spec_cases/bash");
  await mkdir(fixture, { recursive: true });
  await writeFile(
    resolve(fixture, "delayed.test.sh"),
    '### delayed owned group\nsleep 30 & printf ready > "$TMP/live"; wait\n',
  );
  const child = owner.start(
    `
    const signal = process.kill;
    const groups = new Set();
    let released = false;
    process.kill = (pid, kind) => {
      if (!released && pid < 0 && kind === "SIGKILL") {
        groups.add(pid);
        process.send?.({kind: "deferred", pid: -pid});
        return true;
      }
      return signal(pid, kind);
    };
    process.on("message", (message) => {
      if (message !== "release") return;
      released = true;
      for (const pid of groups) {
        try { signal(pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    });
  `,
    {
      BASH_COMPAT_MODE: "live",
      BASH_COMPAT_ENGINES: "own-shell",
      BASH_COMPAT_SKIP_BUILD: "1",
      BASH_COMPAT_CORPORA: "bashkit-suite",
      BASH_COMPAT_BASHKIT_DIR: scratch,
      BASH_COMPAT_BASH: "/usr/bin/bash",
      BASH_COMPAT_JOBS: "1",
      BASH_COMPAT_TIMEOUT_MS: "10000",
    },
  );
  const marker = await waitFor(async () => {
    for (const name of await readdir(scratch)) {
      if (!name.startsWith("brush-web-compat-")) continue;
      for (const childName of await readdir(resolve(scratch, name))) {
        if (!childName.startsWith("bash-")) continue;
        const candidate = resolve(scratch, name, childName, "tmp", "live");
        if ((await readFile(candidate, "utf8").catch(() => "")) === "ready") return candidate;
      }
    }
    return null;
  }, "live compatibility capture did not start");
  child.kill("SIGTERM");
  await owner.message("deferred");
  await delay(50);
  assert.equal(child.exitCode, null, "SIGTERM exited before the owned group stopped");
  assert.equal(await readFile(marker, "utf8"), "ready");
  child.send("release");
  const [status] = await owner.closed;
  assert.equal(status, 143, Buffer.concat(owner.stderr).toString());
  assert.deepEqual(await readdir(scratch), ["crates"]);
});

async function workerLifetime(t, mode) {
  const owner = fixtureOwner(t);
  const scratch = await mkdtemp(resolve(root, `compat-cleanup-${mode}-`));
  owner.scratch = scratch;
  if (mode === "live") {
    const fixture = resolve(scratch, "crates/bashkit/tests/spec_cases/bash");
    await mkdir(fixture, { recursive: true });
    await writeFile(resolve(fixture, "ready.test.sh"), "### ready\nprintf ready\n");
  }
  const wasm = resolve(scratch, "sleep.wasm");
  // Valid finite WASI/browser stand-in. Dispatch is held below, so no guest code executes:
  // this control exercises the shipped entrypoint and real worker lifetime, not shell semantics.
  const bytes = Buffer.from(
    "0061736d0100000001090260000060017f017f0211010762726f7773657205736c6565700001030201000503010001071302065f73746172740000066d656d6f727902000a0b01090041b0ea0110001a0b",
    "hex",
  );
  assert.equal(WebAssembly.validate(bytes), true);
  await writeFile(wasm, bytes);
  const child = owner.start(
    `
    const { Worker } = await import("node:worker_threads");
    const terminate = Worker.prototype.terminate;
    const postMessage = Worker.prototype.postMessage;
    const pending = [];
    let running = false;
    let released = false;
    Worker.prototype.terminate = function () {
      if (released) return terminate.call(this);
      process.send?.("terminate");
      return new Promise((resolve) => pending.push(() => terminate.call(this).then(resolve)));
    };
    Worker.prototype.postMessage = function (...args) {
      if (!running && args[0]?.id === 1) {
        running = true;
        process.send?.("running");
        return;
      }
      return postMessage.apply(this, args);
    };
    process.on("message", (message) => {
      if (message !== "release") return;
      released = true;
      for (const resume of pending.splice(0)) resume();
    });
  `,
    {
      BASH_COMPAT_MODE: mode,
      BASH_COMPAT_CORPORA: mode === "live" ? "bashkit-suite" : undefined,
      BASH_COMPAT_BASHKIT_DIR: scratch,
      BASH_COMPAT_BASH: "/usr/bin/bash",
      BASH_COMPAT_ENGINES: "own-shell",
      BASH_COMPAT_SKIP_BUILD: "1",
      BASH_COMPAT_RECORD: "1",
      BASH_COMPAT_SHELL_WASM: wasm,
      BASH_COMPAT_JOBS: "1",
      BASH_COMPAT_TIMEOUT_MS: "10000",
    },
  );
  await owner.message("running");
  const directory = (await readdir(scratch)).find((name) => name.startsWith("brush-web-compat-"));
  assert.ok(directory);
  child.kill("SIGTERM");
  await owner.message("terminate");
  await delay(50);
  assert.equal(child.exitCode, null, "SIGTERM exited before worker termination completed");
  assert.ok(await readdir(resolve(scratch, directory)));
  child.send("release");
  const [status] = await owner.closed;
  assert.equal(status, 143, Buffer.concat(owner.stderr).toString());
  assert.deepEqual(
    (await readdir(scratch)).sort(),
    mode === "live" ? ["crates", "sleep.wasm"] : ["sleep.wasm"],
  );
}

for (const mode of ["frozen", "live"]) {
  test(`${mode} replay awaits worker termination before removing scratch`, (t) =>
    workerLifetime(t, mode));
}

test("record-only frozen cancellation during oracle loading starts no build or worker", async (t) => {
  const owner = fixtureOwner(t);
  owner.scratch = await mkdtemp(resolve(root, "compat-cleanup-loading-"));
  const child = owner.start(
    `
    const fs = await import("node:fs/promises");
    const threads = await import("node:worker_threads");
    const processes = await import("node:child_process");
    const { syncBuiltinESMExports } = await import("node:module");
    const execFileSync = processes.default.execFileSync;
    const readFile = fs.default.readFile;
    let held = false;
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    fs.default.readFile = async function (path, ...args) {
      const result = await readFile(path, ...args);
      if (!held && String(path).endsWith("/docs/evidence/own-shell-oracle.json")) {
        held = true;
        process.send?.("reading");
        await released;
      }
      return result;
    };
    // Dispatch spies only: keep build enabled so removing the pre-build guard fails this control.
    // No fake teardown or guest execution substitutes for production.
    processes.default.execFileSync = function (command, ...args) {
      if (command === "cargo") throw Error("build started after cancellation");
      return execFileSync(command, ...args);
    };
    threads.default.Worker = class {
      constructor() { throw Error("worker created after cancellation"); }
    };
    syncBuiltinESMExports();
    process.on("message", (message) => { if (message === "release") release(); });
  `,
    {
      BASH_COMPAT_MODE: "frozen",
      BASH_COMPAT_CORPORA: undefined,
      BASH_COMPAT_ENGINES: "own-shell",
      BASH_COMPAT_SKIP_BUILD: "0",
      BASH_COMPAT_RECORD: "1",
      BASH_COMPAT_JOBS: "1",
      BASH_COMPAT_TIMEOUT_MS: "10000",
    },
  );
  await owner.message("reading");
  child.kill("SIGTERM");
  await delay(50);
  assert.equal(child.exitCode, null, "entrypoint abandoned its outstanding oracle read");
  child.send("release");
  const [status] = await owner.closed;
  assert.equal(status, 143, Buffer.concat(owner.stderr).toString());
  assert.deepEqual(await readdir(owner.scratch), []);
});
