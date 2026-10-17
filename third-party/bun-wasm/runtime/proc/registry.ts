export interface Executable {
  /** The loader compiles asynchronously (normally in a compiler worker). Never instantiate here. */
  module: WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>);
  /** Opaque guest adapter key, interpreted by the host's worker launcher, not the registry. */
  adapter: string;
}
export interface ResolvedExecutable { readonly module: WebAssembly.Module; readonly adapter: string }
export class ExecutableNotFound extends Error {
  constructor(name: string) { super(`executable not found: ${name}`); this.name = "ExecutableNotFound"; }
}
/** Generic names -> compiled module + adapter, with one compilation per module source.
 * Instances and used workers are deliberately not cached.
 */
export class ExecutableRegistry {
  private readonly entries = new Map<string, Readonly<Executable>>();
  private readonly modules = new WeakMap<Executable["module"], Promise<WebAssembly.Module>>();
  register(name: string, executable: Executable): void {
    if (!name || !executable.adapter) throw new TypeError("executable and adapter names are required");
    this.entries.set(name, Object.freeze({ ...executable }));
  }
  unregister(name: string): boolean { return this.entries.delete(name); }
  has(name: string): boolean { return this.entries.has(name); }
  async resolve(name: string): Promise<ResolvedExecutable> {
    const entry = this.entries.get(name);
    if (!entry) throw new ExecutableNotFound(name);
    let pending = this.modules.get(entry.module);
    if (!pending) {
      pending = Promise.resolve().then(() => typeof entry.module === "function" ? entry.module() : entry.module).then(module => {
        if (!(module instanceof WebAssembly.Module)) throw new TypeError("executable loader did not return a compiled WebAssembly.Module");
        return module;
      });
      this.modules.set(entry.module, pending);
    }
    return { module: await pending, adapter: entry.adapter };
  }
}
