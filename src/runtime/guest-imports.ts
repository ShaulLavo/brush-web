// Original adapter helpers: the guest fd namespace and root-only shell phase ownership.
import type { DescriptorTable } from "@bun-wasm/runtime/core";
import { SharedBridge, control } from "../bridge";

/** Preserve the real root directory outside all incoming bindings. The lowest free descriptor
 * avoids a sparse scan proportional to an arbitrary inherited descriptor such as fd 1000000. */
export function preserveRootPreopen(table: DescriptorTable, inherited: readonly number[]): number {
  const root = table.get(3);
  if (!root || root.resource.kind !== "directory" || root.preopen !== "/")
    throw new Error("WASI root preopen is missing");
  const occupied = new Set(inherited);
  if (!occupied.has(3)) return 3;
  let fd = 4;
  while (occupied.has(fd) || table.get(fd)) fd++;
  table.inherit(fd, root);
  table.get(fd)!.preopen = root.preopen;
  table.close(3);
  return fd;
}
/** An occupied terminal/file/pipe is not a directory preopen, but is not a bad descriptor.
 * Report NOTSUP rather than inventing preopen metadata on an inherited binding. Discovery
 * must skip it: wasi-libc's contiguous-only scan instead exits 71 and needs a guest-side fix.
 * The first absent fd after the preopen still returns BADF. */
export function preservePreopenDiscovery(
  imports: WebAssembly.Imports,
  table: DescriptorTable,
  preopen: number,
): void {
  const wasi = imports.wasi_snapshot_preview1;
  const original = wasi?.fd_prestat_get;
  if (typeof original !== "function") return;
  wasi!.fd_prestat_get = (fd: number, ptr: number) => {
    if (fd >= 3 && fd < preopen && table.get(fd)?.preopen === undefined) return 58;
    return original(fd, ptr);
  };
}
export function shellTerminalImports(buffer?: SharedArrayBuffer) {
  return {
    columns() {
      return buffer ? Math.max(2, Atomics.load(new SharedBridge(buffer).state, control.cols)) : 80;
    },
    phase(phase: number) {
      if (!buffer) return;
      const bridge = new SharedBridge(buffer);
      if (!bridge.closed() && (phase === 1 || phase === 2))
        Atomics.store(bridge.state, control.phase, phase);
    },
  };
}
