import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { PAGE } from "../../fs/protocol";
import { atomicHost } from "./wasi-atomic-host";

let run: (() => void) | undefined;
self.onmessage = event => {
  if (event.data === "write") { run!(); return; }
  const { connection, byte, scenario, exclusive } = event.data as { connection: FilesystemConnection; byte: number; scenario?: string; exclusive?: boolean };
  const fs = new FilesystemClient(connection);
  const host = atomicHost(fs);
  if (scenario === "create") {
    try { self.postMessage({ ...host.open("raced", exclusive ? 5 : 1), errors: host.errors }); }
    finally { host.wasi.descriptors.dispose(); fs.dispose(); }
    return;
  }
  if (scenario === "killwrite" || scenario === "epochwrite") {
    const opened = host.open("shared");
    if (opened.error) throw new Error(`open failed: ${opened.error}`);
    host.iovecs([new Uint8Array([90])]);
    const original = fs.shared.directWrite.bind(fs.shared);
    fs.shared.directWrite = (...args) => {
      // The write timestamps the file while both of its locks are held: park there.
      const now = Date.now;
      Date.now = () => {
        Date.now = now;
        self.postMessage({ writing: true, owner: Atomics.load(fs.shared.cells, 1) });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario === "epochwrite" ? 80 : undefined);
        return now();
      };
      try { return original(...args); } finally { Date.now = now; }
    };
    host.calls.fd_write!(opened.fd, 0, 1, 1024);
    if (scenario === "epochwrite") { host.wasi.descriptors.dispose(); fs.dispose(); return; }
    throw new Error("parked writer unexpectedly returned");
  }
  if (scenario === "enospc") {
    try {
      const opened = host.open("shared");
      if (opened.error) throw new Error(`open failed: ${opened.error}`);
      host.iovecs([new Uint8Array(PAGE + 20).fill(90)]);
      const error = host.calls.fd_write!(opened.fd, 0, 1, 1024);
      self.postMessage({ error, errors: host.errors });
    } finally { host.wasi.descriptors.dispose(); fs.dispose(); }
    return;
  }
  const opened = host.open("shared", 0, 1);
  if (opened.error) throw new Error(`open failed: ${opened.error}`);
  const chunks = [new Uint8Array(PAGE + 7).fill(byte), new Uint8Array(13).fill(byte)];
  host.iovecs(chunks);
  run = () => {
    try {
      self.postMessage({ writing: true });
      const error = host.calls.fd_write!(opened.fd, 0, chunks.length, 1024);
      self.postMessage({ error, written: host.view().getUint32(1024, true), offset: host.tell(opened.fd), errors: host.errors });
    } finally { host.wasi.descriptors.dispose(); fs.dispose(); }
  };
  self.postMessage({ ready: true });
};
