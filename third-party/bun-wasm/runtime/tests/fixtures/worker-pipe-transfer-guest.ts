import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "../../core/descriptors";
import type { PipePublicationRegistryHandle } from "../../proc/pipes";
import type { WorkerProcessTransport } from "../../proc/worker-client";
import { WorkerPipeHost } from "../../proc/worker-pipes";

const { transport, registry, iterations } = workerData as {
  transport: WorkerProcessTransport;
  registry: PipePublicationRegistryHandle;
  iterations: number;
};
const port = parentPort!;
const host = new WorkerPipeHost({ transport, registry, postMessage: message => port.postMessage(message),
  pipe: { capacity: 64, maxReaders: 4, maxWriters: 4 },
});
const codec = host.codec();
try {
  for (let sequence = 0; sequence < iterations; sequence++) {
    const descriptors = new DescriptorTable();
    let reader: ReturnType<WorkerPipeHost["createPipe"]>[0] | undefined;
    let writer: ReturnType<WorkerPipeHost["createPipe"]>[1] | undefined;
    let token: unknown;
    let published = false;
    try {
      [reader, writer] = host.createPipe();
      const fd = descriptors.open(reader, 3n, 3n);
      token = codec.export(descriptors.get(fd)!, 1);
      const expected = `child pipe ${sequence}`;
      const bytes = new TextEncoder().encode(expected);
      if (writer.tryWrite([bytes]) !== bytes.length) throw new Error("child pipe write failed");
      descriptors.close(fd);
      writer.close();
      const acknowledged = new Promise<void>((resolve, reject) => {
        port.once("message", message => message.sequence === sequence ? resolve() : reject(new Error("wrong pipe acknowledgement")));
      });
      port.postMessage({ phase: "transfer", sequence, token, expected });
      published = true;
      await acknowledged;
    } finally {
      descriptors.dispose(); reader?.close(); writer?.close();
      if (token && !published) codec.discard(token);
    }
  }
  port.postMessage({ phase: "done", iterations });
} catch (error) {
  port.postMessage({ phase: "failed", error: String(error) });
} finally {
  port.close();
}
