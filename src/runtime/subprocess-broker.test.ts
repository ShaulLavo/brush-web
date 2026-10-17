// Original adapter regressions: exercise the page broker and the worker's actual prepareSpawn
// callback against the pinned runtime. No browser, compiled guest, or vendored test changes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { DescriptorTable } from "@bun-wasm/runtime/core";
import {
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  connectFilesystemIdentity,
  FilesystemSection,
  reapFilesystem,
  revokeFilesystem,
  waitForFilesystemQuiescence,
  type FilesystemIdentity,
} from "@bun-wasm/runtime/fs/protocol";
import {
  WorkerProcessClient,
  createWorkerProcessTransport,
  workerProcessState,
  workerProcessSlots,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "@bun-wasm/runtime/proc/worker-client";
import { createWorkerPipeCodec } from "@bun-wasm/runtime/proc/worker-pipes";
import { PipeController } from "@bun-wasm/runtime/proc/pipes";
import { readOutcome } from "@bun-wasm/runtime/proc/outcome";
import { SubprocessBroker } from "./subprocess-broker";
import type { SharedFilesystem } from "./shared-fs";
import type { RunRequest, WorkerMessage } from "./worker";
import { createTerminalAdmission } from "./terminal-admission";

const require = createRequire(resolve(process.cwd(), "package.json"));
const { build } = require("esbuild") as typeof import("esbuild");
const turn = () => new Promise<void>((done) => setImmediate(done));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "adapter progress timed out");
    await turn();
  }
}
const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

async function fixture(context: TestContext, terminal = true) {
  const connections: ReturnType<typeof connectFilesystemIdentity>[] = [];
  const releases: (() => void)[] = [];
  const workers: GuestWorker[] = [];
  // Only physical guest startup is stubbed. The actual runtime supervisor, process directory,
  // codecs, and filesystem revoke/admission/reap protocol run unchanged.
  class GuestWorker {
    onmessage?: (event: MessageEvent<WorkerMessage>) => void;
    onerror?: (event: ErrorEvent) => void;
    request?: RunRequest;
    terminations = 0;
    constructor() {
      workers.push(this);
    }
    postMessage(request: RunRequest) {
      this.request = request;
    }
    terminate() {
      this.terminations++;
    }
  }
  const previousWorker = globalThis.Worker;
  globalThis.Worker = GuestWorker as unknown as typeof globalThis.Worker;
  const quiesced: FilesystemIdentity[] = [];
  const filesystem = {
    client: { sweep() {} },
    connect(identity: FilesystemIdentity) {
      const connection = connectFilesystemIdentity(identity);
      connections.push(connection);
      return connection.client;
    },
    revoke: revokeFilesystem,
    reap: reapFilesystem,
    async quiesce(identity: FilesystemIdentity) {
      await waitForFilesystemQuiescence(identity);
      reapFilesystem(identity);
      quiesced.push(identity);
    },
  } as unknown as SharedFilesystem;
  const identity = createFilesystemIdentity(undefined, 16 * 1024 * 1024);
  const root = createWorkerProcessTransport({ capacity: 16 });
  root.data = {
    filesystem: identity,
    ...(terminal ? { terminalAdmission: createTerminalAdmission() } : {}),
  };
  const broker = new SubprocessBroker(filesystem);
  context.after(async () => {
    try {
      for (const release of releases) release();
      await broker.dispose();
    } finally {
      for (const { client, server } of connections) {
        client.port.close();
        server.port.close();
      }
      globalThis.Worker = previousWorker;
    }
  });
  broker.register("fixture", { module: emptyModule, adapter: "preview1" });
  await broker.adoptRuntimeRoot(root);
  const supervisor = await broker.ready();
  function client(transport = root, descriptors = new DescriptorTable()) {
    const messages: WorkerProcessMessage[] = [];
    const guest = new WorkerProcessClient({
      transport,
      descriptors,
      codec: createWorkerPipeCodec(),
      prepareSpawn: () => ({
        data: {
          filesystem: createProcessFilesystemIdentity(
            (transport.data as { filesystem: FilesystemIdentity }).filesystem,
          ),
          terminalAdmission: createTerminalAdmission(),
        },
      }),
      postMessage: (message) => messages.push(message),
    });
    context.after(() => descriptors.dispose());
    return { guest, messages };
  }
  async function spawn(parent = client(), job = 0, fds: { child: number; parent: number }[] = []) {
    const pid = parent.guest.spawn(parent.guest.pid, {
      executable: "fixture",
      argv: ["fixture"],
      env: {},
      cwd: "/",
      job,
      fds,
    });
    const message = parent.messages.at(-1)!;
    assert.equal(message.operation, "spawn");
    return { pid, message, transport: message.transport };
  }
  function hold(identity: FilesystemIdentity) {
    const release = holdFilesystem(identity);
    releases.push(release);
    return release;
  }
  return { broker, root, identity, supervisor, workers, quiesced, client, spawn, hold, releases };
}

function holdFilesystem(identity: FilesystemIdentity) {
  const section = new FilesystemSection(identity);
  section.enter();
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    section.exit();
  };
  return release;
}
function holdTerminal(admission: ReturnType<typeof createTerminalAdmission>) {
  const cells = new Int32Array(admission.state);
  Atomics.add(cells, 1, 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (Atomics.sub(cells, 1, 1) === 1) Atomics.notify(cells, 1);
  };
}
function assertUnconfirmed(transport: WorkerProcessTransport, pending = 1) {
  const state = workerProcessState(transport);
  assert.equal(Atomics.load(state.confirmed, 0), 0, "process wait must remain fenced");
  assert.equal(Atomics.load(state.jobConfirmed, 0), 0, "job wait must remain fenced");
  assert.equal(Atomics.load(state.jobPending, 0), pending);
}
function assertConfirmed(transport: WorkerProcessTransport, pending = 0) {
  const state = workerProcessState(transport);
  assert.equal(Atomics.load(state.confirmed, 0), 1);
  assert.equal(Atomics.load(state.jobConfirmed, 0), 1);
  assert.equal(Atomics.load(state.jobPending, 0), pending);
}

test(
  "root disposal before any runtime message publishes both confirmations after its fence",
  { timeout: 5000 },
  async (context) => {
    const { broker, root, identity, hold } = await fixture(context, true);
    const release = hold(identity);
    const disposing = broker.dispose();
    await turn();
    assertUnconfirmed(root);
    release();
    await disposing;
    assertConfirmed(root);
  },
);

for (const terminal of [false, true]) {
  test(
    `root exit confirmation fences filesystem work with${terminal ? "" : "out"} terminal admission`,
    { timeout: 5000 },
    async (context) => {
      const { broker, root, identity, supervisor, quiesced, hold, releases } = await fixture(
        context,
        terminal,
      );
      const release = hold(identity);
      const terminalRelease = terminal
        ? holdTerminal(
            (root.data as { terminalAdmission: ReturnType<typeof createTerminalAdmission> })
              .terminalAdmission,
          )
        : undefined;
      if (terminalRelease) releases.push(terminalRelease);
      let waited = false;
      const waiting = supervisor.waitForExit(0, 1).then((result) => {
        waited = true;
        return result;
      });
      await broker.kill(1, 9);
      await turn();
      assert.equal(readOutcome(workerProcessState(root).signals.outcome)?.status, 137);
      assert.equal(Atomics.load(new Int32Array(identity.sections), 0), 1);
      assertUnconfirmed(root);
      assert.equal(waited, false);
      release();
      await turn();
      if (terminalRelease) {
        assertUnconfirmed(root);
        assert.equal(waited, false, "terminal-only work must also hold confirmation");
        terminalRelease();
      }
      assert.equal((await waiting).status, 137);
      assertConfirmed(root);
      assert.ok(quiesced.includes(identity));
    },
  );
}

test(
  "child confirmation and physical termination both wait for filesystem quiescence",
  { timeout: 5000 },
  async (context) => {
    const { broker, supervisor, workers, spawn, quiesced, hold, releases } = await fixture(context);
    const child = await spawn();
    await broker.runtimeMessage(child.message, 1);
    await until(() => workers.length === 1);
    const identity = (child.transport.data as { filesystem: FilesystemIdentity }).filesystem;
    const release = hold(identity);
    const terminalRelease = holdTerminal(
      (child.transport.data as { terminalAdmission: ReturnType<typeof createTerminalAdmission> })
        .terminalAdmission,
    );
    releases.push(terminalRelease);
    let waited = false;
    const waiting = supervisor.waitForExit(1, child.pid).then((result) => {
      waited = true;
      return result;
    });
    await broker.kill(child.pid, 9);
    await turn();
    assertUnconfirmed(child.transport);
    assert.equal(waited, false);
    assert.equal(workers[0]!.terminations, 0);
    release();
    await turn();
    assertUnconfirmed(child.transport);
    assert.equal(workers[0]!.terminations, 0, "terminal-only work still prevents termination");
    terminalRelease();
    assert.equal((await waiting).status, 137);
    await until(() => workers[0]!.terminations === 1);
    assertConfirmed(child.transport);
    assert.ok(quiesced.includes(identity));
    await broker.kill(child.pid, 9);
    assert.equal(workers[0]!.terminations, 1, "duplicate exit cannot terminate twice");
  },
);

test(
  "a child that never launches still fences its retained filesystem transport",
  { timeout: 5000 },
  async (context) => {
    const { broker, supervisor, workers, spawn, hold } = await fixture(context);
    const child = await spawn();
    const identity = (child.transport.data as { filesystem: FilesystemIdentity }).filesystem;
    const release = hold(identity);
    // Kill the shared reservation before the page admits it: start() must never launch it.
    await broker.kill(child.pid, 9);
    await broker.runtimeMessage(child.message, 1);
    await turn();
    assert.equal(workers.length, 0);
    assertUnconfirmed(child.transport);
    const waiting = supervisor.waitForExit(1, child.pid);
    release();
    assert.equal((await waiting).status, 137);
    assertConfirmed(child.transport);
  },
);

test(
  "failure before supervisor admission fences both adapter identities before confirmation",
  { timeout: 5000 },
  async (context) => {
    const { broker, supervisor, spawn, hold, releases } = await fixture(context);
    const child = await spawn();
    const data = child.transport.data as {
      filesystem: FilesystemIdentity;
      terminalAdmission: ReturnType<typeof createTerminalAdmission>;
    };
    const release = hold(data.filesystem);
    const terminalRelease = holdTerminal(data.terminalAdmission);
    releases.push(terminalRelease);
    context.mock.method(supervisor, "reserveAdmittedSpawn", () => {
      throw new Error("fixture refused admission");
    });
    const failed = broker.runtimeMessage(child.message, 1).then(
      () => assert.fail("admission should fail"),
      (error: unknown) => error,
    );
    await turn();
    assert.equal(supervisor.get(child.pid), undefined);
    assertUnconfirmed(child.transport);
    release();
    await turn();
    assertUnconfirmed(child.transport);
    terminalRelease();
    assert.match(String(await failed), /fixture refused admission/);
    assertConfirmed(child.transport);
  },
);

test(
  "disposal drains a late rejected transfer before releasing pipe brokers",
  { timeout: 5000 },
  async (context) => {
    const { broker, workers, spawn, client, hold } = await fixture(context);
    const parent = await spawn();
    await broker.runtimeMessage(parent.message, 1);
    await until(() => workers.length === 1);
    const parentIdentity = (parent.transport.data as { filesystem: FilesystemIdentity }).filesystem;
    const releaseParent = hold(parentIdentity);
    const child = await spawn(client(parent.transport));
    const releaseChild = hold(
      (child.transport.data as { filesystem: FilesystemIdentity }).filesystem,
    );
    let disposed = false;
    const disposing = broker.dispose().then(() => {
      disposed = true;
    });
    await turn();
    const rejecting = broker.rejectRuntimeMessage(child.message);
    releaseParent();
    await until(() => workers[0]!.terminations === 1);
    await turn();
    assert.equal(disposed, false, "late independent filesystem work still belongs to disposal");
    assertUnconfirmed(child.transport);
    releaseChild();
    await rejecting;
    await disposing;
    assertConfirmed(child.transport);
  },
);

test(
  "a terminal timeout cannot publish rejected-transfer confirmations",
  { timeout: 5000 },
  async (context) => {
    context.mock.method(console, "error", () => {});
    const { broker, spawn, releases } = await fixture(context);
    const child = await spawn();
    const admission = (
      child.transport.data as {
        terminalAdmission: ReturnType<typeof createTerminalAdmission>;
      }
    ).terminalAdmission;
    releases.push(holdTerminal(admission));
    let clock = 0;
    const now = context.mock.method(performance, "now", () => (clock++ === 0 ? 0 : 3000));
    await broker.rejectRuntimeMessage(child.message);
    now.mock.restore();
    assert.equal(Atomics.load(new Int32Array(admission.state), 1), 1);
    assertUnconfirmed(child.transport);
  },
);

test(
  "rejected same-job descendants retire membership once, after resource cleanup and both fences",
  { timeout: 5000 },
  async (context) => {
    const { broker, root, supervisor, workers, client, spawn, hold, releases } =
      await fixture(context);
    const leader = await spawn();
    await broker.runtimeMessage(leader.message, 1);
    await until(() => workers.length === 1);
    const pipe = new PipeController({ relay: "manual" });
    const reader = pipe.retain(leader.pid, "read");
    const writer = pipe.retain(1, "write");
    context.after(() => {
      reader.close();
      writer.close();
      pipe.dispose();
    });
    const descriptors = new DescriptorTable();
    descriptors.open(reader, 0n, 0n);
    const parent = client(leader.transport, descriptors);
    const descendant = await spawn(parent, workerProcessState(leader.transport).job, [
      { parent: 0, child: 0 },
    ]);
    reader.close();
    const data = descendant.transport.data as {
      filesystem: FilesystemIdentity;
      terminalAdmission: ReturnType<typeof createTerminalAdmission>;
    };
    const release = hold(data.filesystem);
    const terminal = new Int32Array(data.terminalAdmission.state);
    Atomics.store(terminal, 1, 1);
    releases.push(() => {
      Atomics.store(terminal, 1, 0);
      Atomics.notify(terminal, 1);
    });
    await broker.kill(leader.pid, 9);
    await supervisor.waitForExit(1, leader.pid);
    assertConfirmed(leader.transport, 1);
    const rootGuest = client(root).guest;
    const job = workerProcessState(leader.transport).job;
    assert.equal(rootGuest.waitJob(1, job), null);
    const rejecting = broker.runtimeMessage(descendant.message, leader.pid);
    // Deliver the same capability twice while the first rejection is still fenced.
    await broker.runtimeMessage(structuredClone(descendant.message), leader.pid);
    await turn();
    assert.equal(writer.tryWrite([new Uint8Array([42])]), -64, "discard closed the last reader");
    assertUnconfirmed(descendant.transport);
    release();
    await turn();
    assertUnconfirmed(descendant.transport);
    assert.equal(rootGuest.waitJob(1, job), null, "terminal work still holds job admission");
    Atomics.store(terminal, 1, 0);
    Atomics.notify(terminal, 1);
    await rejecting;
    assertConfirmed(descendant.transport);
    await broker.runtimeMessage(structuredClone(descendant.message), leader.pid);
    assertConfirmed(descendant.transport);
    assert.equal(rootGuest.waitJob(1, job)?.status, 137);
    assert.equal(Atomics.load(workerProcessState(descendant.transport).jobPending, 0), -1);
  },
);

test(
  "rejection never confirms failed cleanup, but still discards remaining resources",
  { timeout: 5000 },
  async (context) => {
    const diagnostics = context.mock.method(console, "error", () => {});
    const { broker, root, supervisor, client, spawn } = await fixture(context);
    const pipe = new PipeController({ relay: "manual" });
    const reader = pipe.retain(1, "read");
    const writer = pipe.retain(1, "write");
    context.after(() => {
      reader.close();
      writer.close();
      pipe.dispose();
    });
    const descriptors = new DescriptorTable();
    descriptors.open(reader, 0n, 0n);
    const child = await spawn(client(root, descriptors), 0, [{ parent: 0, child: 0 }]);
    reader.close();
    const invalidResources: unknown[] = [{ kind: "invalid-token" }];
    child.transport.resources = invalidResources.concat(child.transport.resources);
    await broker.kill(1, 9);
    await supervisor.waitForExit(0, 1);
    await broker.runtimeMessage(child.message, 1);
    assertUnconfirmed(child.transport);
    assert.equal(writer.tryWrite([new Uint8Array([42])]), -64);
    assert.equal(diagnostics.mock.callCount(), 1);
    await broker.runtimeMessage(structuredClone(child.message), 1);
    assertUnconfirmed(child.transport);
    assert.equal(
      diagnostics.mock.callCount(),
      1,
      "a duplicate does not retry failed ownership cleanup",
    );
  },
);

test(
  "ordinary child exit and duplicate acknowledgments confirm exactly once",
  { timeout: 5000 },
  async (context) => {
    const { broker, supervisor, workers, spawn } = await fixture(context);
    const child = await spawn();
    await broker.runtimeMessage(child.message, 1);
    await until(() => workers.length === 1);
    const waiting = supervisor.waitForExit(1, child.pid);
    const event = { data: { type: "exit", code: 23 } } as MessageEvent<WorkerMessage>;
    workers[0]!.onmessage!(event);
    workers[0]!.onmessage!(event);
    assert.equal((await waiting).status, 23);
    assertConfirmed(child.transport);
    await until(() => workers[0]!.terminations === 1);
    assert.equal(workers[0]!.terminations, 1);
  },
);

// Compile the production callback, not a test copy of its lifecycle wiring. Its closing
// property indentation bounds the extraction; esbuild validates the resulting worker code.
// A worker pauses exactly at fence release so the page can inspect the actual reservation.
async function prepareSpawnSource() {
  const source = await readFile(resolve(process.cwd(), "src/runtime/worker.ts"), "utf8");
  const callbacks = Array.from(
    source.matchAll(/prepareSpawn:\s*(\(\)\s*=>\s*\{[\s\S]*?\n {8}\}),?\n/g),
    (match) => match[1]!,
  );
  assert.equal(callbacks.length, 1, "locate the actual worker adapter prepareSpawn callback");
  return callbacks[0]!;
}

for (const failure of ["export", "publication", "none"] as const) {
  test(
    `worker spawn admission releases only after ${failure === "none" ? "successful publication" : `failed ${failure} confirmation`}`,
    { timeout: 5000 },
    async (context) => {
      const root = createWorkerProcessTransport({ capacity: 4 });
      const filesystem = createFilesystemIdentity(undefined, 16 * 1024 * 1024);
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const compiled = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
          import { parentPort, workerData } from 'node:worker_threads';
          import { DescriptorTable } from '@bun-wasm/runtime/core';
          import { FilesystemSection, createProcessFilesystemIdentity } from '@bun-wasm/runtime/fs/protocol';
          import { WorkerProcessClient } from '@bun-wasm/runtime/proc/worker-client';
          import { createTerminalAdmission } from './src/runtime/terminal-admission';
          const { root, filesystem, pause, failure } = workerData;
          const section = new FilesystemSection(filesystem);
          const fs = {
            connection: filesystem,
            beginTransfer() {
              section.enter();
              return () => {
                parentPort.postMessage('releasing');
                Atomics.wait(new Int32Array(pause), 0, 0);
                section.exit();
              };
            },
          };
          const checkActive = () => {};
          const createRuntimeTerminalCodec = options => options.fallback;
          const createFilesystemDescriptorCodec = () => ({
            export() { if (failure === 'export') throw new Error('export failed'); return {}; },
            discard() {},
          });
          const pipes = { codec: codec => codec, registry: { handle: () => ({}) } };
          const descriptors = new DescriptorTable();
          descriptors.open({ kind: 'directory', handle: 1 }, 0n, 0n);
          const guest = new WorkerProcessClient({
            transport: root, descriptors, codec: {},
            prepareSpawn: ${await prepareSpawnSource()},
            postMessage(message) {
              if (failure === 'publication') throw new Error('publication failed');
              parentPort.postMessage(message);
            },
          });
          try {
            guest.spawn(1, { executable: 'fixture', argv: [], env: {}, cwd: '/', job: 0,
              fds: [{ parent: 0, child: 0 }] });
          } catch (error) { parentPort.postMessage({ error: error.message }); }
          parentPort.postMessage('finished');
          descriptors.dispose();
        `,
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        alias: { "@bun-wasm/runtime": resolve(process.cwd(), "third-party/bun-wasm/runtime") },
      });
      const worker = new NodeWorker(compiled.outputFiles[0]!.text, {
        eval: true,
        execArgv: [],
        workerData: { root, filesystem, pause: pause.buffer, failure },
      });
      context.after(async () => {
        Atomics.store(pause, 0, 1);
        Atomics.notify(pause, 0);
        await worker.terminate();
      });
      const messages: unknown[] = [];
      worker.on("message", (message) => messages.push(message));
      const exited = once(worker, "exit");
      await until(() => messages.includes("releasing"));
      assert.equal(Atomics.load(new Int32Array(filesystem.sections), 0), 1);
      const slots = workerProcessSlots(root);
      assert.equal(slots.length, 2);
      const child = { ...root, slot: slots[1]! };
      if (failure === "none") {
        assert.ok(
          messages.some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "operation" in message &&
              message.operation === "spawn",
          ),
        );
        assertUnconfirmed(child);
      } else {
        assertConfirmed(child);
        assert.equal(readOutcome(workerProcessState(child).signals.outcome)?.status, 126);
      }
      Atomics.store(pause, 0, 1);
      Atomics.notify(pause, 0);
      assert.equal((await exited)[0], 0);
      assert.equal(Atomics.load(new Int32Array(filesystem.sections), 0), 0);
      assert.ok(messages.includes("finished"));
    },
  );
}
