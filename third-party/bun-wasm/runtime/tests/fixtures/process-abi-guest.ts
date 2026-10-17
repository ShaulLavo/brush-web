import { parentPort, workerData } from "node:worker_threads";
import { ProcessABI, type ProcessService } from "../../proc/abi";
import { attachPipeEndpoint, type PipeEndpointHandle } from "../../proc/pipes";
import type { SignalTransport } from "../../proc/signals";
import { DescriptorTable } from "../../core/descriptors";
import { MemFS } from "../../fs/memory";

const { endpoint, module, pid, signals } = workerData as {
  endpoint: PipeEndpointHandle; module: WebAssembly.Module; pid: number; signals: SignalTransport;
};
const descriptors = new DescriptorTable();
const memory = new WebAssembly.Memory({ initial: 1 });
descriptors.open(attachPipeEndpoint(endpoint), (1n << 1n) | (1n << 27n), 0n);
const unused = (): never => { throw new Error("unexpected process service call"); };
const service: ProcessService = { spawn: unused, waitJob: unused, jobEmpty: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused };
const abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid, service, signals, wake: endpoint.wake,
  wait(milliseconds, word, expected) {
    parentPort!.postMessage({ phase: "blocked" });
    Atomics.wait(word, 0, expected, milliseconds);
  },
});
const guest = new WebAssembly.Instance(module, { env: { memory }, runtime_proc: abi.imports });
const imports = guest.exports as Record<string, (...args: number[]) => number>;
const view = new DataView(memory.buffer);
view.setUint32(256, 0, true); view.setUint32(260, 0, true); view.setBigUint64(264, 77n, true);
const read = imports.read!(0, 4096, 1);
parentPort!.postMessage({ phase: "before-poll", read });
const ready = imports.poll!(256, 1, -1, 512);
const count = imports.read!(0, 4096, 1);
parentPort!.postMessage({ phase: "done", ready, count, byte: new Uint8Array(memory.buffer)[4096], userdata: view.getBigUint64(512, true) });
// Borrowed transfer of the parent's one endpoint reference: parent owns close after worker exit.
