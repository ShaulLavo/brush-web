import { rewriteInterrupts } from "./rewriter";

/** Content-addressed, process-independent modules. Instances always get fresh countdown globals.
 * The shared content cache is bounded. Active executable registries separately retain their
 * resolved modules for their own lifetime, so repeated spawns never recompile a registration.
 * No filesystem authority or process signal state is captured by a cached module.
 */
export class InterruptModuleCache {
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();
  private readonly capacity: number;
  constructor(capacity = 16) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("interrupt module cache capacity must be a positive integer");
    this.capacity = capacity;
  }

  async compile(source: Uint8Array): Promise<WebAssembly.Module> {
    // Hash and rewrite the same owned snapshot, including when callers mutate a borrowed view
    // during the asynchronous digest. A view's unrelated backing-buffer bytes are never hashed.
    const bytes = new Uint8Array(source);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    let pending = this.modules.get(hash);
    if (pending) {
      this.modules.delete(hash);
      this.modules.set(hash, pending);
      return pending;
    }
    // Publish the promise before rewriting begins, so concurrent loads share all expensive work.
    pending = Promise.resolve().then(() => WebAssembly.compile(rewriteInterrupts(bytes)));
    this.modules.set(hash, pending);
    if (this.modules.size > this.capacity) this.modules.delete(this.modules.keys().next().value!);
    try { return await pending; }
    catch (error) {
      if (this.modules.get(hash) === pending) this.modules.delete(hash);
      throw error;
    }
  }
}

const modules = new InterruptModuleCache();
/** Called lazily by the executable loader, not on the synchronous spawn path. */
export function compileInterruptible(bytes: Uint8Array): Promise<WebAssembly.Module> {
  return modules.compile(bytes);
}
