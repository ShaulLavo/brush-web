import { FilesystemClient, type FilesystemConnection } from "../../fs";

let cached: { fs: FilesystemClient; handle: number; root: number } | undefined;
function snapshot(offset = 0, length = 8) {
  if (!cached) throw new Error("cache fixture is not initialized");
  const path = cached.fs.resolve(cached.root, "cached");
  if (typeof path === "number" || path.node !== cached.handle) throw new Error("cache resolved the wrong identity");
  const bytes = new Uint8Array(length);
  const count = cached.fs.read(cached.handle, [bytes], offset);
  return { stat: cached.fs.stat(cached.handle), count, bytes: Array.from(bytes) };
}

self.onmessage = async event => {
  const input = event.data as FilesystemConnection | { scenario: string; connection: FilesystemConnection; offset?: number; length?: number };
  if ("scenario" in input && input.scenario === "snapshot") {
    self.postMessage(snapshot(input.offset, input.length));
    return;
  }
  if ("scenario" in input && input.scenario === "race-truncate") {
    if (!cached) throw new Error("cache fixture is not initialized");
    const { fs, handle } = cached;
    const internal = fs as unknown as { version(): number };
    const original = internal.version;
    let versions = 0;
    internal.version = () => {
      if (++versions === 2 && fs.resize(handle, 0, true) !== 0) throw new Error("truncate failed");
      return original.call(fs);
    };
    try {
      const bytes = new Uint8Array(8).fill(77);
      const count = fs.read(handle, [bytes], 0);
      self.postMessage({ count, bytes: Array.from(bytes) });
    } finally { internal.version = original; }
    return;
  }
  if ("scenario" in input && input.scenario === "churn") {
    if (!cached) throw new Error("cache fixture is not initialized");
    for (let i = 0; i < 300; i++) cached.fs.call("resolve", [cached.root, `transient-${i}`]);
    self.postMessage({ churned: 300 });
    return;
  }
  const fs = new FilesystemClient("scenario" in input ? input.connection : input);
  if ("scenario" in input && input.scenario === "service-crash") {
    try { fs.call("readFile", ["/blocked"]); self.postMessage({ unexpectedCompletion: true }); }
    catch (error) { self.postMessage({ errno: (error as { errno: number }).errno }); }
    finally { fs.dispose(); }
    return;
  }
  if ("scenario" in input && (input.scenario === "cache" || input.scenario === "path-cache")) {
    const root = fs.preopen("/");
    fs.retain(root);
    const path = fs.resolve(root, "cached");
    if (typeof path === "number" || path.node === undefined) throw new Error("missing cache fixture");
    if (input.scenario === "cache") fs.retain(path.node);
    cached = { fs, handle: path.node, root };
    self.postMessage(snapshot());
    return;
  }
  if ("scenario" in input && input.scenario === "inflight") {
    const root = fs.preopen("/");
    fs.retain(root);
    const path = fs.resolve(root, "held");
    if (typeof path === "number" || path.node === undefined) throw new Error("missing held fixture");
    fs.retain(path.node);
    const request = fs.submit("read", [path.node, 8, 0]);
    self.postMessage({ submitted: request.id });
    // The parent kills this actual worker while the backend has this request gated.
    await request.value();
    self.postMessage({ unexpectedCompletion: true });
    return;
  }
  try {
    fs.writeFile("/file", "before");
    const root = fs.preopen("/");
    const resolved = fs.resolve(root, "file");
    if (typeof resolved === "number" || resolved.node === undefined) throw new Error("missing file");
    fs.retain(resolved.node);
    const bytes = new Uint8Array(6);
    fs.read(resolved.node, [bytes], 0);
    const original = new TextDecoder().decode(bytes);
    fs.write(resolved.node, [new TextEncoder().encode("after!")], 0);
    fs.read(resolved.node, [bytes], 0);
    self.postMessage({ missing: fs.resolve(root, "missing/child"), escape: fs.resolve(root, ".."), invalidRead: fs.read(999999, [bytes], 0), invalidResize: fs.resize(999999, 0, true), original, changed: new TextDecoder().decode(bytes) });
  } finally { fs.dispose(); }
};
