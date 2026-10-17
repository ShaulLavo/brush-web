// Internal launcher: no baseline or binary inputs. The target commit supplies the scorer and source.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { migrationEvidence, oraclePath } from "./shell-scoreboard-base.mjs";
import { bytesDigest, compareScores, validateScore, verifyOracle } from "./shell-scoreboard.mjs";

const root = resolve(process.argv[2] ?? ".");
const ref = process.argv[3];
const children = new Map();
let interrupted = false;
function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function drainGroup(pid) {
  if (!pid) return;
  killGroup(pid, "SIGKILL");
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    // Linux CI/local hosts: an orphaned zombie cannot consume scratch, but a live descendant can.
    const processes = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const active = await Promise.all(
      processes.map(async (name) => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return fields[2] === String(pid) && !["Z", "X"].includes(fields[0]);
        } catch (error) {
          if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return false;
          throw error;
        }
      }),
    );
    if (!active.some(Boolean)) return;
    assert.ok(Date.now() < deadline, `target process group ${pid} did not stop`);
    await delay(20);
  }
}
function stop() {
  interrupted = true;
  for (const [pid, child] of children) {
    killGroup(pid, "SIGTERM");
    child.timer ??= setTimeout(() => killGroup(pid, "SIGKILL"), 2000).unref();
  }
}
for (const signal of ["SIGTERM", "SIGINT", "disconnect"]) process.on(signal, stop);

// Do not inherit compiler wrappers/flags, alternate Cargo targets, Node hooks, Git replacements,
// scorer overrides, or any candidate-provided artifacts. Shared dependency caches remain usable.
const env = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "TMPDIR",
    "SYSTEMROOT",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
env.GIT_NO_REPLACE_OBJECTS = "1";
function run(command, args, cwd, extraEnv = {}) {
  assert.ok(!interrupted, "target rebuild interrupted");
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    const state = {};
    if (child.pid) children.set(child.pid, state);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      // Keep ownership of the entire group after its leader exits, until no consumers remain.
      drainGroup(child.pid).then(() => {
        clearTimeout(state.timer);
        children.delete(child.pid);
        if (code === 0 && !interrupted) accept();
        else
          reject(
            new Error(`${command} failed (${signal ?? code})${interrupted ? ": interrupted" : ""}`),
          );
      }, reject);
    });
  });
}

async function migrate() {
  assert.equal(
    process.argv.length,
    4,
    "migration launcher accepts only repository and immutable base SHA",
  );
  const candidateBytes = await readFile(resolve(root, oraclePath));
  const candidate = JSON.parse(candidateBytes);
  verifyOracle(candidate);
  const { pins, oracle, baseline } = migrationEvidence(root, ref, candidate);
  const candidatePins = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
  assert.equal(
    candidatePins.shellScoreboard.oracleSha256,
    bytesDigest(candidateBytes),
    "candidate oracle checksum",
  );
  assert.notEqual(candidate.identity.oracle, oracle.identity.oracle, "oracle did not change");
  const scratchRoot = process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(resolve(scratchRoot, "audit-oracle-migration-"));
  try {
    const checkout = resolve(scratch, "target");
    const targetDir = resolve(scratch, "cargo-target");
    const archive = resolve(scratch, "target.tar");
    await mkdir(checkout);
    await run("git", ["archive", "--format=tar", `--output=${archive}`, ref], root);
    await run("tar", ["-xf", archive, "-C", checkout], scratch);
    await rm(archive);
    await run(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--target",
        "wasm32-wasip1",
        "--manifest-path",
        "shell/Cargo.toml",
        "-p",
        "shell-engine",
        "-j2",
      ],
      checkout,
      { CARGO_TARGET_DIR: targetDir, CARGO_INCREMENTAL: "0" },
    );
    const wasm = resolve(targetDir, "wasm32-wasip1/release/shell-engine.wasm");
    const binaryHash = bytesDigest(await readFile(wasm));
    const score = async (label) => {
      const output = resolve(scratch, `${label}.json`);
      await run(process.execPath, ["scripts/bash-compat.mjs"], checkout, {
        BASH_COMPAT_MODE: "frozen",
        BASH_COMPAT_ENGINES: "own-shell",
        BASH_COMPAT_JOBS: "4",
        BASH_COMPAT_TIMEOUT_MS: String(oracle.environment.timeoutMs),
        BASH_COMPAT_SKIP_BUILD: "1",
        BASH_COMPAT_RECORD: "1", // Collection only: explicit validation and comparisons follow below.
        BASH_COMPAT_SHELL_WASM: wasm,
        BASH_COMPAT_OUT: output,
        BASH_COMPAT_SCRATCH: scratch,
      });
      assert.equal(
        bytesDigest(await readFile(wasm)),
        binaryHash,
        "target binary changed while scoring",
      );
      return JSON.parse(await readFile(output, "utf8"));
    };
    const original = await score("old-oracle");
    validateScore(oracle, original);
    compareScores(baseline, original, { requireMembership: true });
    // Only the copied evidence changes, after the exact source has been built and proven.
    // Running the TARGET scorer both times prevents candidate scorer changes forging target scores.
    await writeFile(resolve(checkout, oraclePath), candidateBytes);
    pins.shellScoreboard.oracleSha256 = bytesDigest(candidateBytes);
    await writeFile(resolve(checkout, "sources.lock.json"), JSON.stringify(pins));
    const corrected = await score("corrected-oracle");
    validateScore(candidate, corrected);
    console.error(`Verified target ${ref} under original and corrected oracles`);
    return corrected;
  } finally {
    // Never remove files from under an uninterruptible consumer; surface its cleanup location.
    assert.equal(children.size, 0, `target processes remain; scratch retained at ${scratch}`);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let message;
  try {
    message = { score: await migrate() };
    assert.ok(!interrupted, "target rebuild interrupted");
  } catch (error) {
    message = { error: error.stack ?? String(error) };
    console.error(message.error);
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGTERM", "SIGINT", "disconnect"]) process.off(signal, stop);
  }
  if (process.connected) {
    await new Promise((done) => process.send(message, () => done()));
    if (process.connected) process.disconnect();
  }
}
