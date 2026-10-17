// Original standalone lifecycle regression. Only physical worker startup is stubbed;
// the fork uses the pinned runtime's real filesystem identity and connection protocol.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  reapFilesystem,
  type FilesystemIdentity,
} from "@bun-wasm/runtime/fs/protocol";
import { SharedBridge } from "../bridge";
import { BrowserRuntime } from "./browser-runtime";
import type { SharedFilesystem } from "./shared-fs";

test("worker construction failure retires its filesystem fork without disposing the owner", async (context) => {
  const previousWorker = globalThis.Worker;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const connections: ReturnType<typeof connectFilesystemIdentity>[] = [];
  const reaped: FilesystemIdentity[] = [];
  const written: string[] = [];
  let disposed = 0;
  let closed = 0;
  let runtime: BrowserRuntime | undefined;
  context.after(() => {
    runtime?.dispose();
    for (const { client, server } of connections) {
      client.port.close();
      server.port.close();
    }
    globalThis.Worker = previousWorker;
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });
  const failure = new Error("Worker construction refused");
  globalThis.Worker = class {
    constructor() {
      throw failure;
    }
  } as unknown as typeof Worker;
  globalThis.document = { baseURI: "https://shell.example/" } as Document;
  globalThis.fetch = async () => new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const filesystem = {
    async mkdirp() {},
    async lookup() {
      return undefined;
    },
    async writeFile(path: string) {
      written.push(path);
    },
    async drain() {},
    fork() {
      const connection = connectFilesystemIdentity(
        createFilesystemIdentity(undefined, 16 * 1024 * 1024),
      );
      connections.push(connection);
      const close = connection.client.port.close.bind(connection.client.port);
      connection.client.port.close = () => {
        closed++;
        close();
      };
      return connection.client;
    },
    reap(identity: FilesystemIdentity) {
      reaped.push(identity);
      reapFilesystem(identity);
    },
    dispose() {
      disposed++;
    },
  } as unknown as SharedFilesystem;
  runtime = new BrowserRuntime({ filesystem });
  const options = {
    executable: "/programs/shell-engine.wasm",
    argv: ["shell"],
    env: {},
    cwd: "/home/guest",
    terminal: new SharedBridge(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runtime.startProcess(options), (error) => error === failure);
    assert.equal(closed, attempt + 1);
    assert.equal(reaped.length, attempt + 1);
    assert.equal(reaped[attempt].capabilities, connections[attempt].client.capabilities);
    assert.equal(Atomics.load(new Int32Array(reaped[attempt].revocations[0]!), 0), 2);
    assert.deepEqual(runtime.snapshot().roots, []);
    assert.equal(disposed, 0);
  }
  assert.ok(!written.includes("/dev/null"), "unsupported devices must not be ordinary files");
});
