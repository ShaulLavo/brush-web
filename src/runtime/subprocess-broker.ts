// Adapted from bun-wasm web/src/subprocess-broker.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
// Runnable page-side adapter. The generic process service is loaded only on first spawn;
// blocked guest workers never have to activate a MessageChannel or a nested Worker.
import { runtimePipeOptions } from "./limits";
import { quiesceTerminal, revokeTerminal, type TerminalAdmission } from "./terminal-admission";
import type {
  ChildExitEvent,
  ProcessContext,
  ProcessExit,
  ProcessSupervisor,
  RootProcessOptions,
  Signal,
} from "@bun-wasm/runtime/proc";
import { checkedSignal } from "@bun-wasm/runtime/proc/types";
import {
  createSignalState,
  requestSignal,
  type SignalTransport,
} from "@bun-wasm/runtime/proc/signals";
import { isRevoked } from "@bun-wasm/runtime/fs/protocol";
import { claimOutcome, outcomeWord, readOutcome } from "@bun-wasm/runtime/proc/outcome";
import type { SharedFilesystem } from "./shared-fs";
import { childTransport } from "./subprocess";
import type { Engine, RunRequest, SpawnRequest, WorkerMessage } from "./worker";
import type { WorkerProcessBroker } from "@bun-wasm/runtime/proc/worker-broker";
import type {
  WorkerProcessMessage,
  WorkerProcessTransport,
} from "@bun-wasm/runtime/proc/worker-client";

type Proc = typeof import("@bun-wasm/runtime/proc");
export interface ExecutableRegistration {
  module: WebAssembly.Module | (() => Promise<WebAssembly.Module>);
  adapter: "bun" | "preview1";
  engine?: Engine;
}
interface Child {
  spawn: SpawnRequest;
  context?: ProcessContext;
  worker?: Worker;
  request?: RunRequest;
  signal: number;
  acknowledged: boolean;
  closed: boolean;
  stopped: boolean;
  stopping?: Promise<void>;
}

interface RuntimeChild {
  filesystem: import("@bun-wasm/runtime/fs").FilesystemIdentity;
  transport: WorkerProcessTransport;
  context: ProcessContext;
  request: RunRequest;
  worker: Worker;
  acknowledged: boolean;
  stopped: boolean;
  stopping?: Promise<void>;
}

export class SubprocessBroker {
  private disposed = false;
  private runtime?: WorkerProcessBroker;
  private runtimeActivation?: Promise<WorkerProcessBroker>;
  private runtimeApi?: typeof import("@bun-wasm/runtime/proc/worker-client");
  private runtimeCodec?: typeof import("@bun-wasm/runtime/proc/filesystem-codec");
  private runtimeRoot?: WorkerProcessTransport;
  private runtimePipes?: import("@bun-wasm/runtime/proc/worker-pipes").WorkerPipeBroker;
  private runtimePipeApi?: typeof import("@bun-wasm/runtime/proc/pipes");
  private runtimeTerminals?: typeof import("./runtime-terminals");
  private runtimeRegistry?: import("@bun-wasm/runtime/proc/pipes").PipePublicationRegistry;
  private runtimeChildren = new Map<number, RuntimeChild>();
  private rejectedRuntimeSpawns = new Set<string>();
  private runtimeRejections = new Set<Promise<void>>();
  private children = new Map<number, Child>();
  private registrations = new Map<string, ExecutableRegistration>();
  private activation?: Promise<ProcessSupervisor>;
  private supervisor?: ProcessSupervisor;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private root?: SignalTransport & { pid: number; job: number };
  constructor(
    private filesystem: SharedFilesystem,
    private options: {
      activate?: () => Promise<Proc>;
      root?: RootProcessOptions;
      canConfirmRoot?(): boolean;
      output?(fd: 1 | 2, data: Uint8Array): void;
    } = {},
  ) {
    // Root control is available before the optional process service is imported. Non-isolated
    // runs never supply shared root words and never allocate them unless they activate spawning.
    if (options.root) this.rootTransport();
  }

  private rootTransport(): SignalTransport & { pid: number; job: number } {
    const source = this.options.root;
    return (this.root ??= {
      pid: source?.pid ?? 1,
      job: source?.job ?? 1,
      signalState: createSignalState(source?.signalState),
      outcome: outcomeWord(source?.outcome),
      interrupt:
        source?.interrupt instanceof Int32Array
          ? source.interrupt
          : new Int32Array(source?.interrupt ?? new SharedArrayBuffer(4)),
      requestedSignal:
        source?.requestedSignal instanceof Int32Array
          ? source.requestedSignal
          : new Int32Array(source?.requestedSignal ?? new SharedArrayBuffer(4)),
    });
  }

  register(name: string, entry: ExecutableRegistration): void {
    if (this.activation) throw new Error("Register executables before the first spawn");
    this.registrations.set(name, entry);
  }

  ready(): Promise<ProcessSupervisor> {
    return (this.activation ??= (
      this.options.activate?.() ?? import("@bun-wasm/runtime/proc")
    ).then((proc) => {
      const registry = new proc.ExecutableRegistry();
      for (const [name, entry] of this.registrations)
        registry.register(name, {
          module: entry.module,
          adapter: entry.adapter === "preview1" ? "preview1" : `bun:${entry.engine ?? "browser"}`,
        });
      const supervisor = new proc.ProcessSupervisor({
        registry,
        launch: (context) => this.launch(context),
        onError: (error) => this.report(error),
        // A shared ordinary exit can win before queued terminal output reaches this page.
        // The final ordered worker message acknowledges that output and resource release.
        canConfirmExit: (pid) =>
          this.disposed ||
          (pid === this.root?.pid
            ? this.options.canConfirmRoot?.() !== false
            : this.runtimeChildren.get(pid)?.acknowledged !== false),
        // Runtime confirmation must wait for terminal cursor publication and any other
        // bounded adapter critical section after revocation, but never for Worker.terminate().
        quiesce: (pid) => this.quiesceRuntimeProcess(pid),
      });
      this.supervisor = supervisor;
      const pid = supervisor.createRoot({ ...this.options.root, ...this.rootTransport() });
      if (this.runtimeRoot) {
        supervisor.registerRevocation(pid, () => this.revokeRuntimeProcess(pid));
        this.runtimeApi!.installWorkerBindings(
          this.runtimeRoot,
          supervisor.get(pid)!.descriptors,
          this.runtimeDescriptorCodec(this.runtimeRoot),
        );
      }
      supervisor.onChildExit((event) => {
        this.exited(supervisor, event);
        // The root may exit before sending its first runtime message, which activates
        // the generic broker's listeners. Its supervisor fence is authoritative already.
        if (event.pid === this.root?.pid && this.runtimeRoot) {
          Atomics.store(this.runtimeApi!.workerProcessState(this.runtimeRoot).confirmed, 0, 1);
          this.runtimeApi!.wakeWorkerProcess(this.runtimeRoot);
        }
      });
      supervisor.onProcessQuiescent((event) => {
        if (event.pid === this.root?.pid && this.runtimeRoot)
          this.runtimeApi!.confirmWorkerProcessJob(this.runtimeRoot);
      });
      return supervisor;
    }));
  }

  /** Loading these adapters is opt-in; ordinary Bun runs retain their existing startup graph. */
  private runtimeReady(): Promise<WorkerProcessBroker> {
    return (this.runtimeActivation ??= Promise.all([
      import("@bun-wasm/runtime/proc/worker-broker"),
      import("@bun-wasm/runtime/proc/worker-client"),
      import("@bun-wasm/runtime/proc/filesystem-codec"),
      import("@bun-wasm/runtime/proc/worker-pipes"),
      import("@bun-wasm/runtime/proc/pipes"),
      import("./runtime-terminals"),
    ]).then(([{ WorkerProcessBroker }, client, codec, { WorkerPipeBroker }, pipes, terminals]) => {
      this.runtimeApi = client;
      this.runtimeCodec = codec;
      this.runtimePipeApi = pipes;
      this.runtimeTerminals = terminals;
      this.runtimePipes = new WorkerPipeBroker();
      const broker = (this.runtime = new WorkerProcessBroker({
        supervisor: () => this.ready(),
        codec: (transport) => this.runtimeDescriptorCodec(transport),
        onPipe: (handle) => {
          this.runtimePipes!.attach(
            handle as import("@bun-wasm/runtime/proc/pipes").PipeEndpointHandle,
          );
        },
        pumpPipes: () => this.runtimePipes!.pump(),
        quiesce: (_pid, transport) => this.quiesceRuntimeTransport(transport),
        onError: (error) => this.report(error),
      }));
      if (this.disposed) {
        broker.dispose();
        this.runtimePipes.dispose();
      }
      return broker;
    }));
  }
  private runtimeDescriptorCodec(transport: WorkerProcessTransport) {
    return this.runtimePipes!.codec(
      this.runtimeTerminals!.createRuntimeTerminalCodec({
        fallback: this.runtimeCodec!.createFilesystemDescriptorCodec(
          this.runtimeFilesystem(transport),
          undefined,
          () => this.filesystem.client.sweep(),
        ),
        output: this.options.output,
      }),
    );
  }
  /** Only call after authorized fatal selection, or after the process has completed. */
  revokeRuntimeProcess(pid: number): void {
    this.runtimeRegistry?.revoke(pid);
    const transport =
      this.runtimeChildren.get(pid)?.transport ??
      (this.root?.pid === pid ? this.runtimeRoot : undefined);
    const admission = (transport?.data as { terminalAdmission?: TerminalAdmission } | undefined)
      ?.terminalAdmission;
    if (admission) revokeTerminal(admission);
  }
  /** Supervisor quiescence runs after revocation and before every exit confirmation. */
  private quiesceRuntimeProcess(pid: number): void | Promise<void> {
    // Retained transports also cover reservations that fail before a worker is launched,
    // and remain available after physical shutdown removes runtimeChildren entries.
    const transport =
      this.runtime?.get(pid) ??
      this.runtimeChildren.get(pid)?.transport ??
      (this.root?.pid === pid ? this.runtimeRoot : undefined);
    if (transport) return this.quiesceRuntimeTransport(transport);
    const filesystem = this.children.get(pid)?.spawn.filesystem;
    if (filesystem) return this.filesystem.quiesce(filesystem);
  }
  private async quiesceRuntimeTransport(transport: WorkerProcessTransport): Promise<void> {
    const admission = (transport.data as { terminalAdmission?: TerminalAdmission } | undefined)
      ?.terminalAdmission;
    const [, terminalQuiesced] = await Promise.all([
      this.filesystem.quiesce(this.runtimeFilesystem(transport)),
      admission ? quiesceTerminal(admission) : true,
    ]);
    if (!terminalQuiesced)
      throw new Error("runtime terminal did not become quiescent before process confirmation");
  }
  private runtimeFilesystem(
    transport: WorkerProcessTransport,
  ): import("@bun-wasm/runtime/fs").FilesystemIdentity {
    const data = transport.data as
      | { filesystem?: import("@bun-wasm/runtime/fs").FilesystemIdentity }
      | undefined;
    if (!data?.filesystem) throw new TypeError("runtime process has no filesystem identity");
    return data.filesystem;
  }
  async adoptRuntimeRoot(transport: WorkerProcessTransport): Promise<void> {
    if (this.activation) throw new Error("Adopt the runtime root before activating processes");
    const broker = await this.runtimeReady();
    if (this.disposed) throw new Error("Process broker is disposed");
    this.runtimeFilesystem(transport);
    broker.adoptRoot(transport);
    this.runtimeRoot = transport;
    const state = this.runtimeApi!.workerProcessState(transport);
    const data = transport.data as {
      filesystem: import("@bun-wasm/runtime/fs").FilesystemIdentity;
      pipeRegistry?: import("@bun-wasm/runtime/proc/pipes").PipePublicationRegistryHandle;
    };
    this.runtimeRegistry = data.pipeRegistry
      ? this.runtimePipeApi!.attachPipePublicationRegistry(data.pipeRegistry)
      : new this.runtimePipeApi!.PipePublicationRegistry({ wake: state.wake });
    transport.data = { ...data, pipeRegistry: this.runtimeRegistry.handle() };
    this.root = { pid: state.pid, job: state.job, ...state.signals };
  }
  async runtimeMessage(message: WorkerProcessMessage, senderPid: number): Promise<void> {
    const broker = await this.runtimeReady();
    const sender = broker.get(senderPid);
    const result =
      sender && readOutcome(this.runtimeApi!.workerProcessState(sender).signals.outcome);
    // A reserved notification may arrive after ordinary parent teardown. Its independent
    // filesystem references were retained before publication; fatal senders have no authority.
    if (
      !sender ||
      this.disposed ||
      result?.kind === "signaled" ||
      (!result && isRevoked(this.runtimeFilesystem(sender)))
    ) {
      await this.rejectRuntimeMessage(message);
      return;
    }
    await broker.handle(message, senderPid);
    if (message.operation !== "pipe") this.watch();
  }
  rejectRuntimeMessage(message: WorkerProcessMessage): void | Promise<void> {
    if (message.operation !== "spawn") return;
    // A generic sender is adopted before it can run, so this path never activates Bun runs.
    if (!this.runtimeApi || !this.runtimeCodec) return;
    const transport = message.transport;
    const state = this.runtimeApi.workerProcessState(transport);
    // A duplicate notification owns no new resources, whether the first was admitted or
    // rejected. Process ids never recycle within a directory.
    if (this.runtime?.getIdentity(state.pid)) return;
    const key = `${this.runtimeApi.workerProcessDirectoryId(transport)}:${state.pid}`;
    if (this.rejectedRuntimeSpawns.has(key)) return;
    this.rejectedRuntimeSpawns.add(key);
    const pending = (async () => {
      requestSignal(state.signals, 9);
      this.runtimeRegistry?.revoke(state.pid);
      const identity = this.runtimeFilesystem(transport);
      this.filesystem.revoke(identity);
      const codec = this.runtimeDescriptorCodec(transport);
      let cleaned = true;
      for (const token of transport.resources) {
        try {
          codec.discard(token);
        } catch (error) {
          cleaned = false;
          this.report(error);
        }
      }
      // This transfer never reaches the supervisor, so it owns both confirmations.
      // In particular, a same-job reservation must retire its pending membership once.
      await this.quiesceRuntimeTransport(transport);
      if (cleaned) {
        Atomics.store(state.confirmed, 0, 1);
        this.runtimeApi!.confirmWorkerProcessJob(transport);
      }
      this.runtimeApi!.wakeWorkerProcess(transport);
    })().catch((error) => this.report(error));
    this.runtimeRejections.add(pending);
    void pending.then(() => this.runtimeRejections.delete(pending));
    return pending;
  }

  private exited(supervisor: ProcessSupervisor, event: ChildExitEvent): void {
    this.revokeRuntimeProcess(event.pid);
    const runtime = this.runtime?.get(event.pid);
    if (runtime && !this.runtimeChildren.get(event.pid)?.acknowledged)
      this.filesystem.revoke(this.runtimeFilesystem(runtime));
    const child = this.children.get(event.pid);
    if (child) {
      childTransport(child.spawn.child).finish(
        event.result.status,
        event.result.kind === "signaled" ? event.result.code : undefined,
      );
      if (!child.acknowledged) this.filesystem.revoke(child.spawn.filesystem);
      if (!child.worker) this.children.delete(event.pid);
    }
    const parent = supervisor.get(event.parentPid);
    // A live parent owns its waitable result until it closes the handle. Orphans have no
    // possible waiter; reap their metadata without turning parent exit into background kill.
    // Generic identities share a non-recycled directory. Keep their ancestry until service
    // disposal: a retained descendant spawn may still be queued behind lazy admission.
    if (!runtime && event.parentPid !== 0 && (child?.closed || !parent || parent.result))
      supervisor.reap(event.parentPid, event.pid);
    const completed = Array.from(supervisor.table.values()).filter(
      (record) => record.parentPid === event.pid && record.result && !this.runtime?.get(record.pid),
    );
    for (const record of completed) supervisor.reap(event.pid, record.pid);
  }

  spawn(spawn: SpawnRequest): void {
    if (this.disposed) {
      this.cancel(spawn);
      return;
    }
    this.rootTransport();
    const child: Child = { spawn, signal: 0, acknowledged: false, closed: false, stopped: false };
    this.children.set(spawn.pid, child);
    // No import, compile, worker startup or wait is on the synchronous spawn path.
    void this.ready()
      .then((supervisor) => {
        if (this.disposed) return;
        // This request was admitted while its sender still held filesystem authority. A root
        // exit during lazy activation must not erase an already accepted independent job.
        supervisor.reserveAdmittedSpawn(
          spawn.parentPid,
          {
            executable: spawn.executable,
            argv: spawn.argv,
            env: spawn.env,
            cwd: spawn.cwd,
            job: spawn.job ?? spawn.jobId,
            fds: [],
          },
          {
            pid: spawn.pid,
            job: spawn.jobId,
            interrupt: spawn.child.interrupt,
            requestedSignal: spawn.child.requestedSignal,
            signalState: spawn.child.signalState,
            outcome: spawn.child.outcome,
          },
        );
        const signal = Atomics.load(new Int32Array(spawn.child.requestedSignal), 0);
        if (signal) {
          child.signal = signal;
          supervisor.observeSignal(spawn.pid, signal);
        }
        return supervisor.start(spawn.pid);
      })
      .catch((error) => {
        childTransport(spawn.child).stderr.write(
          new TextEncoder().encode(`bun-wasm: process start failed: ${String(error)}\n`),
        );
        childTransport(spawn.child).finish(126);
        this.filesystem.revoke(spawn.filesystem);
        this.children.delete(spawn.pid);
      });
    this.watch();
  }

  private launch(context: ProcessContext) {
    const runtime = this.runtime?.get(context.pid);
    if (runtime) return this.launchRuntime(context, runtime);
    const child = this.children.get(context.pid);
    if (!child || this.disposed) throw new Error("Process no longer has a live controller");
    const spawn = child.spawn;
    child.context = context;
    const preview1 = context.adapter === "preview1";
    const engine = preview1 ? "browser" : (context.adapter.slice(4) as Engine);
    const request: RunRequest = {
      memoryUsage: new SharedArrayBuffer(8),
      module: context.module,
      engine,
      adapter: preview1 ? "preview1" : "bun",
      args: spawn.argv,
      env: { ...spawn.env, PWD: spawn.cwd },
      filesystem: this.filesystem.connect(spawn.filesystem),
      child: spawn.child,
      pid: spawn.pid,
      jobId: spawn.jobId,
      identity: spawn.child.identity,
      interrupt: spawn.child.interrupt,
      signalState: spawn.child.signalState,
      requestedSignal: spawn.child.requestedSignal,
      outcome: spawn.child.outcome,
      trace: spawn.trace,
      slots: spawn.slots,
      spawnBroker: true,
      net: null,
      moduleCache: null,
    };
    if (!preview1 && engine === "browser" && false)
      request.moduleCache = `bunwasm-m-${crypto.randomUUID()}`;
    child.request = request;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      request.filesystem.port.close();
      throw error;
    }
    child.worker = worker;
    context.registerRevocation(() => {
      this.filesystem.revoke(spawn.filesystem);
      const transport = childTransport(spawn.child);
      if (!spawn.child.inheritedStdin) transport.stdin.close();
      transport.stdout.close();
      transport.stderr.close();
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      const selected = readOutcome(outcomeWord(spawn.child.outcome));
      if (data.type === "runtime-proc") {
        if (selected?.kind === "signaled" || isRevoked(spawn.filesystem))
          this.rejectRuntimeMessage(data);
        else void this.runtimeMessage(data, context.pid).catch((error) => this.report(error));
        return;
      }
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") {
        // Reject queued capabilities even when fatal publication preceded filesystem revocation.
        if (data.type === "spawn") this.cancel(data.request);
        return;
      }
      if (data.type === "spawn") {
        if (isRevoked(spawn.filesystem) || data.request.parentPid !== context.pid)
          this.cancel(data.request);
        else this.spawn(data.request);
        return;
      }
      if (data.type === "child-close") {
        if (!isRevoked(spawn.filesystem) && data.parentPid === context.pid)
          this.close(data.parentPid, data.pid);
        return;
      }
      if (data.type !== "exit" && data.type !== "error") return;
      child.acknowledged = true;
      this.filesystem.reap(spawn.filesystem);
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal as Signal);
      else if (data.type === "exit") context.exit(data.code);
      else context.fail(new Error(data.message));
      this.stopSafely(child);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      childTransport(spawn.child).stderr.write(
        new TextEncoder().encode(`bun-wasm: child worker failed: ${event.message}\n`),
      );
      context.fail(new Error(event.message));
      // Error events are not quiescent acknowledgements. Logical exit is already visible,
      // but a filesystem critical section must finish before physical termination.
      this.stopSafely(child);
    };
    try {
      worker.postMessage(request, [request.filesystem.port]);
    } catch (error) {
      request.filesystem.port.close();
      this.stopSafely(child);
      throw error;
    }
    return { terminate: () => this.stop(child) };
  }

  private launchRuntime(context: ProcessContext, transport: WorkerProcessTransport) {
    if (this.disposed) throw new Error("Process no longer has a live controller");
    const filesystem = this.runtimeFilesystem(transport);
    const preview1 = context.adapter === "preview1";
    const request: RunRequest = {
      memoryUsage: new SharedArrayBuffer(8),
      module: context.module,
      engine: preview1 ? "browser" : (context.adapter.slice(4) as Engine),
      adapter: preview1 ? "preview1" : "bun",
      args: context.request.argv,
      env: { ...context.request.env, PWD: context.request.cwd },
      filesystem: this.filesystem.connect(filesystem),
      runtimeProcess: transport,
      pid: context.pid,
      jobId: context.job,
      trace: false,
      spawnBroker: true,
      net: null,
      moduleCache: null,
    };
    if (!preview1 && request.engine === "browser" && false)
      request.moduleCache = `bunwasm-m-${crypto.randomUUID()}`;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      request.filesystem.port.close();
      throw error;
    }
    const child: RuntimeChild = {
      filesystem,
      transport,
      context,
      request,
      worker,
      acknowledged: false,
      stopped: false,
    };
    this.runtimeChildren.set(context.pid, child);
    // The first watcher can have drained while this module was still loading.
    this.watch();
    context.registerRevocation(() => {
      this.revokeRuntimeProcess(context.pid);
      this.filesystem.revoke(filesystem);
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      const selected = readOutcome(context.outcome);
      if (data.type === "runtime-proc") {
        if (selected?.kind === "signaled" || (!selected && isRevoked(filesystem)))
          this.rejectRuntimeMessage(data);
        else void this.runtimeMessage(data, context.pid).catch((error) => this.report(error));
        return;
      }
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") {
        if (data.type === "spawn") this.cancel(data.request);
        return;
      }
      if (data.type === "stdout" || data.type === "stderr") {
        if (!this.disposed) this.options.output?.(data.type === "stderr" ? 2 : 1, data.data);
        return;
      }
      if (data.type === "spawn") {
        if (isRevoked(filesystem) || data.request.parentPid !== context.pid)
          this.cancel(data.request);
        else this.spawn(data.request);
        return;
      }
      if (data.type === "child-close") {
        if (!isRevoked(filesystem) && data.parentPid === context.pid)
          this.close(data.parentPid, data.pid);
        return;
      }
      if (data.type !== "exit" && data.type !== "error") return;
      child.acknowledged = true;
      this.filesystem.reap(filesystem);
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal as Signal);
      else if (data.type === "exit") context.exit(data.code);
      else context.fail(new Error(data.message));
      this.stopRuntimeSafely(child);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      context.fail(new Error(event.message));
      this.stopRuntimeSafely(child);
    };
    try {
      worker.postMessage(request, [request.filesystem.port]);
    } catch (error) {
      request.filesystem.port.close();
      this.stopRuntimeSafely(child);
      throw error;
    }
    return { terminate: () => this.stopRuntime(child) };
  }
  private stopRuntime(child: RuntimeChild): void | Promise<void> {
    if (child.stopped) return;
    const stop = () => {
      if (child.stopped) return;
      child.stopped = true;
      child.worker.terminate();
      if (child.request.moduleCache) void caches.delete(child.request.moduleCache);
      this.runtimeChildren.delete(child.context.pid);
    };
    return (child.stopping ??= (async () => {
      const admission = (child.transport.data as { terminalAdmission: TerminalAdmission })
        .terminalAdmission;
      const terminalStopped = quiesceTerminal(admission);
      if (!child.acknowledged) await this.filesystem.quiesce(child.filesystem);
      await terminalStopped;
      stop();
    })());
  }
  private stopRuntimeSafely(child: RuntimeChild): void {
    try {
      const pending = this.stopRuntime(child);
      if (pending) void pending.catch((error) => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }

  snapshot() {
    const records = this.supervisor ? Array.from(this.supervisor.table.values()) : [];
    const live = records.filter((record) => !record.result);
    return {
      workers: this.children.size + this.runtimeChildren.size,
      processes: records.length,
      liveProcesses: live.length,
      liveJobs: new Set(live.map((record) => record.job)).size,
      retainedSlots: this.runtimeRoot
        ? this.runtimeApi!.workerProcessSlots(this.runtimeRoot).length
        : 0,
      pipes: this.runtimePipes?.size ?? 0,
      pipeCapacity: runtimePipeOptions.capacity,
      pipeMaxReaders: runtimePipeOptions.maxReaders,
      pipeMaxWriters: runtimePipeOptions.maxWriters,
      guests: Array.from(this.runtimeChildren.values(), (child) => ({
        pid: child.context.pid,
        memoryBytes: child.request.memoryUsage
          ? Number(Atomics.load(new BigInt64Array(child.request.memoryUsage), 0))
          : 0,
      })),
      records: records.map((record) => ({
        pid: record.pid,
        parentPid: record.parentPid,
        job: record.job,
        state: record.state,
        result: record.result,
      })),
    };
  }

  async wait(pid: number): Promise<ProcessExit> {
    const child = this.children.get(pid);
    const supervisor = await this.ready();
    return supervisor.waitForExit(
      child?.spawn.parentPid ?? supervisor.get(pid)?.parentPid ?? this.options.root?.pid ?? 1,
      pid,
    );
  }
  private childSignalTransport(child: Child): SignalTransport {
    const transport = child.spawn.child;
    return {
      signalState: createSignalState(transport.signalState),
      interrupt: new Int32Array(transport.interrupt),
      requestedSignal: new Int32Array(transport.requestedSignal),
      outcome: outcomeWord(transport.outcome),
    };
  }
  private deliver(
    targets: { pid: number; transport: SignalTransport; child?: Child }[],
    signal: number,
  ): Promise<void> {
    // Publication has no callbacks. Every default member's terminal choice precedes any revoke,
    // stream closure, or worker stop, including reentrant exits caused by those operations.
    const deliveries = targets.map((target) => ({
      ...target,
      delivery: requestSignal(target.transport, signal),
    }));
    for (const { pid, delivery } of deliveries) {
      if (delivery.outcome?.kind === "signaled") this.revokeRuntimeProcess(pid);
    }
    for (const { child, delivery } of deliveries) {
      if (!child) continue;
      if (delivery.action !== "ignore")
        child.signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
      if (delivery.outcome) {
        this.filesystem.revoke(child.spawn.filesystem);
        childTransport(child.spawn.child).finish(
          delivery.outcome.status,
          delivery.outcome.kind === "signaled" ? delivery.outcome.code : undefined,
        );
        if (child.worker) this.stopSafely(child);
      }
    }
    if (!this.activation) return Promise.resolve();
    return this.activation.then((supervisor) => {
      for (const { pid, delivery } of deliveries) {
        if (delivery.action !== "ignore" && supervisor.get(pid))
          supervisor.observeSignal(pid, signal);
      }
    });
  }
  kill(pid: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal),
      child = this.children.get(pid);
    if (child)
      return this.deliver([{ pid, child, transport: this.childSignalTransport(child) }], sig);
    if (this.root?.pid === pid) return this.deliver([{ pid, transport: this.root }], sig);
    if (this.runtimeRoot) {
      const state = this.runtimeApi!.workerProcessSlots(this.runtimeRoot)
        .map((slot) => this.runtimeApi!.workerProcessState(this.runtimeRoot!, slot))
        .find((state) => state.pid === pid);
      if (state) return this.deliver([{ pid, transport: state.signals }], sig);
    }
    return this.ready().then((supervisor) => supervisor.kill(pid, sig));
  }
  killJob(job: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal);
    const targets = Array.from(this.children.values())
      .filter((child) => child.spawn.jobId === job)
      .map((child) => ({
        pid: child.spawn.pid,
        child,
        transport: this.childSignalTransport(child),
      }));
    // Root and child workers share these exact words with a later lazy supervisor instance.
    // Never publish locally and then call supervisor.killJob: that could replay a consumed bit.
    const root: { pid: number; transport: SignalTransport; child?: Child }[] =
      this.root?.job === job ? [{ pid: this.root.pid, transport: this.root }] : [];
    // Include reserved generic identities before their lazy module or admission reaches us.
    const runtimeTargets = this.runtimeRoot
      ? this.runtimeApi!.workerProcessSlots(this.runtimeRoot)
          .map((slot) => this.runtimeApi!.workerProcessState(this.runtimeRoot!, slot))
          .filter((state) => state.pid !== this.root?.pid && state.job === job)
          .map((state) => ({ pid: state.pid, transport: state.signals }))
      : [];
    return this.deliver(root.concat(targets, runtimeTargets), sig);
  }
  /** Guest handle ownership, not process ancestry. Close makes an existing wait resolve before
   * reaping; closing a completed child simply releases its retained argv/env/job metadata.
   */
  close(parentPid: number, pid: number): void {
    const child = this.children.get(pid);
    if (child && child.spawn.parentPid !== parentPid) return;
    if (child) child.closed = true;
    if (!this.activation) return;
    void this.activation
      .then((supervisor) => {
        const record = supervisor.get(pid);
        if (!record || record.parentPid !== parentPid) return;
        if (!record.result) {
          // Completion reaches the parent through shared memory before this page necessarily
          // receives the worker's exit message. Preserve that acknowledgement's outcome kind.
          const completed = child && Atomics.load(new Int32Array(child.spawn.child.control), 0);
          const killed =
            child && Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0) === 9;
          if (completed && !killed) return;
          supervisor.kill(pid, 9);
        }
        if (supervisor.get(pid)?.result) supervisor.reap(parentPid, pid);
      })
      .catch((error) => this.report(error));
  }
  /** Parent exit is not job teardown: independently running/background children stay alive. */
  rootExit(code: number): void {
    if (this.root) this.revokeRuntimeProcess(this.root.pid);
    if (this.activation)
      void this.activation
        .then((supervisor) => supervisor.exit(this.root?.pid ?? this.options.root?.pid ?? 1, code))
        .catch((error) => this.report(error));
  }

  private cleanupCache(child: Child): void {
    if (child.request?.moduleCache) void caches.delete(child.request.moduleCache);
  }
  private physicallyStop(child: Child): void {
    if (child.stopped) return;
    child.stopped = true;
    child.worker?.terminate();
    this.cleanupCache(child);
    this.children.delete(child.spawn.pid);
  }
  private stop(child: Child): void | Promise<void> {
    if (child.stopped) return;
    if (child.acknowledged) {
      this.physicallyStop(child);
      return;
    }
    return (child.stopping ??= this.filesystem
      .quiesce(child.spawn.filesystem)
      .then(() => this.physicallyStop(child)));
  }
  private stopSafely(child: Child): void {
    try {
      const pending = this.stop(child);
      if (pending) void pending.catch((error) => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }
  private report(error: unknown): void {
    console.error("bun-wasm: process controller failed", error);
  }
  /** Release an unadmitted request whose sender has already lost process authority. */
  rejectSpawn(spawn: SpawnRequest): void {
    this.cancel(spawn);
  }
  private cancel(spawn: SpawnRequest): void {
    const result = claimOutcome(outcomeWord(spawn.child.outcome), { kind: "signaled", code: 9 });
    if (result.kind === "signaled" && result.code === 9) {
      Atomics.store(new Int32Array(spawn.child.requestedSignal), 0, 9);
      Atomics.store(new Int32Array(spawn.child.interrupt), 0, 9);
    }
    this.filesystem.revoke(spawn.filesystem);
    childTransport(spawn.child).finish(
      result.status,
      result.kind === "signaled" ? result.code : undefined,
    );
  }
  private watch(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ready()
        .then((supervisor) => {
          this.runtime?.pump();
          for (const [pid, child] of this.children) {
            const record = supervisor.get(pid);
            if (!record || record.result) continue;
            // A publisher can stop after the atomic decision but before writing the wake header.
            // Adopt that decision; physical teardown still waits for filesystem quiescence.
            const result = readOutcome(record.outcome);
            if (result) {
              if (result.kind === "signaled") supervisor.defaultSignal(pid, result.code);
              else supervisor.exit(pid, result.code);
              continue;
            }
            const signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
            if (!signal || signal === child.signal) continue;
            child.signal = signal;
            supervisor.observeSignal(pid, signal);
          }
        })
        .catch((error) => this.report(error));
      if (this.children.size || this.runtimeChildren.size) this.watch();
    }, 4);
  }
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const stopping: Promise<void>[] = Array.from(this.runtimeRejections);
    for (const child of Array.from(this.children.values())) {
      this.cancel(child.spawn);
      if (child.worker) {
        const pending = this.stop(child);
        if (pending) stopping.push(pending);
      } else this.children.delete(child.spawn.pid);
    }
    this.runtime?.dispose();
    if (this.runtimeRoot) {
      for (const slot of this.runtimeApi!.workerProcessSlots(this.runtimeRoot)) {
        this.revokeRuntimeProcess(this.runtimeApi!.workerProcessState(this.runtimeRoot, slot).pid);
      }
      // The root can be disposed before the first runtime message activates the generic
      // broker. Keep its shared confirmations independent of broker listeners being cleared.
      const root = this.runtimeRoot;
      stopping.push(
        (this.activation
          ? this.activation.then((supervisor) =>
              supervisor.waitForExit(0, this.runtimeApi!.workerProcessState(root).pid),
            )
          : this.quiesceRuntimeTransport(root)
        ).then(() => {
          const state = this.runtimeApi!.workerProcessState(root);
          Atomics.store(state.confirmed, 0, 1);
          this.runtimeApi!.confirmWorkerProcessJob(root);
        }),
      );
    }
    for (const child of this.runtimeChildren.values()) {
      this.revokeRuntimeProcess(child.context.pid);
      this.filesystem.revoke(child.filesystem);
      const pending = this.stopRuntime(child);
      if (pending) stopping.push(pending);
    }
    // Process disposal releases descriptor lifetimes; relay buffers outlive every consumer.
    if (this.activation)
      stopping.push(
        this.activation.then((supervisor) => {
          supervisor.dispose();
        }),
      );
    return Promise.all(stopping)
      .then(async () => {
        // Worker messages queued before shutdown can reserve independent cleanup work
        // while earlier workers are still fenced. Drain additions, not just the snapshot.
        while (this.runtimeRejections.size) await Promise.all(Array.from(this.runtimeRejections));
        this.runtimePipes?.dispose();
      })
      .catch((error) => this.report(error));
  }
}
