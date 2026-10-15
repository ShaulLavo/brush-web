import { MemFS } from "../third-party/bun-wasm/fs";
import { filesystemChanges } from "../third-party/bun-wasm/subprocess-fs";
import { Wasi, compactFs } from "../third-party/bun-wasm/wasi";
import { installHostSlotsViaImport } from "../third-party/bun-wasm/net/trampoline";
import { ProcessPipe, ProcessOutput, finishProcess } from "./process-transport";
import type { ChildRequest } from "./process-protocol";
import { pipeStdio } from "./process-wasi";

self.onmessage = (event: MessageEvent<ChildRequest>) => {
  const request = event.data;
  const fs = new MemFS(request.root);
  const initial = structuredClone(fs.root);
  const stdin = new ProcessPipe(request.transport.stdin);
  const output = new ProcessOutput(request.transport.output);
  const sleep = new Int32Array(request.transport.state, 0, 4);
  const pause = (ms: number) => {
    if (ms > 0) Atomics.wait(sleep, 3, 0, ms);
  };
  try {
    const wasi = new Wasi({
      args: request.argv,
      env: { ...request.env, PWD: request.cwd },
      fs,
      preopens: { "/": "/" },
      stdin: (capacity) => stdin.readBlocking(capacity),
      stdout: (bytes) => output.writeAll(1, bytes),
      stderr: (bytes) => output.writeAll(2, bytes),
      sleep: pause,
    });
    const imports = wasi.imports(request.module);
    let memory: WebAssembly.Memory | undefined;
    pipeStdio(imports, () => {
      if (!memory) throw new Error("Child memory is unavailable");
      return memory;
    });
    const instance = new WebAssembly.Instance(request.module, imports);
    const exportedMemory = instance.exports.memory;
    if (!(exportedMemory instanceof WebAssembly.Memory)) throw new Error("Child has no memory");
    memory = exportedMemory;
    wasi.hostCall = installHostSlotsViaImport(instance, {
      poll: (ms) => {
        pause(ms);
        return 0;
      },
    });
    const status = wasi.start(instance);
    compactFs(fs.root);
    finishProcess(request.transport, status, filesystemChanges(initial, fs.root));
  } catch (error) {
    output.writeAll(2, new TextEncoder().encode(`External command failed: ${String(error)}\n`));
    finishProcess(request.transport, 1);
  }
};
