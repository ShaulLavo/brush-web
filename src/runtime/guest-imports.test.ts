// Original regression tests: run the shipped Bun guest against runtime descriptors, not mock WASM.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Wasi } from "@bun-wasm/runtime/core";
import { MAX_DESCRIPTOR } from "../../third-party/bun-wasm/runtime/core/descriptors";
import { MemFS } from "../../third-party/bun-wasm/runtime/fs/memory";
import { SharedBridge, control } from "../bridge";
import { HOST_CALL_FD, installHostSlotsViaImport } from "./net/trampoline";
import {
  preservePreopenDiscovery,
  preserveRootPreopen,
  shellTerminalImports,
} from "./guest-imports";

const guest = WebAssembly.compile(await readFile(resolve("public/programs/bun.wasm")));

async function runBun(source: string, inherited: readonly number[]) {
  const fs = new MemFS();
  fs.mkdirp("/home/guest");
  fs.writeFile("/home/guest/preopen-data", "ROOT_PREOPEN_OK");
  fs.writeFile("/home/guest/descriptor-data", "shared-offset");
  const output: string[] = [];
  const errors: string[] = [];
  const trace: string[] = [];
  const wasi = new Wasi({
    hostCallFd: HOST_CALL_FD,
    args: ["bun", "-e", source],
    env: { PWD: "/home/guest" },
    fs,
    preopens: { "/": "/" },
    stdout: (bytes) => output.push(new TextDecoder().decode(bytes)),
    stderr: (bytes) => errors.push(new TextDecoder().decode(bytes)),
    sleep() {},
    trace: (line) => trace.push(line),
  });
  const preopen = preserveRootPreopen(wasi.descriptors, inherited);
  for (const fd of inherited) {
    if (fd !== 4) {
      wasi.descriptors.inherit(fd, wasi.descriptors.get(1)!);
      continue;
    }
    const path = fs.resolve(fs.preopen("/"), "home/guest/descriptor-data");
    assert.equal(typeof path, "object");
    if (typeof path === "number" || path.node === undefined) throw new Error("missing fixture");
    const handle = path.node;
    fs.retain(handle);
    const opened = wasi.descriptors.open(
      { kind: "file", handle, offset: 0, append: false },
      (1n << 29n) - 1n,
      (1n << 29n) - 1n,
      () => fs.release(handle),
    );
    wasi.descriptors.inherit(fd, wasi.descriptors.get(opened)!);
    if (opened !== fd) wasi.descriptors.close(opened);
  }
  const module = await guest;
  const imports = wasi.imports(module);
  preservePreopenDiscovery(imports, wasi.descriptors, preopen);
  const instance = new WebAssembly.Instance(module, imports);
  wasi.hostCall = installHostSlotsViaImport(instance, { poll: () => 0 });
  try {
    return {
      status: wasi.start(instance),
      output: output.join(""),
      errors: errors.join(""),
      trace,
    };
  } finally {
    wasi.descriptors.dispose();
  }
}

test("actual Bun reads its root preopen without inherited fd3", async () => {
  const result = await runBun('console.log(await Bun.file("preopen-data").text())', []);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.errors, "", JSON.stringify(result));
  assert.equal(result.output, "ROOT_PREOPEN_OK\n", JSON.stringify(result));
});

// The shipped guest links wasi-libc's contiguous preopen scan, which silently _Exit(71)s
// on any fd_prestat_get error other than BADF. NOTSUP for an occupied non-preopen is
// truthful, but that libc cannot discover the relocated root. Do not invent a successful
// prestat with an invalid tag to bypass its startup. Fix the guest's discovery first.
// https://github.com/WebAssembly/wasi-libc/blob/2e6fb9d8ee0c/libc-bottom-half/sources/preopens.c#L323-L395
for (const inherited of [[3], [3, 4], [3, 5], [3, 1000000]]) {
  test(`shipped Bun libc limitation: inherited ${inherited.join(",")} exits 71 before JavaScript`, async () => {
    const result = await runBun('console.log(await Bun.file("preopen-data").text())', inherited);
    assert.equal(result.status, 71, JSON.stringify(result));
    assert.equal(result.errors, "", JSON.stringify(result));
    assert.equal(result.output, "", JSON.stringify(result));
  });
}

test("shipped Bun libc limitation precedes inherited fd4 read and fd3 write", async () => {
  const result = await runBun(
    'const f=require("node:fs");const b=Buffer.alloc(6);f.readSync(4,b,0,6,null);f.writeSync(3,"FD3:"+b.toString()+"\\n")',
    [3, 4],
  );
  assert.equal(result.status, 71, JSON.stringify(result));
  assert.equal(result.output, "", JSON.stringify(result));
  assert.equal(result.errors, "", JSON.stringify(result));
});

test.todo("actual Bun discovers its relocated root with inherited fd3 and exits 0");
test.todo("actual Bun shares inherited fd4 offsets and writes fd3 after preopen discovery");

test("shell terminal columns follow the live bridge and default to 80 for a child", () => {
  const bridge = new SharedBridge();
  const root = shellTerminalImports(bridge.buffer);
  Atomics.store(bridge.state, control.cols, 103);
  assert.equal(root.columns(), 103);
  Atomics.store(bridge.state, control.cols, 0);
  assert.equal(root.columns(), 2);
  assert.equal(shellTerminalImports().columns(), 80);
});

test("shell metadata enumerates exact inherited bindings, including the maximum fd", () => {
  assert.equal(
    MAX_DESCRIPTOR,
    0x7fffffff,
    "the signed metadata sentinel must stay outside the fd domain",
  );
  const inherited = [0, 1, 2, 3, 4, 1000000, MAX_DESCRIPTOR];
  const imports = shellTerminalImports(undefined, inherited);
  assert.deepEqual(
    Array.from({ length: inherited.length }, (_, index) => imports.inherited_fd(index)),
    inherited,
  );
  assert.equal(imports.inherited_fd(inherited.length), -1);
  // The -1 sentinel is outside the runtime's descriptor domain (MAX_DESCRIPTOR=0x7fffffff).
  assert.equal(imports.inherited_fd(inherited.length - 1), 0x7fffffff);
});

test("shell metadata distinguishes an empty binding list from default root stdio", () => {
  assert.equal(shellTerminalImports(undefined, []).inherited_fd(0), -1);
  const root = shellTerminalImports();
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => root.inherited_fd(index)),
    [0, 1, 2, -1],
  );
});

test("production worker keeps terminal stdio for an empty root transport but not an empty child", async () => {
  // Evaluate the actual production wiring, not just the helper's default argument.
  // Root transports intentionally have no bindings: their stdio comes from req.terminal.
  const source = await readFile(resolve("src/runtime/worker.ts"), "utf8");
  const calls = Array.from(
    source.matchAll(/shell_terminal:\s*(shellTerminalImports\([\s\S]*?\n {8}\)),?\n/g),
    (match) => match[1]!,
  );
  assert.equal(calls.length, 1, "locate the worker's actual shell metadata import wiring");
  const install = new Function("req", "shellTerminalImports", `return ${calls[0]};`);
  const bridge = new SharedBridge();
  const root = install(
    { terminal: bridge.buffer, runtimeProcess: { bindings: [] } },
    shellTerminalImports,
  ) as ReturnType<typeof shellTerminalImports>;
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => root.inherited_fd(index)),
    [0, 1, 2, -1],
  );
  const child = install({ runtimeProcess: { bindings: [] } }, shellTerminalImports) as ReturnType<
    typeof shellTerminalImports
  >;
  assert.equal(child.inherited_fd(0), -1);
  const redirected = install(
    { runtimeProcess: { bindings: [{ fd: 1 }, { fd: 3 }, { fd: MAX_DESCRIPTOR }] } },
    shellTerminalImports,
  ) as ReturnType<typeof shellTerminalImports>;
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => redirected.inherited_fd(index)),
    [1, 3, MAX_DESCRIPTOR, -1],
  );
});
