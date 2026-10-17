// Adapted from bun-wasm web/src/shared-fs.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
import {
  FilesystemClient,
  createFilesystemConnection,
  connectFilesystemIdentity,
  revokeFilesystemService,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
  type FilesystemIdentity,
  type FilesystemConnection,
} from "@bun-wasm/runtime/fs";

export interface Entry {
  kind: "file" | "dir";
  ino: number;
  mtime: number;
  children: Map<string, Entry>;
}
/** Page-side API: never blocks the UI thread and owns no tree. Mutations complete in memory;
 * drain orders service requests, while flush checkpoints their data and metadata to storage.
 */
export class SharedFilesystem {
  readonly client: FilesystemClient;
  private worker: Worker;
  private writes: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private fatal: Error | undefined;
  constructor(options: { persistence?: boolean; name?: string } = {}) {
    this.worker = new Worker(new URL("./fs-worker.ts", import.meta.url), { type: "module" });
    const connection = createFilesystemConnection();
    this.client = new FilesystemClient(connection.client);
    this.worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.fail(new Error(`Filesystem worker failed: ${event.message || "uncaught error"}`));
    });
    this.worker.addEventListener("messageerror", () =>
      this.fail(new Error("Filesystem worker message could not be decoded")),
    );
    try {
      this.worker.postMessage(
        {
          connect: connection.server,
          persistence: options.persistence ?? true,
          name: options.name,
        },
        [connection.server.port],
      );
    } catch (error) {
      connection.server.port.close();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private fail(error: Error): void {
    this.fatal ??= error;
    // A process does not inherit its parent's lifetime. Publish the separate service-wide
    // revocation so even unpublished independent identities wake when this worker dies.
    revokeFilesystemService(this.client.connection);
    this.client.dispose();
    this.worker.terminate();
  }
  private assertLive(): void {
    if (this.fatal) throw this.fatal;
  }
  fork(): FilesystemConnection {
    this.assertLive();
    return this.client.fork();
  }
  connect(identity: FilesystemIdentity): FilesystemConnection {
    this.assertLive();
    const connection = connectFilesystemIdentity(identity);
    this.client.connection.port.postMessage({ connect: connection.server }, [
      connection.server.port,
    ]);
    return connection.client;
  }
  /** Cancellation is immediate, but terminate() does not establish worker death. */
  revoke(connection: FilesystemIdentity): void {
    revokeFilesystem(connection);
    this.client.sweep();
  }
  /** A guest exit acknowledgement or the admission fence below proves filesystem quiescence. */
  reap(connection: FilesystemIdentity): void {
    reapFilesystem(connection);
    this.client.sweep();
  }
  /** Revoke immediately, then wait for host critical sections before physical termination. */
  async quiesce(connection: FilesystemIdentity): Promise<void> {
    await waitForFilesystemQuiescence(connection);
    this.reap(connection);
  }
  private async request(operation: string, args: unknown[] = [], bytes?: Uint8Array): Promise<any> {
    this.assertLive();
    try {
      return await this.client.asyncCall(operation, args, bytes);
    } catch (error) {
      // Revocation wakes pending requests with ECANCELED. The page owns the worker's
      // actual failure, such as a refused writer lock or unavailable browser storage.
      this.assertLive();
      throw error;
    }
  }
  private mutate(operation: string, args: unknown[], bytes?: Uint8Array): Promise<any> {
    const result = this.writes.then(() => this.request(operation, args, bytes));
    // Keep ordering after an error, while returning the failure to the caller that owns it.
    this.writes = result.catch((error) => {
      this.failure ??= error;
    });
    return result;
  }
  /** Wait for this page's queued mutations, without waiting for background persistence. */
  async drain(): Promise<void> {
    await this.writes;
    this.assertLive();
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
  }
  /** A save is durable only once both data and metadata have reached storage. */
  async flush(): Promise<void> {
    await this.drain();
    await this.request("flush");
  }
  async lookup(path: string): Promise<Entry | undefined> {
    await this.drain();
    return this.request("lookup", [path]);
  }
  async readFile(path: string): Promise<Uint8Array | undefined> {
    await this.drain();
    return this.request("readFile", [path]);
  }
  async listFiles(path = "/"): Promise<string[]> {
    await this.drain();
    return this.request("listFiles", [path]);
  }
  mkdirp(path: string): Promise<void> {
    return this.mutate("mkdirp", [path]);
  }
  writeFile(path: string, text: string | Uint8Array, append = false): Promise<void> {
    return this.mutate(
      "writeFile",
      [path, append],
      typeof text === "string" ? new TextEncoder().encode(text) : text,
    );
  }
  remove(path: string): Promise<boolean> {
    return this.mutate("remove", [path]);
  }
  async move(from: string, to: string): Promise<void> {
    const error = await this.mutate("move", [from, to]);
    if (error) throw new Error(`rename failed: errno ${error}`);
  }
  dispose(): void {
    revokeFilesystemService(this.client.connection);
    this.client.dispose();
    this.worker.terminate();
  }
}
