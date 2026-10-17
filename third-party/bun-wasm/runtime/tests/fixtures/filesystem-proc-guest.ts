import { DescriptorTable } from "../../core/descriptors";
import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { ProcessABI } from "../../proc/abi";
import { outcomeWord } from "../../proc/outcome";
import { createSignalState } from "../../proc/signals";

self.onmessage = ({ data }: MessageEvent<{ connection: FilesystemConnection }>) => {
  const fs = new FilesystemClient(data.connection);
  const descriptors = new DescriptorTable();
  try {
    const root = fs.preopen("/");
    const path = fs.resolve(root, "file");
    if (typeof path === "number" || path.node === undefined) throw new Error("missing cold fixture");
    fs.retain(path.node);
    fs.call = () => { throw new Error("runtime_proc made a blocking filesystem RPC"); };
    const memory = new WebAssembly.Memory({ initial: 1 });
    const fd = descriptors.open({ kind: "file", handle: path.node, offset: 0, append: false }, (1n << 29n) - 1n, 0n);
    const unused = (): never => { throw new Error("unexpected process service call"); };
    const wake = new Int32Array(data.connection.signal);
    let blocked = false;
    const abi = new ProcessABI({ memory, descriptors, fs, pid: 1,
      service: { spawn: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused },
      signals: { signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)), requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord() },
      wake,
      wait(milliseconds) {
        if (!blocked) { blocked = true; self.postMessage({ phase: "blocked" }); }
        Atomics.wait(wake, 0, Atomics.load(wake, 0), milliseconds);
      },
    });
    const read = abi.imports.read!(fd, 4096, 4);
    const file = descriptors.get(fd)!.resource;
    const beforeOffset = file.kind === "file" ? file.offset : -1;
    self.postMessage({ phase: "before-poll", read, offset: beforeOffset });
    const view = new DataView(memory.buffer);
    view.setUint32(256, 0, true); view.setUint32(260, fd, true); view.setBigUint64(264, 77n, true);
    const ready = abi.imports.poll!(256, 1, 5000, 512);
    const count = abi.imports.read!(fd, 4096, 4);
    self.postMessage({ phase: "done", ready, count, bytes: Array.from(new Uint8Array(memory.buffer, 4096, 4)), userdata: view.getBigUint64(512, true) });
  } finally { descriptors.dispose(); fs.dispose(); }
};
