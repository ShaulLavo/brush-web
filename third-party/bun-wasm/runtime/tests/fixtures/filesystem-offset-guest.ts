import { DescriptorTable } from "../../core/descriptors";
import { withFileOffset } from "../../core/open-file";
import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { createFilesystemDescriptorCodec, type FilesystemDescriptorToken } from "../../proc/filesystem-codec";

self.onmessage = ({ data }: MessageEvent<{ connection: FilesystemConnection; token: FilesystemDescriptorToken; count: number; start: SharedArrayBuffer; crash?: boolean }>) => {
  const client = new FilesystemClient(data.connection);
  const table = new DescriptorTable();
  const description = createFilesystemDescriptorCodec(client).import(data.token, 2);
  table.add(description, { rightsBase: 1n, rightsInheriting: 0n });
  const file = description.resource;
  if (file.kind !== "file") throw new Error("expected regular file");
  const start = new Int32Array(data.start);
  Atomics.store(start, 0, 1); Atomics.notify(start, 0);
  if (data.crash) {
    withFileOffset(file, () => {
      self.postMessage({ locked: true });
      // Termination deliberately abandons the offset lock and admission count.
      for (;;) Atomics.wait(start, 1, 0);
    });
    return;
  }
  while (!Atomics.load(start, 1)) Atomics.wait(start, 1, 0);
  const bytes = new Uint8Array([67]);
  for (let i = 0; i < data.count; i++) {
    const result = withFileOffset(file, () => {
      const written = client.write(file.handle, [bytes], file.offset);
      if (written >= 0) file.offset += written;
      return written;
    });
    if (result !== 1) throw new Error(`write failed: ${result}`);
  }
  self.postMessage({ offset: file.offset });
  // The controller owns transferred descriptor cleanup in this fixture.
  self.close();
};
