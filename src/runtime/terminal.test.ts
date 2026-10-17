import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const { build } = createRequire(resolve(process.cwd(), "package.json"))(
  "esbuild",
) as typeof import("esbuild");
import {
  attachTerminal,
  createTerminalAdmission,
  quiesceTerminal,
  type TerminalAdmission,
} from "./terminal-admission";
import {
  preserveRootPreopen,
  preservePreopenDiscovery,
  shellTerminalImports,
} from "./guest-imports";
import assert from "node:assert/strict";
import { DescriptorTable } from "@bun-wasm/runtime/core";
import { PipeController, attachPipeEndpoint } from "@bun-wasm/runtime/proc/pipes";
import { SubprocessHost, childTransport, type ChildTransport } from "./subprocess";
import { SharedBridge, control, INPUT_CAPACITY, OUTPUT_CAPACITY } from "../bridge";
import { createBridgeTerminal, createRuntimeTerminalCodec } from "./runtime-terminals";

const unsupported = () => {
  throw new Error("unexpected nonterminal descriptor");
};
const codec = () =>
  createRuntimeTerminalCodec({
    fallback: { export: unsupported, import: unsupported, discard: unsupported },
  });

test("terminal immediate operations return EAGAIN without entering a blocking path", () => {
  const bridge = new SharedBridge();
  const input = createBridgeTerminal(bridge.buffer, 0);
  const output = createBridgeTerminal(bridge.buffer, 1);
  assert.equal(input.tryRead!([new Uint8Array(1)]), -6);
  assert.equal(input.tryRead!([new Uint8Array()]), 0);
  assert.equal(output.tryWrite!([new Uint8Array(OUTPUT_CAPACITY + 1).fill(97)]), OUTPUT_CAPACITY);
  assert.equal(output.tryWrite!([new Uint8Array([98])]), -6);
  assert.equal(output.readiness().writable, false);
  Atomics.store(bridge.state, control.inputLock, 1);
  assert.equal(input.tryRead!([new Uint8Array(1)]), -6);
  Atomics.store(bridge.state, control.inputLock, 0);
  bridge.drain(OUTPUT_CAPACITY);
  Atomics.store(bridge.state, control.outputLock, 1);
  assert.equal(output.tryWrite!([new Uint8Array([98])]), -6);
  Atomics.store(bridge.state, control.outputLock, 0);
  assert.equal(output.tryWrite!([new Uint8Array([98])]), 1);
  assert.deepEqual(bridge.drain(), new Uint8Array([98]));
});

test("terminal ring wraps without losing binary bytes or exceeding its fixed capacity", () => {
  const bridge = new SharedBridge();
  const input = createBridgeTerminal(bridge.buffer, 0);
  const first = new Uint8Array(INPUT_CAPACITY - 2).fill(11);
  assert.equal(bridge.send(first), true);
  assert.equal(input.tryRead!([new Uint8Array(first.length)]), first.length);
  const binary = new Uint8Array([0, 255, 13, 10, 27]);
  assert.equal(bridge.send(binary), true);
  const a = new Uint8Array(2),
    b = new Uint8Array(10);
  assert.equal(input.tryRead!([a, b]), binary.length);
  assert.deepEqual(a, binary.subarray(0, 2));
  assert.deepEqual(b.subarray(0, 3), binary.subarray(2));
  assert.equal(bridge.availableInput(), 0);
  assert.equal(bridge.buffer.byteLength, 64 + INPUT_CAPACITY + OUTPUT_CAPACITY);
});

test("arbitrary fd remapping preserves transferable terminal endpoint provenance", () => {
  const bridge = new SharedBridge();
  const table = new DescriptorTable();
  const fd = table.open(createBridgeTerminal(bridge.buffer, 2), 1n << 6n, 0n);
  const token = codec().export(table.get(fd)!, 2);
  const imported = codec().import(token, 2);
  const remapped = new DescriptorTable();
  remapped.inherit(77, {
    description: imported,
    resource: imported.resource,
    rightsBase: 1n << 6n,
    rightsInheriting: 0n,
  });
  const nextToken = codec().export(remapped.get(77)!, 3);
  const grandchild = codec().import(nextToken, 3);
  assert.equal(grandchild.resource.kind, "terminal");
  if (grandchild.resource.kind !== "terminal") throw new Error("expected terminal");
  assert.equal(grandchild.resource.tryWrite!([new Uint8Array([0, 255, 10])]), 3);
  assert.deepEqual(bridge.drain(), new Uint8Array([0, 255, 10]));
  remapped.dispose();
  table.dispose();
  assert.equal(bridge.closed(), false);
});

test("independently imported stdin readers consume one shared cursor", () => {
  const bridge = new SharedBridge();
  const source = new DescriptorTable();
  source.open(createBridgeTerminal(bridge.buffer, 0), 1n << 1n, 0n);
  const token = codec().export(source.get(0)!, 2);
  const first = codec().import(token, 2).resource;
  const second = codec().import(codec().export(source.get(0)!, 3), 3).resource;
  if (first.kind !== "terminal" || second.kind !== "terminal")
    throw new Error("expected terminals");
  bridge.send(new Uint8Array([1, 2, 3, 4]));
  const a = new Uint8Array(2),
    b = new Uint8Array(2);
  assert.equal(first.tryRead!([a]), 2);
  assert.equal(second.tryRead!([b]), 2);
  assert.deepEqual(a, new Uint8Array([1, 2]));
  assert.deepEqual(b, new Uint8Array([3, 4]));
  bridge.close();
  assert.equal(first.tryRead!([a]), 0);
  assert.equal(second.readiness().hangup, true);
  source.dispose();
});

// Exercise an actual worker paused INSIDE ring-copy code, not a fabricated unlocked endpoint.
// Build in memory, matching this gate's own runner; no fixture files or worker artifacts remain.
async function heldTerminalWorker(
  target: 0 | 1,
  bridge: SharedBridge,
  admission: TerminalAdmission,
) {
  const pause = new SharedArrayBuffer(8);
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { parentPort, workerData } from 'node:worker_threads';
        import { createBridgeTerminal } from './src/runtime/runtime-terminals';
        const { buffer, admission, pause, target } = workerData;
        const cells = new Int32Array(pause);
        const hold = () => {
          parentPort.postMessage('held');
          Atomics.wait(cells, 1, 0);
        };
        class HeldBytes extends Uint8Array {
          set(bytes, offset) { hold(); return super.set(bytes, offset); }
          subarray(start, end) { hold(); return new Uint8Array(this.buffer, this.byteOffset + start, end - start); }
        }
        const stream = createBridgeTerminal(buffer, target, () => {}, admission);
        const bytes = new HeldBytes(1);
        bytes[0] = 9;
        if (target === 0) stream.tryRead([bytes]); else stream.tryWrite([bytes]);
        parentPort.postMessage('released');
        Atomics.wait(cells, 0, 0);
      `,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@bun-wasm/runtime": resolve(process.cwd(), "third-party/bun-wasm/runtime") },
  });
  const worker = new Worker(compiled.outputFiles[0]!.text, {
    eval: true,
    workerData: { target, buffer: bridge.buffer, admission, pause },
  });
  return { worker, pause: new Int32Array(pause) };
}
for (const target of [0, 1] as const) {
  test(
    `fatal teardown fences a held ${target === 0 ? "input" : "output"} lock before terminating; root/background survive`,
    { timeout: 5000 },
    async (context) => {
      const bridge = new SharedBridge();
      const admission = createTerminalAdmission();
      attachTerminal(admission, bridge.buffer);
      if (target === 0) bridge.send(new Uint8Array([9, 1, 2]));
      const { worker, pause } = await heldTerminalWorker(target, bridge, admission);
      context.after(async () => {
        Atomics.store(pause, 1, 1);
        Atomics.notify(pause, 1);
        await worker.terminate();
      });
      try {
        await once(worker, "message");
        const lock = target === 0 ? control.inputLock : control.outputLock;
        assert.equal(Atomics.load(bridge.state, lock), 1);
        let stopped = false;
        const stopping = quiesceTerminal(admission).then(() => {
          stopped = true;
        });
        await Promise.resolve();
        assert.equal(stopped, false, "physical stop must wait for the critical section");
        const root = createBridgeTerminal(bridge.buffer, target);
        const background = createBridgeTerminal(bridge.buffer, target);
        const io = (stream: typeof root, value: number) => {
          const bytes = new Uint8Array([value]);
          const count = target === 0 ? stream.tryRead!([bytes]) : stream.tryWrite!([bytes]);
          return { count, bytes };
        };
        assert.equal(io(root, 1).count, -6);
        Atomics.store(pause, 1, 1);
        Atomics.notify(pause, 1);
        await stopping;
        assert.equal(Atomics.load(bridge.state, lock), 0);
        const revoked = createBridgeTerminal(bridge.buffer, target, () => {}, admission);
        assert.equal(io(revoked, 7).count, -29, "late entrants cannot touch the shared ring");
        await worker.terminate();
        assert.deepEqual(io(root, 1), { count: 1, bytes: new Uint8Array([1]) });
        assert.deepEqual(io(background, 2), { count: 1, bytes: new Uint8Array([2]) });
        if (target === 1) assert.deepEqual(bridge.drain(), new Uint8Array([9, 1, 2]));
        assert.equal(bridge.closed(), false);
      } finally {
        Atomics.store(pause, 1, 1);
        Atomics.notify(pause, 1);
        await worker.terminate();
      }
    },
  );
}

test("unrecoverable crashed holder fails terminal closed without unsafe lock reclamation", async () => {
  const bridge = new SharedBridge();
  const admission = createTerminalAdmission();
  attachTerminal(admission, bridge.buffer);
  Atomics.store(new Int32Array(admission.state), 1, 1);
  Atomics.store(bridge.state, control.outputLock, 1);
  assert.equal(await quiesceTerminal(admission, 0), false);
  assert.equal(Atomics.load(bridge.state, control.outputLock), 1);
  assert.equal(Atomics.load(bridge.state, control.phase), 4);
  assert.equal(bridge.closed(), true);
  assert.equal(createBridgeTerminal(bridge.buffer, 0).tryRead!([new Uint8Array(1)]), -29);
  assert.equal(createBridgeTerminal(bridge.buffer, 1).tryWrite!([new Uint8Array([1])]), -29);
  shellTerminalImports(bridge.buffer).phase(1);
  assert.equal(
    Atomics.load(bridge.state, control.phase),
    4,
    "a later prompt must not mask terminal failure",
  );
});

test("all child terminal fds share fresh admission, independently of parent and sibling", async () => {
  const bridge = new SharedBridge();
  const source = new DescriptorTable();
  source.open(createBridgeTerminal(bridge.buffer, 0), 0n, 0n);
  source.open(createBridgeTerminal(bridge.buffer, 1), 0n, 0n);
  const admission = createTerminalAdmission();
  const childCodec = createRuntimeTerminalCodec({
    fallback: { export: unsupported, import: unsupported, discard: unsupported },
    exportAdmission: admission,
  });
  const input = childCodec.import(childCodec.export(source.get(0)!, 2), 2).resource;
  const output = childCodec.import(childCodec.export(source.get(1)!, 2), 2).resource;
  const sibling = codec().import(codec().export(source.get(1)!, 3), 3).resource;
  assert.equal(await quiesceTerminal(admission), true);
  for (const stream of [input, output]) {
    if (stream.kind !== "terminal") throw new Error("expected terminal");
    assert.equal(stream.tryWrite!([new Uint8Array([1])]), -29);
  }
  if (sibling.kind !== "terminal") throw new Error("expected terminal");
  assert.equal(sibling.tryWrite!([new Uint8Array([2])]), 1);
  source.dispose();
});

test("inherited fd3 stays terminal while the real root preopen remains discoverable", () => {
  const table = new DescriptorTable();
  const bridge = new SharedBridge();
  for (const target of [0, 1, 2] as const)
    table.open(createBridgeTerminal(bridge.buffer, target), 0n, 0n);
  table.open({ kind: "directory", handle: 1 }, 0n, 0n, undefined, "/");
  const root = table.get(3)!.resource;
  const preopen = preserveRootPreopen(table, [0, 1, 2, 3, 77]);
  assert.equal(preopen, 4);
  table.inherit(3, table.get(1)!);
  assert.equal(table.get(3)!.resource.kind, "terminal");
  assert.equal(table.get(3)!.preopen, undefined);
  assert.equal(table.get(preopen)!.resource, root);
  assert.equal(table.get(preopen)!.preopen, "/");
  const imports = {
    wasi_snapshot_preview1: { fd_prestat_get: (fd: number) => (fd === preopen ? 0 : 8) },
  };
  preservePreopenDiscovery(imports, table, preopen);
  assert.equal(imports.wasi_snapshot_preview1.fd_prestat_get(3), 58);
  assert.equal(imports.wasi_snapshot_preview1.fd_prestat_get(preopen), 0);
  assert.equal(imports.wasi_snapshot_preview1.fd_prestat_get(preopen + 1), 8);
  table.dispose();
});

test("child shell phase imports exist without changing root terminal ownership", () => {
  const bridge = new SharedBridge();
  shellTerminalImports(bridge.buffer).phase(1);
  shellTerminalImports().phase(2);
  assert.equal(Atomics.load(bridge.state, control.phase), 1);
});

test("nested Bun spawn retains generic pipeline stdin and closes only its own reader", () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(1, "write");
  let child: ChildTransport | undefined;
  const parent = new SubprocessHost({
    pid: 1,
    inheritStdinPipe: (pid) => reader.forProcess(pid).handle(),
    launch: (_meta, transport) => {
      child = transport;
      return { terminate() {} };
    },
    output: () => true,
  });
  try {
    assert.ok(parent.spawn(JSON.stringify({ argv: ["bun", "reader.ts"], stdin: "inherit" })) > 0);
    assert.ok(child?.runtimeStdin);
    const input = attachPipeEndpoint(child.runtimeStdin);
    const bytes = new Uint8Array(7);
    assert.equal(writer.tryWrite([new TextEncoder().encode("payload")]), 7);
    assert.equal(input.tryRead([bytes]), 7);
    assert.equal(new TextDecoder().decode(bytes), "payload");
    childTransport(child).finish(0);
    assert.equal(input.tryRead([bytes]), -8);
    assert.equal(writer.tryWrite([new Uint8Array([42])]), 1, "parent's reader is still open");
    assert.equal(reader.tryRead([bytes]), 1);
    assert.equal(bytes[0], 42);
  } finally {
    parent.dispose();
    reader.close();
    writer.close();
    pipe.dispose();
  }
});
