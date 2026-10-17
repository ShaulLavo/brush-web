// Original standalone embedding of the peer runtime. The shell facade does not import this file.
// Root launch/outcome fencing follows bun-wasm web/src/runner.ts at
// 8d3d416aa9cb23718ed3487a33d0b06e8e373672; adapted for persistent interactive Preview1 roots.
import {
  createWorkerProcessTransport,
  workerProcessState,
  type WorkerProcessTransport,
} from "@bun-wasm/runtime/proc/worker-client";
import { claimOutcome, readOutcome } from "@bun-wasm/runtime/proc/outcome";
import { SharedFilesystem } from "./shared-fs";
import { SubprocessBroker } from "./subprocess-broker";
import type { RunRequest, WorkerMessage } from "./worker";
import { processDirectoryCapacity } from "./limits";
import { control } from "../bridge";
import { attachTerminal, createTerminalAdmission, quiesceTerminal } from "./terminal-admission";
import type { RuntimeExit, RuntimeProcess, ShellProcessOptions, ShellRuntimePeer } from "../shell";

export interface BrowserRuntimeOptions {
  assetBase?: string | URL;
  filesystem?: SharedFilesystem;
}
interface ActiveRoot {
  worker: Worker;
  broker: SubprocessBroker;
  transport: WorkerProcessTransport;
  stop(): Promise<void>;
  cancel(): void;
  memoryUsage: SharedArrayBuffer;
}
export class BrowserRuntime implements ShellRuntimePeer {
  readonly filesystem: SharedFilesystem;
  private readonly ownsFilesystem: boolean;
  private readonly modules = new Map<
    string,
    Promise<{ module: WebAssembly.Module; size: number }>
  >();
  private readonly roots = new Set<ActiveRoot>();
  private initialization?: Promise<void>;
  private disposed = false;
  private readonly base: URL;
  constructor(options: BrowserRuntimeOptions = {}) {
    this.base = new URL(options.assetBase ?? document.baseURI, document.baseURI);
    this.ownsFilesystem = !options.filesystem;
    this.filesystem = options.filesystem ?? new SharedFilesystem({ persistence: false });
  }
  private initialize(): Promise<void> {
    return (this.initialization ??= (async () => {
      await this.filesystem.mkdirp("/home/guest");
      await this.filesystem.mkdirp("/tmp");
      await this.filesystem.mkdirp("/dev");
      await this.filesystem.mkdirp("/bin");
      await this.filesystem.mkdirp("/usr/local/bin");
      await this.filesystem.mkdirp("/programs");
      if (!(await this.filesystem.lookup("/home/guest/welcome.txt")))
        await this.filesystem.writeFile(
          "/home/guest/welcome.txt",
          "Files and commands run inside this browser.\n",
        );
      // Names are filesystem-visible; execution resolves through the runtime registry, never eval.
      for (const path of [
        "/bin/bun",
        "/bin/node",
        "/usr/local/bin/bun",
        "/usr/local/bin/node",
        "/programs/shell-engine.wasm",
        "/dev/null",
      ])
        if (!(await this.filesystem.lookup(path)))
          await this.filesystem.writeFile(path, new Uint8Array());
      await this.filesystem.drain();
    })());
  }
  private module(path: string) {
    let pending = this.modules.get(path);
    if (!pending) {
      pending = (async () => {
        const url = new URL(path.replace(/^\//, ""), this.base);
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(`Runtime executable fetch failed: ${url.pathname} (${response.status})`);
        const bytes = await response.arrayBuffer();
        return { module: await WebAssembly.compile(bytes), size: bytes.byteLength };
      })();
      this.modules.set(path, pending);
    }
    return pending;
  }
  async startProcess(options: ShellProcessOptions): Promise<RuntimeProcess> {
    if (this.disposed) throw new Error("Runtime is disposed");
    await this.initialize();
    const preview1 = options.executable === "/programs/shell-engine.wasm";
    if (!preview1 && !["bun", "node", "/bin/bun", "/bin/node"].includes(options.executable))
      throw new Error(`Executable is not registered: ${options.executable}`);
    const executable = preview1 ? "programs/shell-engine.wasm" : "programs/bun.wasm";
    const loaded = await this.module(executable);
    if (this.disposed) throw new Error("Runtime is disposed");
    const transport = createWorkerProcessTransport({ capacity: processDirectoryCapacity });
    const state = workerProcessState(transport);
    const filesystem = this.filesystem.fork();
    const { port: _port, ...identity } = filesystem;
    const terminalAdmission = createTerminalAdmission();
    attachTerminal(terminalAdmission, options.terminal.buffer);
    transport.data = { filesystem: identity, terminalAdmission };
    const broker = new SubprocessBroker(this.filesystem, {
      canConfirmRoot: () => acknowledged,
      output: (_fd, bytes) => {
        options.terminal.tryWrite([bytes]);
      },
    });
    // A shell module is never a Bun alias. Every Bun/Node registry entry resolves real bun.wasm.
    const bun = () => this.module("programs/bun.wasm").then((result) => result.module);
    for (const name of [
      "bun",
      "/bun",
      "node",
      "/node",
      "/bin/bun",
      "/bin/node",
      "/usr/local/bin/bun",
      "/usr/local/bin/node",
    ])
      broker.register(name, { module: bun, adapter: "bun", engine: "quickjs" });
    broker.register("/programs/shell-engine.wasm", {
      module: () => this.module("programs/shell-engine.wasm").then((result) => result.module),
      adapter: "preview1",
    });
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    let resolveDone!: (result: RuntimeExit) => void;
    const done = new Promise<RuntimeExit>((resolve) => {
      resolveDone = resolve;
    });
    let resolveStarted!: () => void;
    let rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    // A worker load failure can arrive while descriptor/root admission is still awaiting.
    // Keep its rejection observed until the startup await below owns it.
    void started.catch(() => {});
    let finished = false;
    let stopped: Promise<void> | undefined;
    let acknowledged = false;
    let watcher: ReturnType<typeof setTimeout> | undefined;
    const stop = () =>
      (stopped ??= (async () => {
        clearTimeout(watcher);
        broker.revokeRuntimeProcess(state.pid);
        const terminalStopped = quiesceTerminal(terminalAdmission);
        if (acknowledged) this.filesystem.reap(identity);
        else await this.filesystem.quiesce(identity);
        await terminalStopped;
        worker.terminate();
      })());
    const memoryUsage = new SharedArrayBuffer(8);
    const root: ActiveRoot = {
      worker,
      broker,
      transport,
      stop,
      memoryUsage,
      cancel: () => finish({ code: 137, error: "Runtime was disposed" }, false, 9),
    };
    this.roots.add(root);
    const finish = (result: RuntimeExit, ack = false, signal?: number) => {
      if (finished) return;
      finished = true;
      acknowledged = ack;
      const winner = claimOutcome(
        state.signals.outcome,
        signal === undefined
          ? { kind: "exited", code: result.code }
          : { kind: "signaled", code: signal },
      );
      const exit = { ...result, code: winner.status };
      if (Atomics.load(options.terminal.state, control.phase) !== 4) {
        Atomics.store(options.terminal.state, control.status, winner.status);
        Atomics.store(options.terminal.state, control.phase, result.error ? 4 : 3);
      }
      if (result.error) rejectStarted(new Error(result.error));
      else resolveStarted();
      broker.rootExit(winner.status);
      void stop().catch((error) => console.error("Shell root cleanup failed", error));
      resolveDone(exit);
    };
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (finished) {
        if (data.type === "spawn") broker.rejectSpawn(data.request);
        if (data.type === "runtime-proc") broker.rejectRuntimeMessage(data);
        return;
      }
      const selected = readOutcome(state.signals.outcome);
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") {
        if (data.type === "spawn") broker.rejectSpawn(data.request);
        if (data.type === "runtime-proc") broker.rejectRuntimeMessage(data);
        finish({ code: selected.status }, false, selected.code);
      } else if (data.type === "runtime-proc") {
        void broker
          .runtimeMessage(data, state.pid)
          .catch((error) => finish({ code: 1, error: String(error) }));
      } else if (data.type === "spawn") broker.spawn(data.request);
      else if (data.type === "child-close") broker.close(data.parentPid, data.pid);
      else if (data.type === "phase") {
        if (data.name === "instantiate") resolveStarted();
      } else if (data.type === "exit") finish({ code: data.code }, true, data.signal);
      else if (data.type === "error") finish({ code: data.code, error: data.message }, true);
      else if (data.type === "default-signal")
        finish({ code: 128 + data.signal }, false, data.signal);
      else if (data.type === "stdout" || data.type === "stderr")
        options.terminal.tryWrite([data.data]);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ code: 1, error: `Runtime worker failed: ${event.message}` });
    };
    worker.onmessageerror = () =>
      finish({ code: 1, error: "Runtime worker message could not be decoded" });
    const watch = () => {
      if (finished) return;
      watcher = setTimeout(() => {
        const result = readOutcome(state.signals.outcome);
        if (result?.kind === "signaled") finish({ code: result.status }, false, result.code);
        else watch();
      }, 4);
    };
    try {
      await broker.adoptRuntimeRoot(transport);
      if (this.disposed) throw new Error("Runtime is disposed");
      // Activate the host supervisor before a root signal or spawn can arrive.
      await broker.ready();
      const request: RunRequest = {
        engine: "quickjs",
        adapter: preview1 ? "preview1" : "bun",
        module: loaded.module,
        memoryUsage,
        args: options.argv,
        env: { ...options.env, PWD: options.cwd },
        filesystem,
        runtimeProcess: transport,
        terminal: options.terminal.buffer,
        terminalAdmission,
        pid: state.pid,
        jobId: state.job,
        spawnBroker: true,
        trace: false,
        net: null,
        moduleCache: null,
      };
      worker.postMessage(request, [filesystem.port]);
      watch();
      await started;
    } catch (error) {
      filesystem.port.close();
      finish({ code: 126, error: error instanceof Error ? error.message : String(error) });
      await broker.dispose();
      this.roots.delete(root);
      throw error;
    }
    return {
      pid: state.pid,
      wasmBytes: loaded.size,
      done,
      signal: (signal) => {
        if (!finished)
          void broker
            .kill(state.pid, signal)
            .catch((error) => finish({ code: 1, error: String(error) }));
      },
      dispose: () => {
        if (!finished) {
          void broker.kill(state.pid, 9);
          finish({ code: 137 }, false, 9);
        }
        void Promise.all([stop(), broker.dispose()]).finally(() => this.roots.delete(root));
      },
    };
  }
  snapshot() {
    return {
      filesystemWorkers: this.disposed ? 0 : 1,
      processDirectoryCapacity,
      roots: Array.from(this.roots, (root) => ({
        pid: workerProcessState(root.transport).pid,
        worker: root.worker.constructor.name,
        directoryBytes: root.transport.directory.byteLength,
        memoryBytes: Number(Atomics.load(new BigInt64Array(root.memoryUsage), 0)),
        ...root.broker.snapshot(),
      })),
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.modules.clear();
    const roots = Array.from(this.roots);
    this.roots.clear();
    void Promise.all(
      roots.map(async (root) => {
        root.cancel();
        await Promise.all([root.broker.dispose(), root.stop()]);
      }),
    ).finally(() => {
      if (this.ownsFilesystem) this.filesystem.dispose();
    });
  }
}

export function createBrowserRuntime(options: BrowserRuntimeOptions = {}): BrowserRuntime {
  return new BrowserRuntime(options);
}
