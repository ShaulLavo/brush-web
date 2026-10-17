import { fatalInterrupt } from "../../interrupt/check";
import { Wasi } from "../../core/wasi";
import { MemFS } from "../../fs/memory";
import { InterruptWord, type InterruptShape } from "./interrupt-browser-loops";

export type InterruptWorkerRequest =
  | { kind: "loop"; module: WebAssembly.Module; memory: WebAssembly.Memory; shape: InterruptShape; interrupt: Int32Array; outcome: BigInt64Array }
  | { kind: "bun-build"; module: WebAssembly.Module; interrupt: Int32Array };
export interface BunBuildSample { ms: number; code: number; outputBytes: number; checksum: number; stdout: string; stderr: string; }
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = ({ data }: MessageEvent<InterruptWorkerRequest>) => {
  if (data.kind === "loop") {
    const words = new Int32Array(data.memory.buffer);
    try {
      const instance = new WebAssembly.Instance(data.module, { env: { memory: data.memory },
        runtime_proc: { interrupted: () => fatalInterrupt(data.outcome) },
      });
      scope.postMessage({ kind: "running" });
      (instance.exports[data.shape] as () => void)();
      Atomics.store(words, InterruptWord.returned, 1);
      scope.postMessage({ kind: "returned" });
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        Atomics.store(words, InterruptWord.trapped, 1);
        scope.postMessage({ kind: "trapped", error: String(error), rescue: Atomics.load(words, InterruptWord.rescue) });
      } else scope.postMessage({ kind: "error", error: String(error) });
    }
    return;
  }
  try {
    const fs = new MemFS(); fs.mkdirp("/work"); fs.mkdirp("/tmp");
    const source = Array.from({ length: 2500 }, (_, index) => `export const value${index}: number = ${index};`).join("\n");
    fs.writeFile("/work/main.ts", new TextEncoder().encode(source));
    let stdout = "", stderr = "";
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const interrupted = () => Atomics.load(data.interrupt, 0);
    const wasi = new Wasi({ args: ["bun", "build", "/work/main.ts", "--outfile", "/work/out.js"],
      env: { PWD: "/work", HOME: "/work", TMPDIR: "/tmp", NO_COLOR: "1" }, fs, preopens: { "/": "/" },
      namespaces: { runtime_proc: { interrupted }, __interrupt: { interrupted } },
      sleep: ms => { Atomics.wait(sleeper, 0, 0, ms); },
      stdout: bytes => { stdout += new TextDecoder().decode(bytes); }, stderr: bytes => { stderr += new TextDecoder().decode(bytes); },
    });
    const instance = new WebAssembly.Instance(data.module, wasi.imports(data.module));
    const started = performance.now(), code = wasi.start(instance), ms = performance.now() - started;
    const output = fs.readFile("/work/out.js");
    if (!output) throw new Error("Bun build produced no output");
    let checksum = 0;
    for (const byte of output) checksum = (Math.imul(checksum, 31) + byte) | 0;
    scope.postMessage({ kind: "built", ms, code, outputBytes: output.length, checksum, stdout, stderr } satisfies BunBuildSample & { kind: string });
  } catch (error) { scope.postMessage({ kind: "error", error: error instanceof Error ? error.stack : String(error) }); }
};
