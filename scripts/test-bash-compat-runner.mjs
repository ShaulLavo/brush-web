import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createShellRunner } from "./bash-compat-runner.mjs";

const root = process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
await mkdir(root, { recursive: true });

test("Bash capture uses real stdout pipe without changing shell input or status", async (t) => {
  const scratch = await mkdtemp(resolve(root, "audit-runner-test-"));
  const activeChildren = new Map();
  const workers = new Set();
  const helpers = resolve(scratch, "helpers");
  const path = `${helpers}:/usr/local/bin:/usr/bin:/bin`;
  const exitCleanup = () => {
    for (const worker of workers) worker.kill("SIGTERM");
    for (const kill of activeChildren.keys()) kill();
    rmSync(scratch, { recursive: true, force: true });
  };
  const onInt = () => process.exit(130);
  const onTerm = () => process.exit(143);
  process.once("exit", exitCleanup);
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  // Teardown is installed before the first subprocess. Only this test's scratch is removed.
  t.after(async () => {
    const closing = Array.from(workers, (worker) => once(worker, "close"));
    for (const worker of workers) worker.kill("SIGTERM");
    await Promise.allSettled(closing);
    for (const kill of activeChildren.keys()) kill();
    await Promise.allSettled(activeChildren.values());
    await rm(scratch, { recursive: true, force: true });
    process.off("exit", exitCleanup);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  });
  await mkdir(helpers);
  const run = createShellRunner({ scratch, timeoutMs: 5000, activeChildren });
  const capture = (code) => run("/usr/bin/bash", code, path, true);

  await t.test("reopening /dev/stdout and /dev/fd/1 succeeds", async () => {
    const code = "printf first >/dev/stdout; printf second >/dev/fd/1; exit 37";
    const pipe = await capture(code);
    assert.equal(pipe.stdout.toString(), "firstsecond");
    assert.equal(pipe.stderr.length, 0);
    assert.equal(pipe.status, 37);
    const socket = await run("/usr/bin/bash", code, path, true, "socket");
    assert.equal(socket.stdout.length, 0);
    assert.match(socket.stderr.toString(), /No such device or address/);
    assert.equal(socket.status, 37);
  });

  await t.test("reopening /dev/stderr and /dev/fd/2 succeeds independently", async () => {
    const code = "printf first >/dev/stderr && printf second >/dev/fd/2 && printf ok";
    const result = await capture(code);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), "ok");
    assert.equal(result.stderr.toString(), "firstsecond");
    const socket = await run("/usr/bin/bash", code, path, true, "socket");
    assert.equal(socket.status, 1);
    assert.equal(socket.stdout.length, 0);
    assert.match(socket.stderr.toString(), /No such device or address/);
  });

  await t.test("background descendants do not keep completed captures alive", async () => {
    const result = await run(
      "/usr/bin/bash",
      "sleep 30 & printf done; printf err >&2; exit 37",
      path,
    );
    assert.equal(result.status, 37);
    assert.equal(result.timeout, false);
    assert.equal(result.stdout.toString(), "done");
    assert.equal(result.stderr.toString(), "err");
  });

  await t.test("both busy streams drain without merging or deadlocking", async () => {
    const result = await capture(
      "for ((i=0;i<64;i++)); do printf '%8192s' o; printf '%8192s' e >&2; done",
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), (" ".repeat(8191) + "o").repeat(64));
    assert.equal(result.stderr.toString(), (" ".repeat(8191) + "e").repeat(64));
  });

  await t.test("bytes and stderr remain independent", async () => {
    const result = await capture("printf '\\000\\377out'; printf '\\000\\376err' >&2; exit 19");
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 111, 117, 116]));
    assert.deepEqual(result.stderr, Buffer.from([0, 254, 101, 114, 114]));
    assert.equal(result.status, 19);
  });

  await t.test("exit, exec, syntax errors and signals retain actual Bash status", async () => {
    for (const [code, status] of [
      ["exit 42", 42],
      ["exec /usr/bin/bash -c 'exit 73'", 73],
      ["if", 2],
      ["kill -TERM $$", 143],
      ["false | true; exit 29", 29],
    ]) {
      const result = await capture(code);
      assert.equal(result.status, status, code);
      assert.equal(result.timeout, false);
      assert.equal(result.outputLimit, false);
    }
  });

  await t.test("no script wrapper changes $0, line numbers or original source", async () => {
    const code = 'printf "%s\\n" "$0" "$LINENO"\nprintf "%s" "$BASH_EXECUTION_STRING"';
    const result = await capture(code);
    assert.equal(result.stdout.toString(), `/usr/bin/bash\n1\n${code}`);
    assert.equal(result.status, 0);
  });

  await t.test("normalized environment, empty stdin, private files and status fd", async () => {
    const result = await capture(
      'printf "%s\\n" "$PWD" "$HOME" "$TMP" "$SH" "$LC_ALL"; ' +
        'read -r line; printf "read:%s\\n" "$?"; ' +
        "[[ ! -e /home/shaul && ! -e /work/projects && ! -e /tmp/owner-data ]]; " +
        'printf "private:%s\\n" "$?"; printf forbidden >&3',
    );
    assert.equal(result.stdout.toString(), "$TMP\n$HOME\n$TMP\nbash\nC.UTF-8\nread:1\nprivate:0\n");
    assert.match(result.stderr.toString(), /3: Bad file descriptor/);
    assert.equal(result.status, 1);
  });

  await t.test("timeout terminates the sandbox and its descendants", async () => {
    const timed = createShellRunner({ scratch, timeoutMs: 150, activeChildren });
    const started = Date.now();
    const result = await timed("/usr/bin/bash", "sleep 30 & wait", path, true);
    assert.equal(result.timeout, true);
    assert.equal(result.outputLimit, false);
    assert.ok(Date.now() - started < 5000);
    assert.equal(activeChildren.size, 0);
  });

  await t.test("output limit kills a still-running producer", async () => {
    const result = await capture("while :; do printf '%65536s' x; done");
    assert.equal(result.outputLimit, true);
    assert.equal(result.timeout, false);
    assert.ok(result.stdout.length <= 4 * 1024 * 1024);
    assert.equal(activeChildren.size, 0);
  });

  await t.test("launcher failure cannot masquerade as shell success", async () => {
    await assert.rejects(run("/missing/bash", "exit 0", path), /Bash pipe launcher failed/);
    assert.equal(activeChildren.size, 0);
  });

  for (const ownerSignal of ["SIGTERM", "SIGKILL"]) {
    await t.test(
      `owner ${ownerSignal} tears down active supervisors and guests`,
      { timeout: 5000 },
      async (subtest) => {
        const workerScratch = resolve(scratch, `interrupted-${ownerSignal}`);
        const worker = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      import { execFileSync } from 'node:child_process';
      import { mkdir, readFile, readdir, readlink } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      import { createShellRunner } from ${JSON.stringify(new URL("./bash-compat-runner.mjs", import.meta.url).href)};
      const scratch = ${JSON.stringify(workerScratch)};
      const activeChildren = new Map();
      process.on('SIGTERM', () => process.exit(143));
      process.on('exit', () => {
        for (const kill of activeChildren.keys()) kill();
        execFileSync('rm', ['-rf', '--', scratch]);
      });
      await mkdir(scratch + '/helpers', { recursive: true });
      const run = createShellRunner({ scratch, timeoutMs: 30000, activeChildren });
      const pending = run('/usr/bin/bash', 'sleep 30 & printf "%s %s" "$$" "$!" > "$TMP/live"; wait', '/usr/bin:/bin', true);
      let identities;
      while (!identities) {
        for (const name of await readdir(scratch)) {
          if (!name.startsWith('bash-')) continue;
          const cwd = scratch + '/' + name + '/tmp';
          const marker = await readFile(cwd + '/live', 'utf8').catch(() => '');
          if (!marker) continue;
          const wanted = new Set(marker.split(' '));
          const found = [];
          for (const pid of await readdir('/proc')) {
            if (!/^\\d+$/.test(pid)) continue;
            if (await readlink('/proc/' + pid + '/cwd').catch(() => '') !== cwd) continue;
            const status = await readFile('/proc/' + pid + '/status', 'utf8').catch(() => '');
            const nspid = status.match(/^NSpid:\\s+(.*)$/m)?.[1].trim().split(/\\s+/).at(-1);
            if (!wanted.has(nspid)) continue;
            const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
            found.push({ pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] });
          }
          if (found.length === 2) identities = found;
        }
        if (!identities) await delay(5);
      }
      process.stdout.write(JSON.stringify(identities) + '\\n');
      await pending;
    `,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        workers.add(worker);
        worker.once("close", () => workers.delete(worker));
        subtest.after(() => worker.kill("SIGTERM"));
        const closed = once(worker, "close");
        const [ready] = await once(worker.stdout, "data");
        const identities = JSON.parse(ready.toString());
        assert.equal(identities.length, 2, "guest must report a live shell and background child");
        worker.kill(ownerSignal);
        const [status, signal] = await closed;
        if (ownerSignal === "SIGTERM") {
          assert.equal(status, 143);
          await assert.rejects(readdir(workerScratch), { code: "ENOENT" });
        } else {
          assert.equal(status, null);
          assert.equal(signal, "SIGKILL");
        }
        for (const identity of identities) {
          const deadline = Date.now() + 2000;
          while (true) {
            const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8").catch(() => "");
            const start = stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] : null;
            if (start !== identity.start) break;
            assert.ok(
              Date.now() < deadline,
              `guest process ${identity.pid} survived owner ${ownerSignal}`,
            );
            await delay(5);
          }
        }
        // SIGKILL cannot run the worker's handlers; the surviving test owns its files.
        await rm(workerScratch, { recursive: true, force: true });
      },
    );
  }

  assert.deepEqual(await readdir(scratch), ["helpers"]);
  const leaked = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const command = await readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0));
    if (command.includes(Buffer.from(scratch))) leaked.push({ pid, command: command.toString() });
  }
  assert.deepEqual(leaked, [], "task-created supervisors or sandboxes survived teardown");
});

test("capture teardown retains scratch and ownership until its process group stops", async (t) => {
  const scratch = await mkdtemp(resolve(root, "audit-runner-barrier-"));
  const activeChildren = new Map();
  const signal = process.kill;
  const groups = new Set();
  let pending;
  // Model delayed signal delivery without leaving a real consumer unowned. The
  // test releases only its recorded groups, and always restores the global hook.
  const release = () => {
    process.kill = signal;
    for (const pid of groups) {
      try {
        signal(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  t.after(async () => {
    release();
    for (const kill of activeChildren.keys()) kill();
    await pending?.catch(() => {});
    await Promise.allSettled(activeChildren.values());
    await rm(scratch, { recursive: true, force: true });
  });
  process.kill = (pid, kind) => {
    if (pid < 0 && kind === "SIGKILL") {
      groups.add(pid);
      return true;
    }
    return signal(pid, kind);
  };
  const run = createShellRunner({ scratch, timeoutMs: 5000, activeChildren });
  pending = run(
    "/usr/bin/bash",
    'sleep 30 >/dev/null 2>&1 & printf "%s" "$!" > "$TMP/live"; printf done',
    "/usr/bin:/bin",
    false,
    "socket",
  );
  let directory;
  const deadline = Date.now() + 5000;
  while (!groups.size) {
    assert.ok(Date.now() < deadline, "capture did not reach owned-group teardown");
    directory = (await readdir(scratch)).find((name) => name.startsWith("bash-"));
    await delay(5);
  }
  await delay(50);
  assert.equal(activeChildren.size, 1, "capture dropped ownership before its consumer stopped");
  assert.ok(directory, "capture scratch was not created");
  assert.match(await readFile(resolve(scratch, directory, "tmp/live"), "utf8"), /^\d+$/);
  release();
  assert.equal((await pending).stdout.toString(), "done");
  assert.equal(activeChildren.size, 0);
  assert.deepEqual(await readdir(scratch), []);
});
