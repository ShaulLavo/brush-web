import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { bytesDigest, verifyOracle, validateScore } from "./shell-scoreboard.mjs";

export const oraclePath = "docs/evidence/own-shell-oracle.json";
export const baselinePath = "docs/evidence/own-shell-baseline.json";

// Filter before fork startup, not only after the launcher has loaded Node hooks.
export function migrationEnvironment() {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "TMPDIR",
      "RUNNER_TEMP",
      "SYSTEMROOT",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

export function baseFile(root, ref, path) {
  assert.match(ref, /^[a-f0-9]{40}$/, "BASH_COMPAT_BASE_REF must be a full commit SHA");
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  assert.equal(
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    ref,
    "BASH_COMPAT_BASE_REF must identify an exact commit",
  );
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Read the target branch's baseline, never a path chosen by the candidate's pin.
export function baseBranchBaseline(root, ref) {
  if (!ref) return null;
  const pins = JSON.parse(baseFile(root, ref, "sources.lock.json"));
  if (!pins.shellScoreboard) return null; // First baseline only. Later omissions fail closed.
  return JSON.parse(baseFile(root, ref, baselinePath));
}

export function migrationEvidence(root, ref, candidateOracle) {
  const pins = JSON.parse(baseFile(root, ref, "sources.lock.json"));
  const bytes = baseFile(root, ref, oraclePath);
  assert.equal(bytesDigest(bytes), pins.shellScoreboard.oracleSha256, "target oracle checksum");
  const oracle = JSON.parse(bytes);
  const baseline = JSON.parse(baseFile(root, ref, baselinePath));
  verifyOracle(oracle);
  verifyOracle(candidateOracle);
  validateScore(oracle, baseline);
  const withoutObservations = ({ oracle: _observations, ...identity }) => identity;
  assert.deepEqual(
    withoutObservations(candidateOracle.identity),
    withoutObservations(oracle.identity),
    "oracle migration requires unchanged caseSet/environment/sources/schema",
  );
  return { pins, oracle, baseline };
}

const activeMigrations = new Set();

// Cancellation owns only launchers created here; the trusted three-argument input stays unchanged.
// Their promises settle after the launcher has drained its consumers and removed its scratch.
export function cancelTargetMigrations() {
  for (const child of activeMigrations) child.kill("SIGTERM");
}

// The launcher owns an isolated rebuild, not an evidence/artifact path supplied by the candidate.
// Its IPC connection also gives it a parent-death notification for teardown.
export async function targetBranchBaseline(root, ref, oracle) {
  assert.equal(arguments.length, 3, "target baseline accepts no supplied artifacts or options");
  const baseline = baseBranchBaseline(root, ref);
  if (!baseline) return null;
  if (baseline.identity.oracle === oracle.identity.oracle) {
    validateScore(oracle, baseline);
    return baseline;
  }
  migrationEvidence(root, ref, oracle);
  for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_BASELINE", "BASH_COMPAT_ORACLE"])
    assert.equal(process.env[name], undefined, `oracle migration rejects supplied ${name}`);
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./shell-scoreboard-migration.mjs", import.meta.url), [root, ref], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: migrationEnvironment(),
      execArgv: [],
    });
    activeMigrations.add(child);
    let result;
    child.on("message", (message) => {
      result = message;
    });
    child.once("error", (error) => {
      activeMigrations.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeMigrations.delete(child);
      if (code !== 0 || !result?.score)
        return reject(new Error(result?.error ?? `target rebuild failed (${signal ?? code})`));
      try {
        validateScore(oracle, result.score);
        resolve(result.score);
      } catch (error) {
        reject(error);
      }
    });
  });
}
