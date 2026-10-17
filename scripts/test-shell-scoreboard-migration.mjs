import assert from "node:assert/strict";
import { execFileSync, fork, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { baselinePath, oraclePath, targetBranchBaseline } from "./shell-scoreboard-base.mjs";
import { bytesDigest, compareScores, sealOracle, validateScore } from "./shell-scoreboard.mjs";

// Original fake compiler/scorer: no Cargo, WASI execution, network, or installed dependencies.
const cargoFixture = `#!${process.execPath}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const target = process.env.CARGO_TARGET_DIR;
if (existsSync(target)) throw Error('reused build artifacts');
if (process.env.RUSTC_WRAPPER || process.env.RUSTFLAGS) throw Error('compiler environment leaked');
const source = readFileSync('shell/source.json');
mkdirSync(resolve(target, 'wasm32-wasip1/release'), { recursive: true });
writeFileSync(resolve(target, 'wasm32-wasip1/release/shell-engine.wasm'), source);
if (JSON.parse(source).buildFail) throw Error('fake build failure');
if (JSON.parse(source).hang) {
  const marker = resolve(target, '../started');
  if (JSON.parse(source).descendant) {
    const script = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" +
      JSON.stringify(marker) + ",String(process.pid));setInterval(()=>{},1000)";
    spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  } else {
    process.on('SIGTERM', () => {});
    writeFileSync(marker, String(process.pid));
  }
  setInterval(() => {}, 1000);
}
`;
const scorerFixture = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
assert.equal(process.env.BASH_COMPAT_RECORD, '1');
assert.equal(process.env.BASH_COMPAT_BASE_REF, undefined, 'recursive base validation');
assert.equal(process.env.BASH_COMPAT_SKIP_BUILD, '1');
const oracle = JSON.parse(readFileSync('${oraclePath}'));
assert.equal(process.env.BASH_COMPAT_TIMEOUT_MS, String(oracle.environment.timeoutMs));
const actual = JSON.parse(readFileSync(process.env.BASH_COMPAT_SHELL_WASM));
if (actual.scoreFail && oracle.oracle.capture === 'corrected') throw Error('fake scorer failure');
writeFileSync(process.env.BASH_COMPAT_OUT, JSON.stringify({
  identity: oracle.identity,
  cases: oracle.cases.map(({ id, corpus, category, kind, bash }) => ({
    id, corpus, category, kind,
    outcome: bash.stdout === actual.stdout ? 'pass' : 'fail',
  })),
}));
`;
function makeOracle(environment = { nodeVersion: "v26.7.0", stdin: "empty", timeoutMs: 10000 }) {
  return sealOracle({
    schema: 1,
    oracle: { capture: "old" },
    environment,
    sources: {
      oils: { revision: "fixture" },
      "brush-suite": { revision: "fixture" },
      "bashkit-suite": { revision: "fixture" },
    },
    cases: ["YQ==", "Yg=="].map((stdout, index) => ({
      id: `oils:${index}`,
      corpus: "oils",
      category: "fixture",
      kind: "builtins-only",
      code: "printf a",
      bash: { status: 0, stdout, stderr: "" },
    })),
  });
}
function score(oracle, outcomes = ["pass", "fail"]) {
  return {
    identity: oracle.identity,
    cases: oracle.cases.map(({ id, corpus, category, kind }, index) => ({
      id,
      corpus,
      category,
      kind,
      outcome: outcomes[index],
    })),
  };
}
function directChildren() {
  const ids = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim();
  return new Map(
    ids
      ? ids
          .split(/\s+/)
          .map(Number)
          .map((pid) => [pid, processState(pid).start])
      : [],
  );
}
function fixtureOwner() {
  const preexisting = directChildren();
  const owner = { scratch: undefined };
  let teardown;
  const cleanup = () =>
    (teardown ??= (async () => {
      const owned = new Map();
      const deadline = Date.now() + 15000;
      for (;;) {
        for (const [pid, start] of directChildren()) {
          if (preexisting.get(pid) !== start && !owned.has(pid)) {
            owned.set(pid, start);
            if (processState(pid).active) {
              try {
                process.kill(pid, "SIGTERM");
              } catch (error) {
                if (error.code !== "ESRCH") throw error;
              }
            }
          }
        }
        const live = Array.from(owned, ([pid, start]) => {
          const current = processState(pid);
          return current.active && current.start === start;
        });
        if (!live.some(Boolean)) break;
        assert.ok(
          Date.now() < deadline,
          `fixture children remain; scratch retained at ${owner.scratch}`,
        );
        await delay(20);
      }
      if (owner.scratch) rmSync(owner.scratch, { recursive: true, force: true });
    })());
  const term = () => {
    void cleanup().then(
      () => process.exit(143),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  const int = () => {
    void cleanup().then(
      () => process.exit(130),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", int);
  owner.close = async () => {
    try {
      await cleanup();
    } finally {
      process.off("SIGTERM", term);
      process.off("SIGINT", int);
    }
  };
  return owner;
}
async function fixture(
  run,
  {
    wrongBaseline = false,
    badChecksum = false,
    hang = false,
    descendant = false,
    buildFail = false,
    scoreFail = false,
    entrypoint = false,
  } = {},
) {
  const owner = fixtureOwner(); // Teardown and the pre-existing child inventory precede setup.
  const saved = { ...process.env };
  try {
    const scratchRoot = process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(resolve(scratchRoot, "audit-migration-test-"));
    owner.scratch = scratch;
    const repo = resolve(scratch, "repo");
    const runner = resolve(scratch, "runner");
    const bin = resolve(scratch, "bin");
    for (const directory of [repo, runner, bin]) mkdirSync(directory);
    const put = (path, contents) => {
      mkdirSync(dirname(resolve(repo, path)), { recursive: true });
      writeFileSync(resolve(repo, path), contents);
    };
    const git = (args) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const old = makeOracle(
      entrypoint
        ? JSON.parse(readFileSync(new URL(`../${oraclePath}`, import.meta.url))).environment
        : undefined,
    );
    const sourcePins = {
      oils: { revision: "fixture" },
      brush: { revision: "fixture" },
      bashkitTerminal: { revision: "fixture" },
    };
    put(oraclePath, JSON.stringify(old));
    put(baselinePath, JSON.stringify(score(old, wrongBaseline ? ["fail", "pass"] : undefined)));
    put(
      "sources.lock.json",
      JSON.stringify({
        ...sourcePins,
        shellScoreboard: {
          oracleSha256: badChecksum ? "wrong" : bytesDigest(Buffer.from(JSON.stringify(old))),
        },
      }),
    );
    put(
      "shell/source.json",
      JSON.stringify({ stdout: "YQ==", hang, descendant, buildFail, scoreFail }),
    );
    put("scripts/bash-compat.mjs", scorerFixture);
    git(["init", "-q"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const ref = git(["rev-parse", "HEAD"]);
    const candidate = structuredClone(old);
    candidate.oracle.capture = "corrected";
    candidate.cases[0].bash.stdout = "eg==";
    candidate.cases[1].bash.stdout = "YQ==";
    const next = sealOracle(candidate);
    const update = (oracle) => {
      put(oraclePath, JSON.stringify(oracle));
      put(
        "sources.lock.json",
        JSON.stringify({
          ...sourcePins,
          shellScoreboard: { oracleSha256: bytesDigest(Buffer.from(JSON.stringify(oracle))) },
        }),
      );
    };
    update(next);
    put(baselinePath, JSON.stringify(score(next, ["fail", "fail"])));
    // Neither uncommitted sources, a prebuilt artifact, nor candidate scorer may supply base evidence.
    put("shell/source.json", '{"stdout":"eg=="}');
    put(".build/shell/wasm32-wasip1/release/shell-engine.wasm", '{"stdout":"eg=="}');
    put(
      "scripts/bash-compat.mjs",
      'throw Error("candidate scorer must not collect target evidence");',
    );
    writeFileSync(resolve(bin, "cargo"), cargoFixture);
    chmodSync(resolve(bin, "cargo"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.RUNNER_TEMP = runner;
    process.env.CARGO_TARGET_DIR = resolve(repo, ".build/shell");
    process.env.RUSTC_WRAPPER = "candidate-wrapper-must-not-run";
    process.env.RUSTFLAGS = "candidate-flags-must-not-apply";
    process.env.BASH_COMPAT_BASE_REF = ref;
    process.env.BASH_COMPAT_RECORD = "0";
    for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_ORACLE", "BASH_COMPAT_BASELINE"])
      delete process.env[name];
    await run({ repo, ref, next, old, runner, put, update });
    assert.deepEqual(readdirSync(runner), [], "migration scratch leaked");
    assert.equal(process.env.BASH_COMPAT_BASE_REF, ref);
    assert.equal(process.env.BASH_COMPAT_RECORD, "0");
  } finally {
    try {
      await owner.close();
      if (owner.scratch) assert.equal(existsSync(owner.scratch), false);
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  }
}

test("migration rebuilds immutable target and lowered candidate baseline cannot conceal regression", async () => {
  await fixture(async ({ repo, ref, next }) => {
    const target = await targetBranchBaseline(repo, ref, next);
    assert.deepEqual(
      target.cases.map((item) => item.outcome),
      ["fail", "pass"],
    );
    validateScore(next, target);
    const lowered = score(next, ["fail", "fail"]);
    compareScores(lowered, lowered, { requireMembership: true });
    assert.equal(compareScores(target, lowered).ok, false);
  });
});

test("migration launcher excludes inherited Node startup hooks", async () => {
  await fixture(async ({ repo, ref, next, put }) => {
    const marker = resolve(repo, "preload-ran");
    const preload = resolve(repo, "preload.cjs");
    put("preload.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
    const args = process.execArgv.slice();
    try {
      process.env.NODE_OPTIONS = `--require=${preload}`;
      process.execArgv.push("--require", preload);
      const target = await targetBranchBaseline(repo, ref, next);
      assert.deepEqual(
        target.cases.map((item) => item.outcome),
        ["fail", "pass"],
      );
      assert.equal(existsSync(marker), false, "launcher ran an inherited startup hook");
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...args);
    }
  });
});

test("migration rejects incorrect immutable baseline membership", async () => {
  await fixture(
    async ({ repo, ref, next }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /stale candidate baseline/);
    },
    { wrongBaseline: true },
  );
});

test("failed build and corrected scoring both clean their private resources", async () => {
  for (const options of [{ buildFail: true }, { scoreFail: true }]) {
    await fixture(async ({ repo, ref, next }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /failed/);
    }, options);
  }
});

test("migration verifies the immutable oracle checksum", async () => {
  await fixture(
    async ({ repo, ref, next }) => {
      await assert.rejects(targetBranchBaseline(repo, ref, next), /target oracle checksum/);
    },
    { badChecksum: true },
  );
});

test("migration rejects case, environment, source and schema changes", async () => {
  await fixture(async ({ repo, ref, next }) => {
    for (const mutate of [
      (o) => {
        o.cases[0].code = "printf b";
      },
      (o) => {
        o.cases[0].category = "new";
      },
      (o) => {
        o.cases[0].excluded = "skip";
      },
      (o) => {
        o.cases.reverse();
      },
      (o) => {
        o.environment.stdin = "changed";
      },
      (o) => {
        o.sources.oils.revision = "changed";
      },
      (o) => {
        o.schema = 2;
      },
    ]) {
      const changed = structuredClone(next);
      mutate(changed);
      await assert.rejects(
        targetBranchBaseline(repo, ref, sealOracle(changed)),
        /unchanged|schema/,
      );
    }
  });
});

test("migration rejects invalid base refs and supplied artifacts or baseline paths", async () => {
  await fixture(async ({ repo, ref, next }) => {
    for (const invalid of ["HEAD", ref.slice(0, 12), "a".repeat(40), `${ref}:shell`, "--help"])
      await assert.rejects(targetBranchBaseline(repo, invalid, next));
    await assert.rejects(
      targetBranchBaseline(repo, ref, next, { wasm: "supplied.wasm" }),
      /no supplied artifacts/,
    );
    for (const name of ["BASH_COMPAT_SHELL_WASM", "BASH_COMPAT_ORACLE", "BASH_COMPAT_BASELINE"]) {
      process.env[name] = "supplied";
      await assert.rejects(targetBranchBaseline(repo, ref, next), /rejects supplied/);
      delete process.env[name];
    }
  });
});

test("unchanged oracle preserves original target ratchet without rebuilding", async () => {
  await fixture(async ({ repo, ref, old, update }) => {
    update(old);
    const baseline = await targetBranchBaseline(repo, ref, old);
    assert.deepEqual(baseline, score(old));
  });
});

async function until(condition) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for fixture");
    await delay(20);
  }
}

function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { active: !["Z", "X"].includes(fields[0]), start: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return { active: false };
    throw error;
  }
}
for (const descendant of [false, true]) {
  for (const cancellation of ["TERM", "parent disconnect"]) {
    test(`${cancellation} stops ${descendant ? "descendant after leader exit" : "child"} before removing scratch`, async () => {
      await fixture(
        async ({ repo, ref, runner }) => {
          const launcher = fileURLToPath(
            new URL("./shell-scoreboard-migration.mjs", import.meta.url),
          );
          const child =
            cancellation === "TERM"
              ? spawn(process.execPath, [launcher, repo, ref], { stdio: "ignore" })
              : fork(launcher, [repo, ref], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
          const exited = new Promise((accept) => child.once("exit", accept));
          let pid;
          let start;
          try {
            await until(() => {
              const scratch = readdirSync(runner)[0];
              const marker = scratch && resolve(runner, scratch, "started");
              if (!marker || !existsSync(marker)) return false;
              pid = Number(readFileSync(marker, "utf8"));
              start = processState(pid).start;
              return start !== undefined;
            });
            if (cancellation === "TERM") child.kill("SIGTERM");
            else child.disconnect();
            await exited;
            assert.equal(
              processState(pid).active,
              false,
              "live consumer survived launcher cleanup",
            );
            assert.deepEqual(readdirSync(runner), []);
          } finally {
            child.kill("SIGTERM");
            await exited;
            // Emergency fixture teardown also owns the grandchild if an assertion exposes a bug.
            if (pid && processState(pid).start === start && processState(pid).active) {
              process.kill(pid, "SIGKILL");
              await until(() => !processState(pid).active);
            }
          }
        },
        { hang: true, descendant },
      );
    });
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} on the compatibility entrypoint awaits its active migration`, async () => {
    await fixture(
      async ({ repo, runner, put }) => {
        // Only the compiler and archived target scorer are stand-ins. The candidate entrypoint,
        // trusted baseline launcher, migration supervisor and group draining are shipped code.
        for (const name of [
          "bash-compat.mjs",
          "bash-compat-helpers.mjs",
          "bash-compat-runner.mjs",
          "shell-scoreboard.mjs",
          "shell-scoreboard-base.mjs",
          "shell-scoreboard-migration.mjs",
          "shell-process-group.mjs",
        ])
          put(`scripts/${name}`, readFileSync(new URL(name, import.meta.url)));
        const child = spawn(process.execPath, [resolve(repo, "scripts/bash-compat.mjs")], {
          env: {
            ...process.env,
            BASH_COMPAT_MODE: "frozen",
            BASH_COMPAT_SCRATCH: runner,
            BASH_COMPAT_TIMEOUT_MS: "10000",
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        const errors = [];
        child.stderr.on("data", (chunk) => errors.push(chunk));
        const exited = new Promise((accept) => child.once("close", (code) => accept(code)));
        // This independent watchdog also releases the launcher's IPC parent-death cleanup
        // if the old, uncancellable entrypoint is used as a negative control.
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000).unref();
        let pid;
        let start;
        try {
          let directory;
          await until(() => {
            directory = readdirSync(runner).find((name) =>
              name.startsWith("audit-oracle-migration-"),
            );
            const marker = directory && resolve(runner, directory, "started");
            if (!marker || !existsSync(marker)) return false;
            pid = Number(readFileSync(marker, "utf8"));
            start = processState(pid).start;
            return start !== undefined;
          });
          child.kill(signal);
          await delay(50);
          assert.equal(child.exitCode, null, "entrypoint exited before its compiler stopped");
          assert.equal(existsSync(resolve(runner, directory)), true);
          const status = await exited;
          assert.equal(status, signal === "SIGTERM" ? 143 : 130, Buffer.concat(errors).toString());
          assert.equal(
            processState(pid).active,
            false,
            "compiler outlived entrypoint cancellation",
          );
          assert.deepEqual(readdirSync(runner), []);
        } finally {
          child.kill("SIGTERM");
          await exited;
          clearTimeout(watchdog);
          if (pid && processState(pid).start === start && processState(pid).active) {
            process.kill(pid, "SIGKILL");
            await until(() => !processState(pid).active);
          }
          // Even a watchdog failure must await the orphan launcher's IPC-disconnect cleanup
          // before the outer fixture removes its files. The entrypoint's own scratch is ours.
          await until(
            () => !readdirSync(runner).some((name) => name.startsWith("audit-oracle-migration-")),
          );
        }
      },
      { hang: true, entrypoint: true },
    );
  });
}
