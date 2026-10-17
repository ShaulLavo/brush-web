import { OpenDescription } from "../core/descriptors";
import { PipeController, PipeEndpoint, PipePublicationRegistry, attachPipeController, attachPipeEndpoint, attachPipePublicationRegistry, type PipeEndpointHandle, type PipeOptions, type PipePublicationRegistryHandle } from "./pipes";
import { workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "./worker-client";

export interface WorkerPipeDescriptorToken {
  kind: "pipe";
  endpoint: PipeEndpointHandle;
}
export function isWorkerPipeDescriptorToken(token: unknown): token is WorkerPipeDescriptorToken {
  return typeof token === "object" && token !== null && "kind" in token && token.kind === "pipe";
}
export interface WorkerPipeCodecOptions {
  /** Filesystem and terminal resources remain owned by their own transfer adapters. */
  fallback?: WorkerDescriptorCodec;
  /** Controller imports register the shared pipe with their one responsive relay owner. */
  onPipe?(handle: PipeEndpointHandle): void;
}

/** An endpoint token transfers its retained lifetime, rather than cloning a new reference on
 * import. The page's proxy and the guest therefore close the same lifetime idempotently.
 */
export function createWorkerPipeCodec(options: WorkerPipeCodecOptions = {}): WorkerDescriptorCodec {
  return {
    export(descriptor, pid): unknown {
      if (!(descriptor.resource instanceof PipeEndpoint)) {
        if (options.fallback) return options.fallback.export(descriptor, pid);
        throw new TypeError(`unsupported worker descriptor: ${descriptor.resource.kind}`);
      }
      // This is the synchronous spawn ownership boundary. Parent closure after export cannot
      // remove this child's endpoint, including before its worker or supervisor chunk starts.
      const endpoint = descriptor.resource.forProcess(pid);
      return { kind: "pipe", endpoint: endpoint.handle() } satisfies WorkerPipeDescriptorToken;
    },
    import(token, pid): OpenDescription {
      if (!isWorkerPipeDescriptorToken(token)) {
        if (options.fallback) return options.fallback.import(token, pid);
        throw new TypeError("unsupported worker descriptor token");
      }
      if (token.endpoint.pid !== pid) throw new TypeError("pipe descriptor belongs to another process");
      options.onPipe?.(token.endpoint);
      const endpoint = attachPipeEndpoint(token.endpoint);
      return new OpenDescription(endpoint, () => endpoint.close());
    },
    discard(token): void {
      if (isWorkerPipeDescriptorToken(token)) attachPipeEndpoint(token.endpoint).close();
      else if (options.fallback) options.fallback.discard(token);
      else throw new TypeError("unsupported worker descriptor token");
    },
  };
}

export interface WorkerPipeHostOptions {
  transport: WorkerProcessTransport;
  postMessage(message: WorkerProcessMessage): void;
  /** Descendants attach the root service's registry; only the root creates a new one. */
  registry?: PipePublicationRegistry | PipePublicationRegistryHandle;
  fallback?: WorkerDescriptorCodec;
  pipe?: Pick<PipeOptions, "capacity" | "maxWriters" | "maxReaders">;
}

/** Guest-worker factory and codec composition, separate from the pipe-free ownership stub.
 * A manual controller has no background relay loop and can be garbage-collected after export.
 * Do not dispose it on creator exit: independent descendants may still hold its endpoints.
 */
export class WorkerPipeHost {
  readonly registry: PipePublicationRegistry;
  private readonly pid: number;
  constructor(private readonly options: WorkerPipeHostOptions) {
    const state = workerProcessState(options.transport);
    this.pid = state.pid;
    this.registry = options.registry instanceof PipePublicationRegistry ? options.registry
      : options.registry ? attachPipePublicationRegistry(options.registry)
      : new PipePublicationRegistry({ wake: state.wake });
  }
  codec(fallback: WorkerDescriptorCodec | undefined = this.options.fallback): WorkerDescriptorCodec {
    return createWorkerPipeCodec({ fallback });
  }
  createPipe(): readonly [PipeEndpoint, PipeEndpoint] {
    const controller = new PipeController({ ...this.options.pipe, registry: this.registry, relay: "manual" });
    let reader: PipeEndpoint | undefined, writer: PipeEndpoint | undefined;
    try {
      reader = controller.retain(this.pid, "read");
      writer = controller.retain(this.pid, "write");
      // Publish before returning endpoints to guest code. No guest-created MessageChannel or
      // page reply lies on this synchronous path; the page alone starts the relay loop.
      this.options.postMessage({ type: "runtime-proc", operation: "pipe", transport: this.options.transport, handle: reader.handle() });
      return [reader, writer];
    } catch (error) {
      reader?.close(); writer?.close(); controller.dispose();
      throw error;
    }
  }
  /** Host capability, not a guest ABI: call only after process/job authority and default action
   * selection. It freezes even cursors on descendant-created pipes the page has not seen yet.
   */
  revokeProcess(pid: number): void { this.registry.revoke(pid); }
}

export interface WorkerPipeBrokerOptions {
  /** Production owns an automatic relay; manual mode supports an embedding's shared pump. */
  relay?: "auto" | "manual";
}
/** One controller per pipe, identified across structured-cloned SAB wrappers by its stable id. */
export class WorkerPipeBroker {
  private readonly controllers = new Map<string, PipeController>();
  private disposed = false;
  constructor(private readonly options: WorkerPipeBrokerOptions = {}) {}
  get size(): number { return this.controllers.size; }
  attach(handle: PipeEndpointHandle): PipeController {
    if (this.disposed) throw new Error("worker pipe broker is disposed");
    const existing = this.controllers.get(handle.id);
    if (existing) return existing;
    // Register before starting: an already-closed delayed announcement can synchronously
    // report closure as its automatic relay starts, without leaving a stale map entry.
    let controller: PipeController | undefined;
    controller = attachPipeController(handle, { relay: "manual", onClosed: () => {
      if (controller) this.retire(handle.id, controller);
    } });
    this.controllers.set(handle.id, controller);
    if (controller.closed) this.retire(handle.id, controller);
    else if (this.options.relay !== "manual") controller.startRelay();
    return controller;
  }
  codec(fallback?: WorkerDescriptorCodec): WorkerDescriptorCodec {
    return createWorkerPipeCodec({ fallback, onPipe: handle => { this.attach(handle); } });
  }
  pump(): void {
    for (const [id, controller] of this.controllers) {
      controller.pumpRelay();
      this.retire(id, controller);
    }
  }
  private retire(id: string, controller: PipeController): void {
    // EOF is not terminal: readers may still drain committed bytes, and inherited child
    // endpoints outlive their creator. Only the shared all-references-closed state retires.
    if (!controller.closed || this.controllers.get(id) !== controller) return;
    this.controllers.delete(id);
    controller.dispose();
  }
  /** Embeddings stop their task's consumers first. Disposing a shared pipe while a background
   * descendant still uses it would revoke that independent process's endpoints as well.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.dispose();
    this.controllers.clear();
  }
}
