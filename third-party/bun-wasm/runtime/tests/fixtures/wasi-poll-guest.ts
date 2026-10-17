import { parentPort, workerData } from "node:worker_threads";
import { Wasi } from "../../core/wasi";
import { MemFS } from "../../fs/memory";
import { attachPipeEndpoint, type PipeEndpointHandle } from "../../proc/pipes";

const { endpoint } = workerData as { endpoint: PipeEndpointHandle };
const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {},
  sleep() { throw new Error("preview1 used timed polling instead of its pipe notification"); },
  wait(word, expected, milliseconds) {
    parentPort!.postMessage({ phase: "waiting", milliseconds });
    Atomics.wait(word, 0, expected, milliseconds);
  },
});
const memory = new WebAssembly.Memory({ initial: 1 });
wasi.start({ exports: { memory, _start() {} } } as unknown as WebAssembly.Instance);
// The parent owns this borrowed endpoint reference and closes it after this worker stops.
const fd = wasi.descriptors.open(attachPipeEndpoint(endpoint), (1n << 29n) - 1n, 0n);
const view = new DataView(memory.buffer);
view.setBigUint64(0, 77n, true); view.setUint8(8, 1); view.setUint32(16, fd, true);
const functions = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions();
const poll = functions.poll_oneoff!(0, 1024, 1, 2048);
view.setUint32(64, 4096, true); view.setUint32(68, 2, true);
const read = functions.fd_read!(fd, 64, 1, 80);
parentPort!.postMessage({ phase: "done", poll, events: view.getUint32(2048, true), userdata: view.getBigUint64(1024, true), read,
  bytes: Array.from(new Uint8Array(memory.buffer, 4096, view.getUint32(80, true))),
});
