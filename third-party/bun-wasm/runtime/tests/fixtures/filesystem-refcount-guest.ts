import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { atomicHost } from "./wasi-atomic-host";

let held: { fs: FilesystemClient; host: ReturnType<typeof atomicHost>; handle: number } | undefined;
self.onmessage = ({ data }: MessageEvent<{ connection?: FilesystemConnection; scenario: string }>) => {
  if (data.scenario === "stat") {
    try { self.postMessage({ stat: held!.fs.stat(held!.handle) }); }
    catch (error) { self.postMessage({ errno: (error as { errno: number }).errno }); }
    return;
  }
  const fs = new FilesystemClient(data.connection!);
  if (data.scenario === "readdir") {
    try {
      const root = fs.preopen("/");
      const submit = fs.submit.bind(fs);
      let inject = true;
      fs.submit = (...args) => {
        const completion = submit(...args);
        if (args[0] === "readdir" && inject) {
          inject = false;
          const wait = completion.wait.bind(completion);
          completion.wait = () => {
            const entries = wait();
            fs.call("writeFile", ["/after", false], new Uint8Array());
            return entries;
          };
        }
        return completion;
      };
      const before = fs.readdir(root).map(entry => entry.name);
      const after = fs.readdir(root).map(entry => entry.name);
      self.postMessage({ before, after });
    } finally { fs.dispose(); }
    return;
  }
  const host = atomicHost(fs);
  const operations: string[] = [];
  const submit = fs.submit.bind(fs);
  fs.submit = (...args) => { operations.push(args[0]); return submit(...args); };
  const first = host.open("shared");
  if (first.error) throw new Error(`initial path_open failed: ${first.error}`);
  if (data.scenario === "held") {
    const second = host.open("shared");
    if (second.error) throw new Error(`second path_open failed: ${second.error}`);
    host.wasi.descriptors.close(first.fd);
    const handle = (host.wasi.descriptors.get(second.fd)!.resource as { handle: number }).handle;
    held = { fs, host, handle };
    self.postMessage({ handle });
    return;
  }
  try {
    host.wasi.descriptors.close(first.fd);
    operations.length = 0;
    const errors: number[] = [];
    for (let i = 0; i < 40; i++) {
      const opened = host.open("shared");
      errors.push(opened.error);
      if (!opened.error) host.wasi.descriptors.close(opened.fd);
    }
    self.postMessage({ operations, errors, stderr: host.errors });
  } finally { host.wasi.descriptors.dispose(); fs.dispose(); }
};
