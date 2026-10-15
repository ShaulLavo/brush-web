export function pipeStdio(imports: WebAssembly.Imports, memory: () => WebAssembly.Memory) {
  const wasi = imports.wasi_snapshot_preview1;
  if (!wasi) return;
  patchStat(wasi, "fd_fdstat_get", 0, memory);
  patchStat(wasi, "fd_filestat_get", 16, memory);
}
function patchStat(
  imports: WebAssembly.ModuleImports,
  name: string,
  typeOffset: number,
  memory: () => WebAssembly.Memory,
) {
  const operation = imports[name];
  if (typeof operation !== "function") return;
  imports[name] = (fd: number, ptr: number) => {
    const status: unknown = operation(fd, ptr);
    if (typeof status !== "number") throw new Error("Invalid WASI stat result");
    if (status === 0 && fd >= 0 && fd <= 2)
      new DataView(memory().buffer).setUint8(ptr + typeOffset, 0);
    return status;
  };
}
