// Adapted from bun-wasm web/src/buffer-transfer.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
const clone = globalThis.structuredClone.bind(globalThis);
const memoryBuffers = new WeakSet<object>();
const memoryPrototype = WebAssembly.Memory.prototype;
const descriptor = Object.getOwnPropertyDescriptor(memoryPrototype, "buffer");
const getBuffer = descriptor?.get;
if (!descriptor || !getBuffer) throw new Error("Missing WebAssembly memory buffer getter");
Object.defineProperty(memoryPrototype, "buffer", {
  ...descriptor,
  get() {
    const buffer: unknown = getBuffer.call(this);
    if (buffer !== null && typeof buffer === "object") memoryBuffers.add(buffer);
    return buffer;
  },
});

export function transferArrayBuffers(buffers: ArrayBuffer[]) {
  for (const buffer of buffers) {
    if (memoryBuffers.has(buffer))
      throw new DOMException("WebAssembly memory is not transferable", "DataCloneError");
    new Uint8Array(buffer);
  }
  clone(undefined, { transfer: buffers });
}
