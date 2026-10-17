export interface MemoryViews {
  bytes(): Uint8Array;
  view(): DataView;
  range(ptr: number, length: number): Uint8Array;
}
export function memoryViews(memory: WebAssembly.Memory): MemoryViews;
