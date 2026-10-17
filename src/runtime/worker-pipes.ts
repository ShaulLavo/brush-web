// Adapted from bun-wasm web/src/worker-pipes.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
import { SharedPipe } from "./subprocess";
import type { ChildTransport, SpawnMeta } from "./subprocess";

export function workerBuffers(meta: SpawnMeta) {
  if (!meta.worker) return [];
  return [new SharedArrayBuffer(16 + (1 << 20)), new SharedArrayBuffer(16 + (1 << 20))];
}

export class InheritedWorkerPipes {
  private readonly pipes: [SharedPipe, SharedPipe] | null;
  constructor(transport?: ChildTransport) {
    this.pipes =
      transport && transport.pipes.length === 5
        ? [
            new SharedPipe(transport.pipes[3], transport.budget),
            new SharedPipe(transport.pipes[4], transport.budget),
          ]
        : null;
  }
  get active() {
    return this.pipes !== null;
  }
  // Selector 3 belongs to final-signal metadata, not the first worker pipe at buffer index 3.
  handle(fd: number) {
    return this.pipes && (fd === 4 || fd === 5) ? 0x7fff0000 + fd : -3;
  }
  owns(handle: number) {
    return this.pipes !== null && (handle === 0x7fff0004 || handle === 0x7fff0005);
  }
  read(handle: number, capacity?: number) {
    return handle === 0x7fff0004 ? (this.pipes?.[0].read(capacity) ?? -3) : -3;
  }
  write(handle: number, bytes: Uint8Array) {
    return handle === 0x7fff0005 ? (this.pipes?.[1].write(bytes) ?? -3) : -3;
  }
  close(handle: number) {
    if (!this.owns(handle)) return -3;
    this.pipes?.[handle === 0x7fff0004 ? 0 : 1].close();
    return 0;
  }
}
