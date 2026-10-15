import {
  AGAIN,
  ProcessPipe,
  ProcessOutput,
  createTransport,
  cancelProcess,
} from "./process-transport";
import { decodeSpawn, type SpawnRequest, type ProcessSample } from "./process-protocol";
import { applyFilesystemChanges, snapshotFilesystem } from "./process-filesystem";
import type { BrowserHost } from "./wasi-host";

type Child = {
  request: SpawnRequest;
  stdin: ProcessPipe;
  output: ProcessOutput;
  terminal: boolean;
  pending: Uint8Array;
  startedAt: number;
  firstOutputAt: number;
};
export class ProcessHost {
  private child: Child | undefined;
  private nextId = 0;
  constructor(private readonly host: BrowserHost) {}
  imports(memory: () => WebAssembly.Memory) {
    return {
      process_spawn: (ptr: number, length: number, terminal: number) => {
        if (this.child) return -1;
        const startedAt = performance.timeOrigin + performance.now();
        try {
          const meta = decodeSpawn(new Uint8Array(memory().buffer, ptr, length));
          const transport = createTransport();
          const request: SpawnRequest = {
            kind: "external-spawn",
            ...meta,
            transport,
            root: snapshotFilesystem(this.host.root.dir),
          };
          this.child = {
            request,
            stdin: new ProcessPipe(transport.stdin),
            output: new ProcessOutput(transport.output),
            terminal: Boolean(terminal),
            pending: new Uint8Array(),
            startedAt,
            firstOutputAt: 0,
          };
          self.postMessage(request);
          return ++this.nextId;
        } catch (error) {
          if (this.child) cancelProcess(this.child.request.transport);
          this.child = undefined;
          this.host.write(new TextEncoder().encode(`Cannot spawn command: ${String(error)}\n`));
          return -1;
        }
      },
      process_read: (id: number, ptr: number, length: number, fdPtr: number) => {
        const child = this.get(id);
        const chunk = child.output.read(length);
        if (typeof chunk === "number") return chunk;
        if (!child.firstOutputAt) child.firstOutputAt = performance.timeOrigin + performance.now();
        new Uint8Array(memory().buffer, ptr, chunk.bytes.length).set(chunk.bytes);
        new DataView(memory().buffer).setUint32(fdPtr, chunk.fd, true);
        return chunk.bytes.length;
      },
      process_write: (id: number, ptr: number, length: number) =>
        this.get(id).stdin.write(new Uint8Array(memory().buffer, ptr, length)),
      process_stdin_close: (id: number) => this.get(id).stdin.close(),
      process_wait: (id: number) => this.wait(this.get(id)),
      process_pause: (id: number) => {
        const child = this.get(id);
        this.input(child);
        Atomics.wait(new Int32Array(child.request.transport.state), 0, 0, 4);
      },
      process_close: (id: number) => {
        const child = this.get(id);
        self.postMessage({
          kind: "external-complete",
          executable: child.request.executable,
          startedAt: child.startedAt,
          firstOutputAt: child.firstOutputAt,
          finishedAt: performance.timeOrigin + performance.now(),
        } satisfies ProcessSample);
        cancelProcess(child.request.transport);
        this.child = undefined;
      },
    };
  }
  private get(id: number) {
    if (!this.child || id !== this.nextId) throw new Error("Invalid child handle");
    return this.child;
  }
  private input(child: Child) {
    if (!child.terminal) return;
    if (!child.pending.length) {
      const bytes = this.host.pollStdin();
      if (!bytes) return;
      if (!bytes.length) {
        child.stdin.close();
        child.terminal = false;
        return;
      }
      child.pending = bytes;
    }
    const written = child.stdin.write(child.pending);
    if (written > 0) child.pending = child.pending.subarray(written);
  }
  private wait(child: Child) {
    const state = new Int32Array(child.request.transport.state, 0, 4);
    if (!Atomics.load(state, 0) || !child.output.drained) return AGAIN;
    const length = Atomics.exchange(state, 2, 0);
    if (length) {
      const changes = new TextDecoder().decode(
        new Uint8Array(child.request.transport.state, 16, length).slice(),
      );
      try {
        applyFilesystemChanges(this.host.root.dir, changes);
        this.host.filesystemChanged();
      } catch (error) {
        this.host.write(new TextEncoder().encode(`Cannot merge child files: ${String(error)}\n`));
        return 1;
      }
    }
    return Atomics.load(state, 1) & 255;
  }
}
