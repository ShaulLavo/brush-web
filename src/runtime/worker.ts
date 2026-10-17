// Adapted from bun-wasm web/src/worker.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
// One worker per process: instantiate its registered module fresh and use the shared filesystem service.
// The "browser" engine (bun-browser.wasm) runs natives and the transpiler in wasm, then hands the
// program to engine-host.js, which runs it in this worker's own JS engine.

import { startEngineHost } from "./engine-host.js";
import { createBridgeTerminal } from "./runtime-terminals";
import {
  preserveRootPreopen,
  preservePreopenDiscovery,
  shellTerminalImports,
} from "./guest-imports";
import { createTerminalAdmission, type TerminalAdmission } from "./terminal-admission";
import { SharedBridge, control } from "../bridge";
import { runtimePipeOptions } from "./limits";
import { withFileOffset } from "@bun-wasm/runtime/core/open-file";
import { PipeEndpoint, attachPipeEndpoint } from "@bun-wasm/runtime/proc/pipes";
import {
  FilesystemClient,
  createFilesystemIdentity,
  revokeFilesystem,
  sharedRevoked,
  type FilesystemIdentity,
  type FilesystemConnection,
} from "@bun-wasm/runtime/fs";
import { NetHost } from "./net/host";
import type { NetRequest } from "./net/protocol";
import { HOST_CALL_FD, installHostSlots, installHostSlotsViaImport } from "./net/trampoline";
import { Wasi, WasiExit, type Stream } from "@bun-wasm/runtime/core";
import { claimOutcome, outcomeWord, readOutcome } from "@bun-wasm/runtime/proc/outcome";
import type { ProcessExit } from "@bun-wasm/runtime/proc/types";
import type {
  WorkerProcessClient,
  WorkerProcessMessage,
  WorkerProcessTransport,
} from "@bun-wasm/runtime/proc/worker-client";
import { SubprocessHost, childTransport, wasiPipe, type ChildTransport } from "./subprocess";

export type Engine = "quickjs" | "jsc" | "browser";

export interface RunRequest {
  engine: Engine;
  /** Interactive root terminal; descendants inherit its descriptor tokens. */
  terminal?: SharedArrayBuffer;
  terminalAdmission?: TerminalAdmission;
  /** Host-boundary memory sampling; telemetry is not a guest allocation quota. */
  memoryUsage?: SharedArrayBuffer;
  adapter?: "bun" | "preview1";
  pid?: number;
  jobId?: number;
  identity?: SharedArrayBuffer;
  interrupt?: SharedArrayBuffer;
  requestedSignal?: SharedArrayBuffer;
  signalState?: SharedArrayBuffer;
  outcome?: SharedArrayBuffer;
  module: WebAssembly.Module;
  args: string[];
  env: Record<string, string>;
  filesystem: FilesystemConnection;
  trace: boolean;
  /** The networking ring (net/ring.ts); null when the page is not cross-origin isolated. */
  net: SharedArrayBuffer | null;
  /**
   * Browser engine: the Cache Storage cache for this run's ES modules, which the service worker
   * serves under ./m/ (this worker runs from its ./__bunwasm/ scope). Null: blob URLs, no cycles.
   */
  moduleCache: string | null;
  /**
   * How the wasm engines get the networking host functions (`?slots=`): "imports" (default) has
   * the guest call them through a WASI import; "table" appends them to the guest's function table
   * as functions of a second module, which iOS Safari rejects at call_indirect ("signature does not
   * match"), so it is kept only for comparison; "off" installs none.
   */
  slots?: "table" | "imports" | "off";
  child?: ChildTransport;
  /** Generic descriptor ownership is opt-in; legacy Bun slots do not load its adapters. */
  runtimeProcess?: WorkerProcessTransport;
  /** The page creates child workers while this worker may be blocked in a wasm call. */
  spawnBroker?: boolean;
}

// The browser engine's polyfills replace globalThis.Response; Cache.put needs the real one.
const NativeResponse = Response;

/** Named module URLs for engine-host.js, stored where the service worker (sw.ts) serves them. */
function moduleStore(cacheName: string) {
  const run = cacheName.replace(/^bunwasm-m-/, "");
  const base = new URL(`./m/${run}/`, self.location.href).href;
  const cache = caches.open(cacheName);
  return {
    url: (key: string) => base + encodeURIComponent(key),
    put: async (url: string, source: string) => {
      const headers = { "content-type": "text/javascript; charset=utf-8" };
      await (await cache).put(url, new NativeResponse(source, { headers }));
    },
  };
}

export interface SpawnRequest {
  executable: string;
  argv: string[];
  pid: number;
  parentPid: number;
  jobId: number;
  /** Preserve 0/-1 new-job intent separately from the pre-reserved job id. */
  job?: number;
  cwd: string;
  env: Record<string, string>;
  filesystem: FilesystemIdentity;
  child: ChildTransport;
  trace: boolean;
  slots?: RunRequest["slots"];
  spawnBroker: true;
}

/** A guest explicitly choosing the default action, not an unrelated guest trap. */
class DefaultSignal extends Error {
  constructor(readonly signal: number) {
    super(`Process stopped by signal ${signal}`);
  }
}

export type WorkerMessage =
  | WorkerProcessMessage
  | { type: "spawn"; request: SpawnRequest }
  | { type: "child-close"; pid: number; parentPid: number }
  | { type: "phase"; name: string; duration: number }
  | { type: "stdout"; data: Uint8Array }
  | { type: "stderr"; data: Uint8Array }
  | { type: "net"; req: NetRequest }
  | { type: "exit"; code: number; signal?: number; sleep: SleepMode }
  | { type: "default-signal"; signal: number }
  | { type: "error"; code: number; message: string; sleep: SleepMode };

export type SleepMode = "atomics" | "busy-wait";

// Keep worker-only types local: the embedding application is compiled with the DOM library.
interface ProcessWorkerScope {
  crossOriginIsolated: boolean;
  fetch: typeof fetch;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<RunRequest>) => void) | null;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}
const ctx = self as unknown as ProcessWorkerScope;

const sleepCell =
  ctx.crossOriginIsolated && typeof SharedArrayBuffer === "function"
    ? new Int32Array(new SharedArrayBuffer(4))
    : null;
const sleepMode: SleepMode = sleepCell ? "atomics" : "busy-wait";
// The browser engine replaces globalThis.performance with the runtime's (which calls into wasm).
const perfNow = performance.now.bind(performance);

function sleep(ms: number): void {
  if (ms <= 0) return;
  if (sleepCell) {
    Atomics.wait(sleepCell, 0, 0, ms);
    return;
  }
  // Without cross-origin isolation there is no SharedArrayBuffer, so spin. This only burns the worker's thread.
  const end = perfNow() + ms;
  while (perfNow() < end) {
    /* spin */
  }
}

// The engines' default stack budgets are measured on V8, whose first wasm tier uses frames close to
// its optimized ones. JavaScriptCore starts in an interpreter with frames up to three times larger,
// in 512 KiB worker stacks on Apple platforms, so other engines get the budgets measured there
// (docs/stack-limits.md). V8 is the engine whose stack traces have "    at " frames.
const smallStackKib: Partial<Record<Engine, string>> | null = /\n\s+at /.test(
  new Error().stack ?? "",
)
  ? null
  : { quickjs: "32", jsc: "192" };

function guestEnv(req: RunRequest): Record<string, string> {
  const kib = smallStackKib?.[req.engine];
  if (!kib || "BUN_WASM_STACK_KIB" in req.env) return req.env;
  return { ...req.env, BUN_WASM_STACK_KIB: kib };
}

const sendNet = (req: NetRequest, transfer: Transferable[] = []) =>
  ctx.postMessage({ type: "net", req } satisfies WorkerMessage, transfer);

/** `Name: message` plus the first stack frames (wasm function names when the build keeps them). */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const head = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.includes(err.message))
    .slice(0, 15);
  return frames.length ? `${head}\n${frames.map((f) => `    ${f.trim()}`).join("\n")}` : head;
}

ctx.onmessage = async (event: MessageEvent<RunRequest>) => {
  ctx.postMessage({ type: "phase", name: "worker-start", duration: 0 } satisfies WorkerMessage);
  const req = event.data;
  const fs = new FilesystemClient(req.filesystem);
  let runtimeProcess: WorkerProcessClient | null = null;
  let processSignalExit: typeof import("@bun-wasm/runtime/proc/abi").ProcessSignalExit | undefined;
  const child = req.child ? childTransport(req.child) : null;
  const isolated = ctx.crossOriginIsolated && typeof SharedArrayBuffer === "function";
  const sharedOutcome = req.child?.outcome ?? req.outcome;
  let outcome = sharedOutcome || isolated ? outcomeWord(sharedOutcome) : null;
  const requestedSignalBuffer = req.child?.requestedSignal ?? req.requestedSignal;
  let requestedSignal: Int32Array | undefined = requestedSignalBuffer
    ? new Int32Array(requestedSignalBuffer)
    : undefined;
  const revoked = sharedRevoked(req.filesystem);
  let localOutcome: ProcessExit | null = null;
  let guestMemory: WebAssembly.Memory | undefined;
  const memoryUsage = req.memoryUsage ? new BigInt64Array(req.memoryUsage) : undefined;
  let lastMemoryBytes = -1;
  const claim = (result: Pick<ProcessExit, "kind" | "code">): ProcessExit =>
    outcome
      ? claimOutcome(outcome, result)
      : (localOutcome ??= {
          ...result,
          status: result.kind === "signaled" ? 128 + result.code : result.code,
        });
  const defaultSignal = (signal: number): never => {
    if (!Number.isInteger(signal) || signal < 1 || signal > 64)
      throw new Error(`Invalid default signal: ${signal}`);
    const killed = requestedSignal && Atomics.load(requestedSignal, 0) === 9;
    // Guest JS can catch this unwind. Commit logical death before it regains control, and never
    // allow a later code-only engine completion to replace the typed terminal winner.
    const winner = claim({ kind: "signaled", code: killed ? 9 : signal });
    runtimeProcess?.defaultSignal(runtimeProcess.pid, winner.code);
    revokeFilesystem(fs.connection);
    // Without shared memory the page cannot observe logical death if guest JS catches this
    // unwind and never completes. This notice is not an acknowledgement of released references.
    if (!outcome && winner.kind === "signaled")
      ctx.postMessage({ type: "default-signal", signal: winner.code } satisfies WorkerMessage);
    throw new DefaultSignal(signal);
  };
  const checkActive = () => {
    if (guestMemory && memoryUsage) {
      const bytes = guestMemory.buffer.byteLength;
      if (bytes !== lastMemoryBytes) {
        lastMemoryBytes = bytes;
        Atomics.store(memoryUsage, 0, BigInt(bytes));
        if (req.terminal)
          Atomics.store(new SharedBridge(req.terminal).state, control.memory, bytes);
      }
    }
    const winner = outcome ? readOutcome(outcome) : localOutcome;
    if (winner?.kind === "signaled") defaultSignal(winner.code);
    if (winner) throw new WasiExit(winner.status);
    if (revoked()) throw new WasiExit(1);
  };
  let subprocess: SubprocessHost | null = null;
  let wasi: Wasi | null = null;
  let done = false;
  let started = false;
  /** Sends the result (once) with the filesystem; the page then terminates this worker. */
  const finish = (result: { code: number; signal?: number } | { error: unknown }) => {
    if (done) return;
    done = true;
    const settled = outcome ? readOutcome(outcome) : localOutcome;
    const ownCode = "code" in result ? result.code : started ? 1 : 126;
    const ownSignal = "signal" in result ? result.signal : undefined;
    subprocess?.detach();
    if (child) {
      // A broker may close pipes as soon as it observes ordinary completion. Buffer host-owned
      // crash diagnostics first; fatal callbacks have already claimed their outcome and skip this.
      if ("error" in result && !settled)
        child.stderr.writeAll(new TextEncoder().encode(`${describeError(result.error)}\n`));
      wasi?.descriptors.dispose();
      fs.dispose();
      child.finish(ownCode, ownSignal);
      const winner = readOutcome(outcome!)!;
      // A completion word alone does not prove the worker released filesystem references.
      ctx.postMessage({
        type: "exit",
        code: winner.status,
        signal: winner.kind === "signaled" ? winner.code : undefined,
        sleep: sleepMode,
      } satisfies WorkerMessage);
      return;
    }
    const winner = claim(
      ownSignal === undefined
        ? { kind: "exited", code: ownCode }
        : { kind: "signaled", code: ownSignal },
    );
    const code = winner.status;
    const signal = winner.kind === "signaled" ? winner.code : undefined;
    wasi?.descriptors.dispose();
    fs.dispose();
    runtimeProcess?.exit(code);
    if ("code" in result || settled || winner.kind === "signaled") {
      ctx.postMessage({ type: "exit", code, signal, sleep: sleepMode } satisfies WorkerMessage);
      return;
    }
    const err = result.error;
    const message = describeError(err);
    ctx.postMessage({ type: "error", code, message, sleep: sleepMode } satisfies WorkerMessage);
  };
  try {
    const runtime = req.runtimeProcess
      ? await import("@bun-wasm/runtime/proc/worker-client")
      : null;
    const runtimeState = req.runtimeProcess
      ? runtime!.workerProcessState(req.runtimeProcess)
      : null;
    if (runtimeState) {
      outcome = runtimeState.signals.outcome;
      requestedSignal = runtimeState.signals.requestedSignal;
    }
    const guardStream = (stream: Stream): Stream => ({
      ...stream,
      read(chunks) {
        checkActive();
        return stream.read(chunks);
      },
      write(chunks) {
        checkActive();
        return stream.write(chunks);
      },
      readiness() {
        checkActive();
        return stream.readiness();
      },
    });
    const inheritedInput = req.child?.runtimeStdin
      ? attachPipeEndpoint(req.child.runtimeStdin)
      : undefined;
    const stdio = child
      ? {
          0: inheritedInput ?? guardStream(wasiPipe(child.stdin, "read")),
          1: guardStream(wasiPipe(child.stdout, "write")),
          2: guardStream(wasiPipe(child.stderr, "write")),
        }
      : req.terminal
        ? {
            0: createBridgeTerminal(req.terminal, 0, checkActive, req.terminalAdmission),
            1: createBridgeTerminal(req.terminal, 1, checkActive, req.terminalAdmission),
            2: createBridgeTerminal(req.terminal, 2, checkActive, req.terminalAdmission),
          }
        : undefined;
    const post = (type: "stdout" | "stderr", data: Uint8Array) => {
      // Bun's inherited host-slot output must respect generic descriptor redirections too.
      // No unbounded postMessage queue between descendants and the terminal/pipe consumer.
      if (req.runtimeProcess && wasi) {
        const resource = wasi.descriptors.get(type === "stderr" ? 2 : 1)?.resource;
        if (!resource || resource.kind === "directory") return false;
        let offset = 0;
        while (offset < data.length) {
          checkActive();
          const chunk = data.subarray(offset);
          const count =
            resource.kind !== "file"
              ? resource.write([chunk])
              : withFileOffset(resource, () => {
                  if (resource.append) {
                    const result = fs.append(resource.handle, [chunk]);
                    if (typeof result === "number") return result;
                    resource.offset = result.offset;
                    return result.written;
                  }
                  const written = fs.write(resource.handle, [chunk], resource.offset);
                  if (written > 0) resource.offset += written;
                  return written;
                });
          if (count <= 0) return false;
          offset += count;
        }
        return true;
      }
      if (stdio) return stdio[type === "stderr" ? 2 : 1].write([data]) === data.length;
      checkActive();
      const owned = data.slice();
      ctx.postMessage({ type, data: owned }, [owned.buffer]);
      return true;
    };
    subprocess = isolated
      ? new SubprocessHost({
          signalState:
            runtimeState?.signals.signalState ?? req.child?.signalState ?? req.signalState,
          outcome: outcome ?? undefined,
          defaultSignal,
          budget: req.child?.budget,
          identity: req.runtimeProcess?.identity ?? req.child?.identity ?? req.identity,
          pid: runtimeState?.pid ?? req.child?.pid ?? req.pid,
          jobId: runtimeState?.job ?? req.child?.jobId ?? req.jobId,
          workerTransport: req.child,
          slot: req.child?.slot,
          token: req.child?.token,
          stdin: req.child?.pipes[0],
          readInput:
            req.runtimeProcess || inheritedInput
              ? (capacity) => {
                  checkActive();
                  const input = wasi?.descriptors.get(0)?.resource;
                  if (!input || (input.kind !== "pipe" && input.kind !== "terminal")) return -4;
                  const bytes = new Uint8Array(capacity);
                  const count = input.tryRead?.([bytes]) ?? -8;
                  return count > 0
                    ? bytes.subarray(0, count)
                    : count === -6
                      ? -2
                      : count === -8
                        ? -3
                        : count;
                }
              : undefined,
          inheritStdinPipe: (pid) => {
            checkActive();
            const input = wasi?.descriptors.get(0)?.resource;
            return input instanceof PipeEndpoint ? input.forProcess(pid).handle() : undefined;
          },
          revoked,
          onChildClose: (pid) =>
            ctx.postMessage({
              type: "child-close",
              pid,
              parentPid: runtimeState?.pid ?? req.child?.pid ?? req.pid ?? 1,
            } satisfies WorkerMessage),
          output: (fd, data) => post(fd === 2 ? "stderr" : "stdout", data),
          launch: (meta, transport) => {
            const cwd = meta.cwd || req.env.PWD || "/";
            if (fs.lookup(cwd)?.kind !== "dir")
              throw Object.assign(new Error(`spawn: cwd does not exist: ${cwd}`), {
                code: "ENOENT",
              });
            if (!req.spawnBroker)
              throw Object.assign(new Error("spawn: this worker has no page subprocess broker"), {
                code: "ENOTSUP",
              });
            // Process ancestry is not capability ancestry: another job may outlive this parent.
            const filesystem = createFilesystemIdentity({
              ...fs.connection,
              revocations: fs.connection.revocations.slice(-1),
            });
            const request: SpawnRequest = {
              executable: meta.executable ?? meta.argv[0]!,
              argv: meta.argv,
              cwd,
              pid: transport.pid,
              parentPid: transport.parentPid,
              jobId: transport.jobId,
              job: meta.job ?? transport.jobId,
              env: { ...meta.env, PWD: cwd },
              filesystem,
              child: transport,
              trace: req.trace,
              slots: req.slots,
              spawnBroker: true,
            };
            ctx.postMessage({ type: "spawn", request } satisfies WorkerMessage);
            const control = new Int32Array(transport.control, 0, 4);
            return {
              revoke: () => {
                revokeFilesystem(filesystem);
                fs.sweep();
              },
              terminate: () => {
                Atomics.store(control, 3, 1);
              },
            };
          },
        })
      : null;
    let instance: WebAssembly.Instance;
    const processImports: Record<string, (...args: number[]) => number | void> = {
      signal: (signal, mode) => subprocess?.signal(signal!, mode!) ?? -38,
      interrupted: () => subprocess?.signal(0, 0) ?? 0,
      default_signal: defaultSignal,
    };
    let rootPreopen = 3;
    wasi = new Wasi({
      hostCallFd: HOST_CALL_FD,
      args: req.args,
      env: guestEnv(req),
      fs,
      preopens: { "/": "/" },
      stdio,
      stdout: (data) => post("stdout", data),
      stderr: (data) => post("stderr", data),
      sleep: (ms) => {
        checkActive();
        sleep(ms);
        checkActive();
      },
      interrupt: runtimeState?.signals.interrupt,
      wait: (word, expected, ms) => {
        checkActive();
        Atomics.wait(word, 0, expected, ms);
        checkActive();
      },
      namespaces: {
        runtime_proc: processImports,
        // All shell guests import this namespace. Only an interactive root owns page phase.
        shell_terminal: shellTerminalImports(
          req.terminal,
          // The interactive root receives stdio from its terminal, not transport bindings.
          req.terminal ? [0, 1, 2] : req.runtimeProcess?.bindings.map((binding) => binding.fd),
        ),
      },
      trace: req.trace ? (line) => console.debug(`[wasi] ${line}`) : undefined,
    });
    if (req.runtimeProcess) {
      const { createFilesystemDescriptorCodec } =
        await import("@bun-wasm/runtime/proc/filesystem-codec");
      const { createProcessFilesystemIdentity } = await import("@bun-wasm/runtime/fs/protocol");
      const { WorkerPipeHost } = await import("@bun-wasm/runtime/proc/worker-pipes");
      const { ProcessABI, ProcessSignalExit } = await import("@bun-wasm/runtime/proc/abi");
      const { createRuntimeTerminalCodec } = await import("./runtime-terminals");
      processSignalExit = ProcessSignalExit;
      const postMessage = (message: WorkerProcessMessage) => ctx.postMessage(message);
      const pipes = new WorkerPipeHost({
        transport: req.runtimeProcess,
        postMessage,
        pipe: runtimePipeOptions,
        fallback: createRuntimeTerminalCodec({
          fallback: createFilesystemDescriptorCodec(fs),
          descriptors: wasi.descriptors,
          output: (fd, data) => {
            post(fd === 2 ? "stderr" : "stdout", data);
          },
          checkActive,
        }),
        registry: (
          req.runtimeProcess.data as
            | {
                pipeRegistry?: import("@bun-wasm/runtime/proc/pipes").PipePublicationRegistryHandle;
              }
            | undefined
        )?.pipeRegistry,
      });
      runtimeProcess = new runtime!.WorkerProcessClient({
        transport: req.runtimeProcess,
        descriptors: wasi.descriptors,
        codec: pipes.codec(),
        postMessage,
        createPipe: () => {
          checkActive();
          return pipes.createPipe();
        },
        revokeProcess: (pid) => pipes.revokeProcess(pid),
        prepareSpawn: () => {
          checkActive();
          const end = fs.beginTransfer();
          try {
            const filesystem = createProcessFilesystemIdentity(fs.connection);
            const terminalAdmission = createTerminalAdmission();
            return {
              data: { filesystem, pipeRegistry: pipes.registry.handle(), terminalAdmission },
              codec: pipes.codec(
                createRuntimeTerminalCodec({
                  fallback: createFilesystemDescriptorCodec(fs, filesystem),
                  exportAdmission: terminalAdmission,
                }),
              ),
              release: end,
            };
          } catch (error) {
            end();
            throw error;
          }
        },
      });
      // Bound numbers and duplicate open descriptions survive without reopening pathnames.
      if (!req.terminal) {
        // A generic spawn inherits exactly its bindings, not implicit callback/EOF stdio.
        for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
      }
      rootPreopen = preserveRootPreopen(
        wasi.descriptors,
        req.runtimeProcess.bindings.map((binding) => binding.fd),
      );
      runtimeProcess.installBindings();
      const abi = new ProcessABI({
        memory: () => instance.exports.memory as WebAssembly.Memory,
        descriptors: wasi.descriptors,
        fs,
        pid: runtimeProcess.pid,
        service: runtimeProcess,
        signals: runtimeProcess.signals,
        wake: runtimeProcess.wake,
        createPipe: () => runtimeProcess!.createPipe(),
        wait: (ms, word, expected) => {
          checkActive();
          Atomics.wait(word, 0, expected, ms);
          checkActive();
        },
      });
      for (const [name, call] of Object.entries(abi.imports)) {
        processImports[name] = (...args) => {
          checkActive();
          return call(...args);
        };
      }
    }
    const instantiating = perfNow();
    const imports = wasi.imports(req.module);
    preservePreopenDiscovery(imports, wasi.descriptors, rootPreopen);
    instance = new WebAssembly.Instance(req.module, imports);
    ctx.postMessage({
      type: "phase",
      name: "instantiate",
      duration: perfNow() - instantiating,
    } satisfies WorkerMessage);
    const slots = req.adapter === "preview1" ? "off" : (req.slots ?? "imports");
    const netHost = req.net
      ? new NetHost(req.net, sendNet, (path, bytes) => fs.writeFile(path, bytes))
      : null;
    if (slots !== "off") {
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("bun-wasm has no memory");
      netHost?.attach(memory);
      subprocess?.attach(memory);
      const impls = subprocess ? subprocess.slots(netHost?.slots()) : netHost?.slots();
      if (impls && slots === "imports") wasi.hostCall = installHostSlotsViaImport(instance, impls);
      else if (impls) installHostSlots(instance, impls);
    }
    guestMemory =
      instance.exports.memory instanceof WebAssembly.Memory ? instance.exports.memory : undefined;
    checkActive();
    if (typeof instance.exports._start !== "function")
      throw new TypeError("guest has no _start entry point");
    if (!(instance.exports.memory instanceof WebAssembly.Memory))
      throw new TypeError("guest has no memory");
    started = true;
    if (req.terminal) {
      const bridge = new SharedBridge(req.terminal);
      Atomics.store(bridge.state, control.memory, instance.exports.memory.buffer.byteLength);
      Atomics.store(bridge.state, control.phase, 1);
    }
    const exited = wasi.launch(instance);
    const ready = instance.exports.bunwasm_ready as (() => number) | undefined;
    if (
      exited !== null ||
      req.adapter === "preview1" ||
      req.engine !== "browser" ||
      ready?.() !== 1
    ) {
      finish({ code: exited ?? 0 });
      return;
    }
    // Terminal unwinds from timer callbacks and promise jobs have the same typed outcome as
    // synchronous guest execution; suppress the secondary uncaught-error reporting in both paths.
    const terminalResult = (error: unknown) =>
      error instanceof WasiExit
        ? { code: error.code }
        : error instanceof DefaultSignal ||
            (processSignalExit && error instanceof processSignalExit)
          ? { code: 128 + error.signal, signal: error.signal }
          : null;
    const onError = (e: ErrorEvent) => {
      const result = terminalResult(e.error);
      if (!result) return;
      e.preventDefault();
      finish(result);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const result = terminalResult(e.reason);
      if (!result) return;
      e.preventDefault();
      finish(result);
    };
    ctx.addEventListener("error", onError);
    ctx.addEventListener("unhandledrejection", onRejection);
    // With a ring (cross-origin isolated page): the same NetHost as the wasm engines, so fetch goes
    // through the page's helper and Bun.serve gets /__preview/<port>/ connections.
    const networking = slots !== "off" ? netHost?.engineNet() : undefined;
    const net = slots !== "off" && subprocess ? subprocess.engineNet(networking) : networking;
    const nativeFetch = ctx.fetch.bind(ctx);
    const code = await startEngineHost({
      instance,
      moduleUrls: "blob",
      modules: req.moduleCache ? moduleStore(req.moduleCache) : undefined,
      fetch: (input, init) => {
        checkActive();
        return nativeFetch(input, init);
      },
      net,
      onExit: (exitCode) => finish({ code: exitCode }),
    });
    finish({ code });
  } catch (err) {
    if (err instanceof WasiExit) finish({ code: err.code });
    else if (
      err instanceof DefaultSignal ||
      (processSignalExit && err instanceof processSignalExit)
    )
      finish({ code: 128 + err.signal, signal: err.signal });
    else finish({ error: err });
  }
};
