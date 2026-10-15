import { cancelProcess, finishProcess, ProcessOutput } from "./process-transport";
import type { ChildRequest, SpawnRequest } from "./process-protocol";
import { wasiPrograms } from "./wasi-programs";

type Child = { request: SpawnRequest; worker?: Worker };
export class ProcessBroker {
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();
  private readonly children = new Set<Child>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly controller = new AbortController();
  constructor(private readonly programs: Readonly<Record<string, string>> = wasiPrograms) {}
  async spawn(request: SpawnRequest) {
    const asset = this.programs[request.executable];
    if (this.disposed) return;
    if (!asset) {
      finishProcess(request.transport, 126);
      return;
    }
    const child: Child = { request };
    this.children.add(child);
    this.watch();
    try {
      let module = this.modules.get(asset);
      if (!module) {
        module = this.compile(asset);
        this.modules.set(asset, module);
        void module.catch(() => this.modules.delete(asset));
      }
      const compiled = await module;
      if (!this.children.has(child)) return;
      const worker = new Worker(new URL("./process.worker.ts", import.meta.url), {
        type: "module",
      });
      child.worker = worker;
      worker.addEventListener("error", () => finishProcess(request.transport, 1));
      worker.addEventListener("messageerror", () => finishProcess(request.transport, 1));
      worker.postMessage({ ...request, module: compiled } satisfies ChildRequest);
    } catch (error) {
      new ProcessOutput(request.transport.output).writeAll(
        2,
        new TextEncoder().encode(`Cannot load external command: ${String(error)}\n`),
      );
      finishProcess(request.transport, 126);
    }
  }
  dispose() {
    this.disposed = true;
    this.controller.abort();
    clearTimeout(this.timer);
    for (const child of this.children) {
      cancelProcess(child.request.transport);
      child.worker?.terminate();
    }
    this.children.clear();
    this.modules.clear();
  }
  private async compile(asset: string) {
    const response = await fetch(new URL(asset, document.baseURI), {
      signal: this.controller.signal,
    });
    if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
    return WebAssembly.compileStreaming(response);
  }
  private watch() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const child of this.children) this.reap(child);
      if (this.children.size) this.watch();
    }, 4);
  }
  private reap(child: Child) {
    const state = new Int32Array(child.request.transport.state, 0, 4);
    if (!Atomics.load(state, 0) && !Atomics.load(state, 3)) return;
    child.worker?.terminate();
    this.children.delete(child);
  }
}
