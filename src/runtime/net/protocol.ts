// Adapted from bun-wasm web/src/net/protocol.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
// Shared definitions for the networking bridge between the bun worker (guest side, NetHost) and the
// helper that does the real I/O (NetHelper: the page in the browser, a Bun worker in scripts/run.ts).
//
//   bun worker ──postMessage(NetRequest)──▶ helper      requests: fetch, close, ack, listen, write
//   bun worker ◀──SharedArrayBuffer ring──── helper      events: head, data, end, error, conn
//
// The bun worker is blocked inside synchronous wasm calls, so it can never receive a message event
// while it runs: everything flowing towards it goes through the ring (see ring.ts), and `poll` sleeps
// on the ring with Atomics.wait. Sending works fine from a blocked thread, so requests use postMessage.

/** Results of the bun_wasm host functions (docs/host-abi.md). */
export const OK = 0;
export const ERROR = -1;
export const AGAIN = -2;
export const BADF = -3;
export const UNSUPPORTED = -4;

/** Event kinds in the ring. */
export const Kind = {
  /** Fetch response head (JSON FetchHead). */
  Head: 1,
  /** Body bytes (fetch) or bytes from the peer (connection). */
  Data: 2,
  /** End of the body / peer closed its side. */
  End: 3,
  /** Failure (JSON NetError). For a fetch before its head: the fetch rejects. */
  Error: 4,
  /** New connection on a listener; the record's handle is the listener, payload JSON NewConn. */
  Conn: 5,
  /** Atomic file replacement from the editor: JSON {path,length}, zero or more byte chunks, end. */
  FileStart: 6,
  FileData: 7,
  FileEnd: 8,
  /** A file already changed in the shared filesystem: JSON {path}. Wake only; never replace bytes. */
  FileChanged: 9,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export interface FetchHead {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: [string, string][];
}

export interface NetError {
  name: string;
  message: string;
  code?: string;
}

export interface PeerAddr {
  address: string;
  port: number;
  family: "IPv4" | "IPv6";
}

export interface NewConn {
  conn: number;
  peer: PeerAddr;
}

export type NetRequest =
  | {
      type: "fetch";
      id: number;
      method: string;
      url: string;
      headers: [string, string][];
      body: Uint8Array | null;
      redirect: RequestRedirect;
    }
  /** The guest consumed `bytes` of a fetch body: the helper may send that much more. */
  | { type: "ack"; id: number; bytes: number }
  /** Abort a fetch, stop a listener, or finish a connection (its response is complete). */
  | { type: "close"; id: number }
  | { type: "listen"; id: number; port: number; host: string }
  /** Response bytes the guest wrote on a virtual connection. */
  | { type: "write"; id: number; data: Uint8Array };

/**
 * Handles are unique per process. The guest side allocates fetch and listener handles from 1 up;
 * the helper allocates connection handles from CONN_BASE up, so neither has to ask the other.
 */
export const CONN_BASE = 0x4000_0000;

/** Most body bytes the helper sends ahead of what the guest has read, per fetch. */
export const FETCH_WINDOW = 512 * 1024;

/** Largest payload of one ring record; bigger chunks are split. */
export const MAX_RECORD = 64 * 1024;
