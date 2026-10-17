// Adapted from bun-wasm web/src/net/host.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
// The bun_wasm host functions as seen from the bun worker (docs/host-abi.md).
// Everything here is synchronous and, except `poll`, never blocks: requests go out with postMessage,
// results come back through the shared ring (ring.ts), which is drained into per-handle state on
// every call.

import { memoryViews, type MemoryViews } from "@bun-wasm/runtime/core";

import {
  AGAIN,
  BADF,
  ERROR,
  Kind,
  type NetError,
  type NetRequest,
  type NewConn,
  OK,
  type PeerAddr,
  UNSUPPORTED,
} from "./protocol";
import { RingReader } from "./ring";
import { SLOT_NAMES, type SlotImpls } from "./trampoline";

/** What engine-host.js takes as `net` (see engine-host.d.ts). */
export interface EngineNet {
  natives: Record<string, (...args: never[]) => unknown>;
  caps: Record<string, boolean>;
  onNews(cb: () => void): void;
}

interface Stream {
  chunks: Uint8Array[];
  ended: boolean;
  error: NetError | null;
}

interface FetchHandle extends Stream {
  kind: "fetch";
  head: Uint8Array | null;
}

interface ListenerHandle {
  kind: "listener";
  port: number;
  pending: number[];
  error: NetError | null;
}

interface ConnHandle extends Stream {
  kind: "conn";
  port: number;
  peer: PeerAddr;
  /** For a connection between two of the guest's own handles (connect to its own listener): the other end. */
  pipe: number | null;
  writeEnded?: boolean;
}

type Handle = FetchHandle | ListenerHandle | ConnHandle;

/** Largest write accepted per call; the helper buffers it. */
const MAX_WRITE = 1 << 20;
/** Hostnames `connect` treats as this process. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);
/** `listen(…, 0)` hands out ports from here up. */
const EPHEMERAL_BASE = 49152;

const encoder = new TextEncoder();
// URL.canParse is newer than the rest of what we need (Safari 17).
const canParse = (url: string) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};
const decoder = new TextDecoder();

export class NetHost {
  private ring: RingReader;
  private memory!: MemoryViews;
  private handles = new Map<number, Handle>();
  /** Connections announced by the helper but not accepted yet (their bytes buffer here meanwhile). */
  private unaccepted = new Map<number, ConnHandle>();
  private nextHandle = 1;
  private seenGeneration: number;
  private lastError: NetError | null = null;
  /** Something changed without a ring record (a local pipe write or close): `poll` must not sleep. */
  private localNews = false;
  private fileWrite: { path: string; bytes: Uint8Array; offset: number } | null = null;

  constructor(
    sab: SharedArrayBuffer,
    private send: (msg: NetRequest, transfer?: Transferable[]) => void,
    private writeFile?: (path: string, bytes: Uint8Array) => void,
  ) {
    this.ring = new RingReader(sab);
    this.seenGeneration = this.ring.generation();
  }

  attach(memory: WebAssembly.Memory): void {
    this.memory = memoryViews(memory);
  }

  /** The slot implementations to install (no `connect`: browsers have no raw sockets). */
  slots(): SlotImpls {
    return {
      poll: (timeout) => this.poll(timeout),
      fetch: (metaPtr, metaLen, bodyPtr, bodyLen) => this.fetch(metaPtr, metaLen, bodyPtr, bodyLen),
      fetch_head: (handle, ptr, cap) => this.fetchHead(handle, ptr, cap),
      read: (handle, ptr, cap) => this.read(handle, ptr, cap),
      write: (handle, ptr, len) => this.write(handle, ptr, len),
      close: (handle) => this.close(handle),
      listen: (hostPtr, hostLen, port) => this.listen(hostPtr, hostLen, port),
      local_port: (handle) => this.localPort(handle),
      accept: (listener) => this.accept(listener),
      connect: (hostPtr, hostLen, port) => this.connect(hostPtr, hostLen, port),
      error: (handle, ptr, cap) => this.error(handle, ptr, cap),
      peer_addr: (handle, ptr, cap) => this.peerAddr(handle, ptr, cap),
      shutdown: (handle) => this.shutdown(handle),
      local_addr: (handle, ptr, cap) => {
        const text = this.localText(handle);
        return typeof text === "number" ? text : this.writeSized(encoder.encode(text), ptr, cap);
      },
    };
  }

  /**
   * The same functions for the browser engine (engine-host.js), at the level the runtime's net.js
   * calls them (`native.hostRead(handle)` and so on): strings and byte arrays instead of guest
   * memory, and `onNews` instead of a blocking `poll`.
   */
  engineNet(): EngineNet {
    const text = (result: Uint8Array | string | number) =>
      result instanceof Uint8Array ? decoder.decode(result) : result;
    return {
      natives: {
        hostPoll: () => UNSUPPORTED,
        hostFetch: (meta: string, body?: Uint8Array) =>
          this.startFetch(meta, body ? new Uint8Array(body) : null),
        hostFetchHead: (handle: number) => text(this.headOf(handle)),
        hostRead: (handle: number, cap = 65536) => this.readBytes(handle, Math.max(1, cap)),
        hostWrite: (handle: number, bytes: Uint8Array) =>
          this.writeBytes(handle, new Uint8Array(bytes)),
        hostClose: (handle: number) => this.close(handle),
        hostListen: (host: string, port: number) => this.startListen(host, port),
        hostLocalPort: (handle: number) => this.localPort(handle),
        hostAccept: (listener: number) => this.accept(listener),
        hostConnect: (host: string, port: number) => this.startConnect(host, port),
        hostError: (handle: number) => this.errorText(handle),
        hostPeerAddr: (handle: number) => this.peerText(handle),
        hostShutdown: (handle: number) => this.shutdown(handle),
        hostLocalAddr: (handle: number) => this.localText(handle),
      },
      caps: Object.fromEntries(
        SLOT_NAMES.map((name) => [name, name !== "poll" && name !== "signal"]),
      ),
      onNews: (cb) => {
        this.onNews = cb;
        this.watchRing();
      },
    };
  }

  private onNews: (() => void) | null = null;

  /** Something changed: wake a blocking `poll` (localNews) or the browser engine's loop. */
  private news(): void {
    this.localNews = true;
    if (this.onNews) queueMicrotask(this.onNews);
  }

  /** Calls onNews whenever the helper writes to the ring (Atomics.waitAsync, else a short timer). */
  private watchRing(): void {
    const seen = this.ring.generation();
    const again = () => {
      this.drain();
      if (this.ring.generation() !== seen && this.onNews) this.onNews();
      this.watchRing();
    };
    const waiting = this.ring.waitAsync(seen);
    if (waiting) waiting.then(again);
    else setTimeout(again, 4);
  }

  // ---------- slots ----------

  private poll(timeoutMs: number): number {
    this.drain();
    if (this.localNews) {
      this.localNews = false;
      return 1;
    }
    const generation = this.ring.generation();
    if (generation !== this.seenGeneration) {
      this.seenGeneration = generation;
      return 1;
    }
    if (timeoutMs === 0) return 0;
    if (this.ring.wait(generation, timeoutMs) === "timed-out") return 0;
    this.seenGeneration = this.ring.generation();
    this.drain();
    return 1;
  }

  private fetch(metaPtr: number, metaLen: number, bodyPtr: number, bodyLen: number): number {
    return this.startFetch(
      decoder.decode(this.bytes(metaPtr, metaLen)),
      bodyLen > 0 ? this.bytes(bodyPtr, bodyLen) : null,
    );
  }

  private startFetch(metaText: string, bodyBytes: Uint8Array<ArrayBuffer> | null): number {
    let meta: {
      method?: string;
      url?: string;
      headers?: [string, string][];
      redirect?: RequestRedirect;
    };
    try {
      meta = JSON.parse(metaText);
    } catch {
      return this.fail({ name: "TypeError", message: "fetch: malformed request metadata" });
    }
    const url = meta.url ?? "";
    if (!canParse(url))
      return this.fail({ name: "TypeError", message: `Failed to parse URL from ${url}` });

    const id = this.nextHandle++;
    const method = (meta.method ?? "GET").toUpperCase();
    const body =
      bodyBytes && bodyBytes.length > 0 && method !== "GET" && method !== "HEAD" ? bodyBytes : null;
    this.handles.set(id, { kind: "fetch", head: null, chunks: [], ended: false, error: null });
    this.send(
      {
        type: "fetch",
        id,
        method,
        url,
        headers: meta.headers ?? [],
        body,
        redirect: meta.redirect ?? "follow",
      },
      body ? [body.buffer] : [],
    );
    return id;
  }

  private fetchHead(handle: number, ptr: number, cap: number): number {
    const head = this.headOf(handle);
    return typeof head === "number" ? head : this.writeSized(head, ptr, cap);
  }

  private headOf(handle: number): Uint8Array | number {
    this.drain();
    const h = this.handles.get(handle);
    if (h?.kind !== "fetch") return BADF;
    if (h.head) return h.head;
    return h.error ? ERROR : AGAIN;
  }

  private read(handle: number, ptr: number, cap: number): number {
    const chunk = this.readBytes(handle, cap);
    if (typeof chunk === "number") return chunk;
    this.memory.bytes().set(chunk, ptr >>> 0);
    return chunk.length;
  }

  /** Up to `cap` bytes, or 0 at the end, or an error code. */
  private readBytes(handle: number, cap: number): Uint8Array | number {
    this.drain();
    const h = this.handles.get(handle);
    if (!h || h.kind === "listener") return BADF;
    if (h.kind === "fetch" && !h.head) return h.error ? ERROR : AGAIN;
    if (h.chunks.length > 0) {
      const chunk = this.take(h, cap);
      if (h.kind === "fetch") this.send({ type: "ack", id: handle, bytes: chunk.length });
      else if (h.pipe !== null) this.news();
      return chunk;
    }
    if (h.error) return ERROR;
    return h.ended ? 0 : AGAIN;
  }

  private write(handle: number, ptr: number, len: number): number {
    return this.writeBytes(handle, this.bytes(ptr, Math.min(len, MAX_WRITE)));
  }

  /** Queues `data` (a copy the host owns), at most MAX_WRITE bytes of it. */
  private writeBytes(handle: number, bytes: Uint8Array<ArrayBuffer>): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    if (h.kind !== "conn") return UNSUPPORTED;
    if (h.writeEnded) return ERROR;
    const n = Math.min(bytes.length, MAX_WRITE);
    if (n === 0) return 0;
    const data = n === bytes.length ? bytes : bytes.slice(0, n);
    if (h.pipe === null) {
      this.send({ type: "write", id: handle, data }, [data.buffer]);
      return n;
    }
    const other = this.connection(h.pipe);
    if (!other) {
      h.error = { name: "Error", message: "write after the other end closed", code: "EPIPE" };
      return ERROR;
    }
    const available = MAX_WRITE - other.chunks.reduce((size, chunk) => size + chunk.length, 0);
    if (available <= 0) return AGAIN;
    const count = Math.min(n, available);
    other.chunks.push(count === n ? data : data.slice(0, count));
    this.news();
    return count;
  }

  private shutdown(handle: number): number {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    if (h.writeEnded) return OK;
    h.writeEnded = true;
    if (h.pipe === null) this.send({ type: "close", id: handle });
    else {
      const peer = this.connection(h.pipe);
      if (peer) peer.ended = true;
      this.news();
    }
    return OK;
  }

  private localText(handle: number): string | number {
    const h = this.handles.get(handle);
    if (!h || h.kind === "fetch") return BADF;
    const family = h.kind === "conn" ? h.peer.family : "IPv4";
    return JSON.stringify({
      address: family === "IPv4" ? "127.0.0.1" : "::1",
      family,
      port: h.port,
    });
  }

  private close(handle: number): number {
    const h = this.handles.get(handle);
    if (!h) return BADF;
    this.handles.delete(handle);
    if (h.kind === "listener") {
      for (const conn of h.pending) this.closeUnaccepted(conn);
    }
    if (h.kind === "conn" && h.pipe !== null) {
      const other = this.connection(h.pipe);
      if (other) other.ended = true;
      this.news();
      return OK;
    }
    this.send({ type: "close", id: handle });
    return OK;
  }

  private listen(hostPtr: number, hostLen: number, port: number): number {
    return this.startListen(decoder.decode(this.bytes(hostPtr, hostLen)), port);
  }

  private startListen(hostname: string, port: number): number {
    const host = hostname || "0.0.0.0";
    const inUse = new Set<number>();
    for (const h of this.handles.values()) if (h.kind === "listener") inUse.add(h.port);
    if (port === 0) {
      port = EPHEMERAL_BASE;
      while (inUse.has(port)) port++;
    }
    if (port < 0 || port > 65535)
      return this.fail({ name: "RangeError", message: `port out of range: ${port}` });
    if (inUse.has(port)) {
      return this.fail({
        name: "Error",
        message: `Failed to start server. Is port ${port} in use?`,
        code: "EADDRINUSE",
      });
    }
    const id = this.nextHandle++;
    this.handles.set(id, { kind: "listener", port, pending: [], error: null });
    this.send({ type: "listen", id, port, host });
    return id;
  }

  /**
   * Browsers have no TCP. A connection to one of the guest's own listeners is a local pipe between
   * two handles; anything else is unsupported.
   */
  private connect(hostPtr: number, hostLen: number, port: number): number {
    return this.startConnect(decoder.decode(this.bytes(hostPtr, hostLen)), port);
  }

  private startConnect(host: string, port: number): number {
    const listener = Array.from(this.handles.entries()).find(
      ([, h]) => h.kind === "listener" && h.port === port,
    );
    if (LOOPBACK.has(host) && (!listener || listener[1].kind !== "listener")) {
      return this.fail({
        name: "Error",
        message: `connect ECONNREFUSED ${host}:${port}`,
        code: "ECONNREFUSED",
      });
    }
    if (!LOOPBACK.has(host)) {
      this.lastError = {
        name: "Error",
        message: `connect ${host}:${port}: TCP connections are not available in the browser`,
        code: "ENOTSUP",
      };
      return UNSUPPORTED;
    }
    if (!listener || listener[1].kind !== "listener") return BADF;
    const state = listener[1];
    const client = this.nextHandle++;
    const server = this.nextHandle++;
    const clientPort = EPHEMERAL_BASE + 10000 + (client % 5000);
    const stream = (): Stream => ({ chunks: [], ended: false, error: null });
    this.handles.set(client, {
      kind: "conn",
      port: clientPort,
      peer: { address: "127.0.0.1", port, family: "IPv4" },
      pipe: server,
      ...stream(),
    });
    this.unaccepted.set(server, {
      kind: "conn",
      port,
      peer: { address: "127.0.0.1", port: clientPort, family: "IPv4" },
      pipe: client,
      ...stream(),
    });
    state.pending.push(server);
    this.news();
    return client;
  }

  private connection(handle: number): ConnHandle | undefined {
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    return h?.kind === "conn" ? h : undefined;
  }

  private localPort(handle: number): number {
    const h = this.handles.get(handle);
    if (!h || h.kind === "fetch") return BADF;
    return h.port;
  }

  private accept(listener: number): number {
    this.drain();
    const h = this.handles.get(listener);
    if (h?.kind !== "listener") return BADF;
    const conn = h.pending.shift();
    if (conn === undefined) return AGAIN;
    const state = this.unaccepted.get(conn);
    if (!state) return AGAIN;
    this.unaccepted.delete(conn);
    this.handles.set(conn, state);
    return conn;
  }

  private error(handle: number, ptr: number, cap: number): number {
    const text = this.errorText(handle);
    return typeof text === "number" ? text : this.writeSized(encoder.encode(text), ptr, cap);
  }

  private errorText(handle: number): string | number {
    const err = handle === 0 ? this.lastError : (this.handles.get(handle)?.error ?? null);
    if (handle !== 0 && !this.handles.has(handle)) return BADF;
    return JSON.stringify(err ?? { name: "Error", message: "no error" });
  }

  private peerAddr(handle: number, ptr: number, cap: number): number {
    const text = this.peerText(handle);
    return typeof text === "number" ? text : this.writeSized(encoder.encode(text), ptr, cap);
  }

  private peerText(handle: number): string | number {
    const h = this.handles.get(handle);
    if (h?.kind !== "conn") return BADF;
    return JSON.stringify(h.peer);
  }

  // ---------- events from the helper ----------

  private drain(): void {
    for (const { handle, kind, payload } of this.ring.drain()) this.dispatch(handle, kind, payload);
  }

  private dispatch(handle: number, kind: number, payload: Uint8Array): void {
    if (kind === Kind.FileChanged) {
      const meta: unknown = JSON.parse(decoder.decode(payload));
      if (
        !meta ||
        typeof meta !== "object" ||
        !("path" in meta) ||
        typeof meta.path !== "string" ||
        !meta.path.startsWith("/") ||
        meta.path.includes("\0")
      )
        throw new TypeError("Invalid file change notification");
      // HMR polls file contents. The completed shared-FS write is already visible; wake
      // the guest to inspect it without replaying stale bytes through writeFile.
      this.news();
      return;
    }
    if (kind === Kind.FileStart || kind === Kind.FileData || kind === Kind.FileEnd) {
      this.receiveFile(kind, payload);
      return;
    }
    if (kind === Kind.Conn) {
      this.onConn(handle, payload);
      return;
    }
    // Events for handles the guest already closed are dropped.
    const h = this.handles.get(handle) ?? this.unaccepted.get(handle);
    if (!h || h.kind === "listener") return;
    if (kind === Kind.Head && h.kind === "fetch") h.head = payload;
    else if (kind === Kind.Data) h.chunks.push(payload);
    else if (kind === Kind.End) h.ended = true;
    else if (kind === Kind.Error) h.error = JSON.parse(decoder.decode(payload)) as NetError;
  }

  private receiveFile(kind: number, payload: Uint8Array): void {
    if (kind === Kind.FileStart) {
      const meta: unknown = JSON.parse(decoder.decode(payload));
      if (!meta || typeof meta !== "object" || !("path" in meta) || !("length" in meta))
        throw new TypeError("Invalid file update");
      if (
        typeof meta.path !== "string" ||
        !meta.path.startsWith("/") ||
        typeof meta.length !== "number" ||
        !Number.isSafeInteger(meta.length) ||
        meta.length < 0
      )
        throw new TypeError("Invalid file update metadata");
      this.fileWrite = { path: meta.path, bytes: new Uint8Array(meta.length), offset: 0 };
      return;
    }
    const pending = this.fileWrite;
    if (!pending) throw new Error("File update has no start record");
    if (kind === Kind.FileData) {
      if (pending.offset + payload.length > pending.bytes.length)
        throw new Error("File update exceeds its declared size");
      pending.bytes.set(payload, pending.offset);
      pending.offset += payload.length;
      return;
    }
    this.fileWrite = null;
    if (pending.offset !== pending.bytes.length) throw new Error("Incomplete file update");
    this.writeFile?.(pending.path, pending.bytes);
  }

  private onConn(listener: number, payload: Uint8Array): void {
    const { conn, peer } = JSON.parse(decoder.decode(payload)) as NewConn;
    const h = this.handles.get(listener);
    if (h?.kind !== "listener") {
      // The listener closed before the connection arrived: refuse it.
      this.send({ type: "close", id: conn });
      return;
    }
    this.unaccepted.set(conn, {
      kind: "conn",
      port: h.port,
      peer,
      pipe: null,
      chunks: [],
      ended: false,
      error: null,
    });
    h.pending.push(conn);
  }

  private closeUnaccepted(conn: number): void {
    this.unaccepted.delete(conn);
    this.send({ type: "close", id: conn });
  }

  // ---------- memory ----------

  /** A copy of guest memory [ptr, ptr+len). */
  private bytes(ptr: number, len: number): Uint8Array<ArrayBuffer> {
    return this.memory.bytes().slice(ptr >>> 0, (ptr >>> 0) + len);
  }

  /** The `fetch_head` length protocol: write when it fits, return the full length either way. */
  private writeSized(data: Uint8Array, ptr: number, cap: number): number {
    if (data.length <= cap) this.memory.bytes().set(data, ptr >>> 0);
    return data.length;
  }

  /** Takes up to `cap` buffered bytes. */
  private take(stream: Stream, cap: number): Uint8Array {
    let size = 0;
    for (const chunk of stream.chunks) {
      size += chunk.length;
      if (size >= cap) break;
    }
    const out = new Uint8Array(Math.min(size, cap));
    let n = 0;
    while (n < out.length) {
      const chunk = stream.chunks[0]!;
      const count = Math.min(out.length - n, chunk.length);
      out.set(chunk.subarray(0, count), n);
      n += count;
      if (count === chunk.length) stream.chunks.shift();
      else stream.chunks[0] = chunk.subarray(count);
    }
    return out;
  }

  private fail(err: NetError): number {
    this.lastError = err;
    return ERROR;
  }
}
