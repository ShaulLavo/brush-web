import { expose } from "comlink";
import { SharedBridge, control } from "./bridge";
import { BrowserHost } from "./wasi-host";
import { ExecutionProfile } from "./execution-profile";
import type { Engine } from "./session";
export type WorkerControl = {
  initialize(
    buffer: SharedArrayBuffer,
    engine: Engine,
    wasmUrl: string,
    baselineState: "isolated" | "carry",
    profileBuffer?: SharedArrayBuffer,
  ): Promise<{ wasmBytes: number }>;
};
const api: WorkerControl = {
  async initialize(buffer, engine, wasmUrl, baselineState, profileBuffer) {
    const bridge = new SharedBridge(buffer);
    const profile = profileBuffer ? new ExecutionProfile(profileBuffer) : undefined;
    if (engine === "just-bash") {
      if (typeof Atomics.waitAsync !== "function")
        throw new Error(
          "The just-bash adapter needs Atomics.waitAsync. Use a current Chromium browser or select Brush.",
        );
      const { startBaseline } = await import("./baseline");
      setTimeout(() => {
        void startBaseline(bridge, { state: baselineState }, profile).catch((error) => {
          Atomics.store(bridge.state, control.phase, 4);
          setTimeout(() => {
            throw error;
          }, 0);
        });
      }, 0);
      return { wasmBytes: 0 };
    }
    const host = new BrowserHost(bridge, profile);
    const response = await fetch(wasmUrl);
    if (!response.ok)
      throw new Error(`Brush WASM fetch failed (${response.status}). Run npm run build:wasm.`);
    const wasmBytes = Number(response.headers.get("content-length") ?? 0);
    const module = await WebAssembly.compileStreaming(response);
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: host.wasi.wasiImport,
      browser: host.imports,
    });
    const memory = instance.exports.memory;
    const start = instance.exports._start;
    const scalarWidth = instance.exports.browser_scalar_width;
    if (
      !(memory instanceof WebAssembly.Memory) ||
      typeof start !== "function" ||
      typeof scalarWidth !== "function"
    )
      throw new Error("Brush WASM exports are invalid");
    host.attach(memory, (codepoint) => {
      const width: unknown = scalarWidth(codepoint);
      if (typeof width !== "number" || !Number.isInteger(width) || width < 0 || width > 2)
        throw new Error("WASM text width is invalid");
      return width;
    });
    setTimeout(() => {
      try {
        const status = host.wasi.start({ exports: { memory, _start: () => start() } });
        Atomics.store(bridge.state, control.status, status);
        Atomics.store(bridge.state, control.phase, 3);
      } catch (error) {
        Atomics.store(bridge.state, control.phase, 4);
        throw error;
      }
    }, 0);
    return { wasmBytes };
  },
};
expose(api);
