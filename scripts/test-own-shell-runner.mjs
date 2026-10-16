import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

// Original tiny WASI fixture: emit raw ff00 on stdout, "err" on stderr, exit 7.
// No shell semantics or host accounts are involved.
function fixture(outputSize = 2) {
  const leb = (number) => {
    const bytes = [];
    do {
      const byte = number & 127;
      number >>>= 7;
      bytes.push(byte | (number ? 128 : 0));
    } while (number);
    return bytes;
  };
  const string = (value) => leb(value.length).concat(Array.from(Buffer.from(value)));
  const section = (id, bytes) => [id].concat(leb(bytes.length), bytes);
  const imports = [2].concat(
    string("wasi_snapshot_preview1"),
    string("fd_write"),
    [0, 0],
    string("wasi_snapshot_preview1"),
    string("proc_exit"),
    [0, 1],
  );
  const body = [
    0, 0x41, 1, 0x41, 0, 0x41, 1, 0x41, 16, 0x10, 0, 0x1a, 0x41, 2, 0x41, 8, 0x41, 1, 0x41, 16,
    0x10, 0, 0x1a, 0x41, 7, 0x10, 1, 0x0b,
  ];
  const data = Buffer.alloc(37);
  data.writeUInt32LE(32, 0);
  data.writeUInt32LE(outputSize, 4);
  data.writeUInt32LE(34, 8);
  data.writeUInt32LE(3, 12);
  data.set([255, 0, 101, 114, 114], 32);
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      section(2, imports),
      section(3, [1, 2]),
      section(5, [1, 0, 1]),
      section(7, [2].concat(string("memory"), [2, 0], string("_start"), [0, 2])),
      section(10, [1].concat(leb(body.length), body)),
      section(11, [1, 0, 0x41, 0, 0x0b].concat(leb(data.length), Array.from(data))),
    ),
  );
}
async function runFixture(outputSize) {
  const scratch = await mkdtemp(
    resolve(
      process.env.BASH_COMPAT_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp",
      "brush-web-runner-test-",
    ),
  );
  let worker;
  try {
    const modulePath = resolve(scratch, "fixture.wasm");
    await writeFile(modulePath, fixture(outputSize));
    worker = new Worker(new URL("./bash-compat-worker.mjs", import.meta.url), {
      workerData: {
        engine: "own-shell",
        modulePath,
        scratch,
        home: "/home/user",
        tmp: "/tmp/spec",
        env: {},
      },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("fixture worker timed out")), 5000);
      worker.on("message", (message) => {
        if (message.ready) return worker.postMessage({ id: 1, code: "fixture" });
        clearTimeout(timer);
        done(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
  } finally {
    await worker?.terminate();
    await rm(scratch, { recursive: true, force: true });
    await assert.rejects(access(scratch), { code: "ENOENT" });
  }
}
test("own-shell worker preserves raw stdout, separate stderr and status", async () => {
  const result = await runFixture(2);
  assert.equal(result.status, 7);
  assert.deepEqual(Buffer.from(result.stdout), Buffer.from([255, 0]));
  assert.equal(Buffer.from(result.stderr).toString(), "err");
  assert.equal(result.crash, undefined);
});
test("own-shell worker enforces the combined output ceiling before writing", async () => {
  const result = await runFixture(4 * 1024 * 1024 + 1);
  assert.match(result.crash, /output limit exceeded/);
  assert.equal(result.stdout.length, 0);
});
