import { FilesystemClient } from "../../fs/client";
import type { FilesystemConnection } from "../../fs/protocol";

declare const self: Worker;
self.onmessage = ({ data }: MessageEvent<{ connection: FilesystemConnection; control: SharedArrayBuffer }>) => {
  const client = new FilesystemClient(data.connection);
  const control = new Int32Array(data.control);
  client.retain(0);
  const now = Date.now;
  // directWrite calls this after copying the bytes, but before its last timestamp writes and
  // both unlocks. This pauses a real host operation already past its revocation check.
  Date.now = () => {
    Date.now = now;
    self.postMessage({ held: true });
    Atomics.wait(control, 0, 0);
    return now();
  };
  const written = client.write(0, [new Uint8Array([90])], 0);
  const late = client.write(0, [new Uint8Array([91])], 0);
  self.postMessage({ written, late });
};
