import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { sealOracle } from "./shell-scoreboard.mjs";

const root = process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
await mkdir(root, { recursive: true });

test("read-only transport audit preserves input and reports incomplete controls", async (t) => {
  const scratch = await mkdtemp(resolve(root, "audit-test-"));
  const children = new Set();
  const exitCleanup = () => {
    for (const child of children) child.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
  };
  const onInt = () => process.exit(130);
  const onTerm = () => process.exit(143);
  process.once("exit", exitCleanup);
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  t.after(async () => {
    for (const child of children) child.kill("SIGTERM");
    await rm(scratch, { recursive: true, force: true });
    process.off("exit", exitCleanup);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  });
  const input = resolve(scratch, "oracle.json");
  const output = resolve(scratch, "report.json");
  const run = (destination = output) =>
    new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "audit-bash-oracle-pipe.mjs")],
        {
          env: {
            ...process.env,
            BASH_COMPAT_ORACLE: input,
            BASH_ORACLE_AUDIT_OUT: destination,
            BASH_COMPAT_SCRATCH: scratch,
            BASH_COMPAT_JOBS: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", fail);
      child.once("close", (status) => {
        children.delete(child);
        done({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
  const fixture = (code) =>
    sealOracle({
      schema: 1,
      oracle: { version: "original test fixture", executableSha256: "different", sandbox: "test" },
      environment: { timeoutMs: 500 },
      sources: { generated: { revision: "unchanged" } },
      cases: [
        {
          id: "generated:streams:1",
          corpus: "generated",
          file: "streams",
          line: 1,
          name: "original fixture",
          category: "streams",
          kind: "builtins-only",
          code,
          bash: { status: 1, stdout: "", stderr: "" },
        },
      ],
    });

  await t.test("direct, symlink, and hardlink output aliases fail before capture", async () => {
    const bytes = JSON.stringify(fixture("exit 0"));
    await writeFile(input, bytes);
    const symlinkPath = resolve(scratch, "symlink.json");
    const hardlinkPath = resolve(scratch, "hardlink.json");
    await symlink(input, symlinkPath);
    await link(input, hardlinkPath);
    for (const destination of [input, symlinkPath, hardlinkPath]) {
      const result = await run(destination);
      assert.equal(result.status, 1);
      assert.match(result.stderr.toString(), /must not alias/);
      assert.equal(await readFile(input, "utf8"), bytes);
    }
    await rm(symlinkPath);
    await rm(hardlinkPath);
  });

  await t.test(
    "both-stream correction retains exact separate bytes and frozen identity",
    async () => {
      const oracle = fixture("printf err >/dev/stderr && printf ok");
      const bytes = JSON.stringify(oracle);
      await writeFile(input, bytes);
      const result = await run();
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(await readFile(input, "utf8"), bytes);
      const report = JSON.parse(await readFile(output, "utf8"));
      assert.deepEqual(report.originalIdentity, oracle.identity);
      assert.equal(report.membershipIdentity, oracle.identity.caseSet);
      assert.equal(report.sourceIdentity, oracle.identity.sources);
      assert.deepEqual(report.changed, [oracle.cases[0].id]);
      assert.deepEqual(report.transportChanged, [oracle.cases[0].id]);
      assert.deepEqual(report.incomplete, []);
      assert.deepEqual(report.cases[0].pipe, {
        status: 0,
        stdout: Buffer.from("ok").toString("base64"),
        stderr: Buffer.from("err").toString("base64"),
      });
      assert.equal(report.cases[0].socketMatchesFrozen, true);
      assert.equal(report.cases[0].deterministic, true);
    },
  );

  await t.test("a socket-only timeout makes the complete audit fail", async () => {
    await writeFile(
      input,
      JSON.stringify(fixture("if [[ ! -p /dev/stdout ]]; then while :; do :; done; fi; printf ok")),
    );
    const result = await run();
    assert.equal(result.status, 1, result.stderr.toString());
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(report.incomplete, ["generated:streams:1"]);
    assert.equal(report.cases[0].socket.timeout, true);
    assert.equal(report.cases[0].pipe.timeout, undefined);
    assert.deepEqual(await readdir(scratch), ["oracle.json", "report.json"]);
  });
});
