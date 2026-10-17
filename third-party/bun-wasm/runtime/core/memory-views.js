const hosts = new WeakMap();

export function memoryViews(memory) {
  const existing = hosts.get(memory);
  if (existing) return existing;
  let views;
  if (typeof memory.toResizableBuffer === "function") {
    try {
      // This also returns a growable SharedArrayBuffer for shared wasm memories.
      const buffer = memory.toResizableBuffer();
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      views = { bytes: () => bytes, view: () => view };
    } catch {
      // Some hosts expose the conversion but reject it for this memory.
    }
  }
  if (!views) {
    let buffer;
    let bytes;
    let view;
    const refresh = () => {
      const current = memory.buffer;
      // Compare identity, not length: grow(0) can detach an unshared fixed buffer.
      if (current === buffer) return;
      buffer = current;
      bytes = new Uint8Array(buffer);
      view = new DataView(buffer);
    };
    views = {
      bytes: () => { refresh(); return bytes; },
      view: () => { refresh(); return view; },
    };
  }
  // Bounded views still need their own range and must reject invalid guest pointers.
  views.range = (ptr, length) => new Uint8Array(memory.buffer, ptr, length);
  hosts.set(memory, views);
  return views;
}
