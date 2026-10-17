import { FilesystemService, MemoryBackend, type FilesystemConnection } from "../../fs";

class GatedBackend extends MemoryBackend {
  execute(operation: string, args: any[], data: Uint8Array): unknown {
    if (operation === "readFile" && args[0] === "/blocked") {
      self.postMessage({ inflight: true });
      // This fixture is terminated while execute is pending. No guest response can wake callers.
      return new Promise(() => {});
    }
    return super.execute(operation, args, data);
  }
}
const service = new FilesystemService(new GatedBackend());
self.onmessage = ({ data }: MessageEvent<{ connect: FilesystemConnection }>) => {
  service.connect(data.connect);
  self.postMessage({ connected: true });
};
