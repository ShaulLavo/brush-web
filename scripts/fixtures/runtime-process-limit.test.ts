// Local runtime limitation reproducer, not browser/guest execution evidence.
// source /work/projects/bun-wasm/env.sh, then use the shared admission runner:
// bun test scripts/fixtures/runtime-process-limit.test.ts
// --todo additionally executes the pending 2,000-command acceptance target.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtime = process.env.BUN_WASM_RUNTIME_ROOT
  ? resolve(process.env.BUN_WASM_RUNTIME_ROOT, "runtime")
  : resolve(import.meta.dirname, "../../third-party/bun-wasm/runtime");
const load = (path: string) => import(pathToFileURL(resolve(runtime, path)).href);
const [
  worker,
  { WorkerProcessBroker },
  { ProcessSupervisor },
  { ExecutableRegistry },
  { DescriptorTable },
] = await Promise.all([
  load("proc/worker-client.ts"),
  load("proc/worker-broker.ts"),
  load("proc/supervisor.ts"),
  load("proc/registry.ts"),
  load("core/descriptors.ts"),
]);

async function sequentialCommands(count: number) {
  const transport = worker.createWorkerProcessTransport();
  const state = worker.workerProcessState(transport);
  const descriptors = new DescriptorTable();
  const registry = new ExecutableRegistry();
  registry.register("controlled-command", {
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    adapter: "preview1",
  });
  // Actual admission, wait and reap; this fixture controls completion rather than
  // creating a worker. No binaries, services, ports or descriptor tokens are retained.
  const supervisor = new ProcessSupervisor({ registry, launch: () => ({ terminate() {} }) });
  supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
  const codec = {
    export() {
      throw new Error("No descriptors in this lifecycle fixture");
    },
    import() {
      throw new Error("No descriptors in this lifecycle fixture");
    },
    discard() {
      throw new Error("No descriptors in this lifecycle fixture");
    },
  };
  const messages: unknown[] = [];
  const broker = new WorkerProcessBroker({ supervisor: () => Promise.resolve(supervisor), codec });
  broker.adoptRoot(transport);
  const client = new worker.WorkerProcessClient({
    transport,
    descriptors,
    codec,
    postMessage(message: unknown) {
      messages.push(message);
    },
  });
  let completed = 0;
  let failure: unknown;
  try {
    for (; completed < count; completed++) {
      let pid: number;
      try {
        pid = client.spawn(state.pid, {
          executable: "controlled-command",
          argv: ["controlled-command"],
          env: {},
          cwd: "/",
          job: 0,
          fds: [],
        });
      } catch (error) {
        failure = error;
        break;
      }
      while (messages.length) await broker.handle(messages.shift());
      await supervisor.start(pid);
      supervisor.exit(pid, 0);
      expect(client.wait(state.pid, pid)?.status).toBe(0);
      expect(supervisor.reap(state.pid, pid).status).toBe(0);
      expect(supervisor.get(pid)).toBeUndefined();
    }
    return { completed, failure };
  } finally {
    broker.dispose();
    supervisor.dispose();
    descriptors.dispose();
  }
}

test("known failure: the 1024-slot page directory exhausts despite sequential wait and reap", async () => {
  const result = await sequentialCommands(2000);
  expect(result.completed).toBe(1023); // One slot belongs to the persistent shell root.
  expect(String(result.failure)).toContain("process directory is full");
});

test.todo("runtime slot recycling: one page must admit 2,000 sequential completed/reaped commands", async () => {
  const result = await sequentialCommands(2000);
  expect(result.failure).toBeUndefined();
  expect(result.completed).toBe(2000);
});
