import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { baseBranchBaseline } from "./shell-scoreboard-base.mjs";
import { compareScores } from "./shell-scoreboard.mjs";

test("lowering the candidate baseline cannot bypass the target branch", () => {
  const scratchRoot = process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchRoot, "audit-baseline-test-"));
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: scratch,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "-q"]);
    mkdirSync(resolve(scratch, "docs/evidence"), { recursive: true });
    const base = {
      identity: { caseSet: "same", oracle: "same", environment: "same" },
      cases: [{ id: "oils:1", corpus: "oils", category: "example", outcome: "pass" }],
    };
    writeFileSync(resolve(scratch, "sources.lock.json"), '{"shellScoreboard":{}}');
    writeFileSync(resolve(scratch, "docs/evidence/own-shell-baseline.json"), JSON.stringify(base));
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
    const ref = git(["rev-parse", "HEAD"]).trim();
    const lowered = structuredClone(base);
    lowered.cases[0].outcome = "fail";
    writeFileSync(
      resolve(scratch, "docs/evidence/own-shell-baseline.json"),
      JSON.stringify(lowered),
    );
    assert.equal(compareScores(lowered, lowered).ok, true);
    assert.equal(compareScores(baseBranchBaseline(scratch, ref), lowered).ok, false);
    lowered.identity.environment = "changed";
    assert.throws(() => compareScores(baseBranchBaseline(scratch, ref), lowered), /incomparable/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(execFileSync("test", ["!", "-e", scratch]).length, 0);
  }
});
