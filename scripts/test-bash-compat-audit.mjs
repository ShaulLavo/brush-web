import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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

  await t.test(
    "SIGTERM awaits consumer termination before removing audit scratch",
    async (subtest) => {
      const oracle = fixture('sleep 30 & printf ready > "$TMP/live"; wait');
      oracle.environment.timeoutMs = 30000;
      await writeFile(input, JSON.stringify(sealOracle(oracle)));
      await rm(output);
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          const signal = process.kill;
          const groups = new Set();
          let released = false;
          process.kill = (pid, kind) => {
            if (!released && pid < 0 && kind === 'SIGKILL') {
              groups.add(pid);
              process.send('deferred');
              return true;
            }
            return signal(pid, kind);
          };
          const release = () => {
            released = true;
            for (const pid of groups) {
              try { signal(pid, 'SIGKILL'); }
              catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
          };
          process.on('message', release);
          try {
            await import(${JSON.stringify(new URL("./audit-bash-oracle-pipe.mjs", import.meta.url).href)});
          } finally {
            release();
            process.disconnect();
          }
        `,
        ],
        {
          env: {
            ...process.env,
            BASH_COMPAT_ORACLE: input,
            BASH_ORACLE_AUDIT_OUT: output,
            BASH_COMPAT_SCRATCH: scratch,
            BASH_COMPAT_JOBS: "1",
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.add(child);
      const closed = once(child, "close");
      const stderr = [];
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("close", () => children.delete(child));
      subtest.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      });
      let marker;
      const deadline = Date.now() + 5000;
      while (!marker) {
        assert.ok(Date.now() < deadline, "audit guest did not become ready");
        for (const audit of await readdir(scratch)) {
          if (!audit.startsWith("audit-")) continue;
          const directory = resolve(scratch, audit);
          for (const name of await readdir(directory).catch(() => [])) {
            if (!name.startsWith("bash-")) continue;
            const path = resolve(directory, name, "tmp/live");
            if ((await readFile(path, "utf8").catch(() => "")) === "ready") marker = path;
          }
        }
        if (!marker) await delay(5);
      }
      // Delay owned-group signal delivery so deleting scratch first is observable,
      // rather than relying on a race between SIGKILL scheduling and filesystem IO.
      const deferred = once(child, "message");
      child.kill("SIGTERM");
      await deferred;
      await delay(50);
      assert.equal(child.exitCode, null, "audit exited instead of awaiting its consumer");
      assert.equal(await readFile(marker, "utf8"), "ready");
      child.send("release");
      assert.equal((await closed)[0], 143, Buffer.concat(stderr).toString());
      assert.deepEqual(await readdir(scratch), ["oracle.json"]);
    },
  );
});
