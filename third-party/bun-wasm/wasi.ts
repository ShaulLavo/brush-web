// A small WASI preview1 (wasi_snapshot_preview1) implementation over MemFS.
// Runs inside the worker. Synchronous by design: bun.wasm calls in, we answer from memory.

import { type DirNode, type FileNode, type Node, MemFS, basename, dirname, newDir, newFile, normalize } from "./fs";
import { HOST_CALL_FD } from "./net/trampoline";

// errno
const SUCCESS = 0;
const EBADF = 8;
const EEXIST = 20;
const EINVAL = 28;
const EIO = 29;
const EISDIR = 31;
const ENOENT = 44;
const ENOSYS = 52;
const ENOTDIR = 54;
const ENOTEMPTY = 55;
const ENOTSUP = 58;
const EPERM = 63;
const ESPIPE = 70;

// filetype
const FT_CHAR = 2;
const FT_DIR = 3;
const FT_FILE = 4;

// oflags / fdflags
const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;
const FDFLAG_APPEND = 1;

const RIGHTS_ALL = (1n << 29n) - 1n;
const RIGHT_FD_SEEK = 1n << 2n;
const RIGHT_FD_TELL = 1n << 5n;
// wasi-libc's isatty(): character device without seek/tell rights.
const RIGHTS_TTY = RIGHTS_ALL & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL);

const CLOCK_REALTIME = 0;
const SUBCLOCK_ABSTIME = 1;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTRWFLAGS_HANGUP = 1;

export class WasiExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

type Fd =
  | { type: "stdio"; which: 0 | 1 | 2 }
  | { type: "dir"; node: DirNode; path: string; preopen?: string }
  | { type: "file"; node: FileNode; path: string; pos: number; append: boolean };

export interface WasiOptions {
  args: string[];
  env: Record<string, string>;
  fs: MemFS;
  /** Preopened directories: guest name -> absolute path in `fs`. */
  preopens: Record<string, string>;
  /** Optional blocking stdin for subprocess pipes; absent means EOF. */
  stdin?(cap: number): Uint8Array | number;
  stdout(data: Uint8Array): void;
  stderr(data: Uint8Array): void;
  /** Blocks the calling thread for `ms` milliseconds. */
  sleep(ms: number): void;
  trace?: (line: string) => void;
}

// The host's own clock and RNG, taken before anything runs: the browser engine (engine-host.js)
// replaces globalThis.performance and crypto with the runtime's polyfills, which call back into
// bun.wasm, which calls clock_time_get / random_get here.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const perfNow = performance.now.bind(performance);
const timeOrigin = performance.timeOrigin;
const getRandomValues = crypto.getRandomValues.bind(crypto);

function nowNs(clock: number): bigint {
  if (clock === CLOCK_REALTIME) {
    const ms = timeOrigin + perfNow();
    return BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.round((ms % 1) * 1e6));
  }
  return BigInt(Math.round(perfNow() * 1e6));
}

function msToNs(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 1_000_000n;
}

/** Grow a file's buffer geometrically so many small writes stay linear. */
function ensureSize(node: FileNode, size: number): void {
  if (size <= node.data.length) return;
  const buffer = node.data.buffer as ArrayBuffer;
  if (node.data.byteOffset === 0 && buffer.byteLength >= size) {
    node.data = new Uint8Array(buffer, 0, size);
    return;
  }
  const grown = new Uint8Array(Math.max(size, node.data.length * 2, 64));
  grown.set(node.data);
  node.data = grown.subarray(0, size);
}

/** Drop spare capacity before the tree is cloned back to the main thread. */
export function compactFs(root: DirNode): void {
  for (const child of root.children.values()) {
    if (child.kind === "dir") compactFs(child);
    else if (child.data.byteLength !== child.data.buffer.byteLength) child.data = child.data.slice();
  }
}

export class Wasi {
  private memory!: WebAssembly.Memory;
  /**
   * Host-ABI calls the guest makes through `sock_send` on HOST_CALL_FD (net/trampoline.ts,
   * installHostSlotsViaImport): `(slot, [a, b, c, d]) -> result`.
   */
  hostCall: ((slot: number, args: number[]) => number) | null = null;
  private fds = new Map<number, Fd>();
  private nextFd = 0;
  private args: Uint8Array[];
  private env: Uint8Array[];

  private readStdin(iovecs: Uint8Array[]): number {
    if (!this.opts.stdin) return 0;
    const size = iovecs.reduce((n, chunk) => n + chunk.length, 0);
    const bytes = this.opts.stdin(size);
    if (typeof bytes === "number") return 0;
    let at = 0;
    for (const chunk of iovecs) {
      const n = Math.min(chunk.length, bytes.length - at);
      chunk.set(bytes.subarray(at, at + n));
      at += n;
    }
    return at;
  }

  constructor(private opts: WasiOptions) {
    this.args = opts.args.map((a) => encoder.encode(`${a}\0`));
    this.env = Object.entries(opts.env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));
    this.fds.set(0, { type: "stdio", which: 0 });
    this.fds.set(1, { type: "stdio", which: 1 });
    this.fds.set(2, { type: "stdio", which: 2 });
    this.nextFd = 3;
    for (const [name, path] of Object.entries(opts.preopens)) {
      const node = opts.fs.mkdirp(path);
      this.fds.set(this.nextFd++, { type: "dir", node, path: normalize(path), preopen: name });
    }
  }

  /** Runs `_start`; returns the exit code. */
  start(instance: WebAssembly.Instance): number {
    return this.launch(instance) ?? 0;
  }

  /** Runs `_start`; returns the `proc_exit` code, or null when `_start` returned without exiting. */
  launch(instance: WebAssembly.Instance): number | null {
    this.memory = instance.exports.memory as WebAssembly.Memory;
    try {
      (instance.exports._start as () => void)();
      return null;
    } catch (err) {
      if (err instanceof WasiExit) return err.code;
      throw err;
    }
  }

  /** Import object for `module`: our preview1 functions plus ENOSYS stubs for anything else it imports. */
  imports(module: WebAssembly.Module): WebAssembly.Imports {
    const impl = this.functions();
    const out: Record<string, Record<string, WebAssembly.ImportValue>> = {};
    const warned = new Set<string>();
    for (const imp of WebAssembly.Module.imports(module)) {
      const ns = (out[imp.module] ??= {});
      if (imp.kind !== "function") continue;
      const fn = imp.module === "wasi_snapshot_preview1" ? impl[imp.name] : undefined;
      if (fn) {
        ns[imp.name] = this.wrap(imp.name, fn);
        continue;
      }
      const key = `${imp.module}.${imp.name}`;
      ns[imp.name] = () => {
        if (!warned.has(key)) {
          warned.add(key);
          this.opts.stderr(encoder.encode(`[wasi] unimplemented import ${key}\n`));
        }
        return ENOSYS;
      };
    }
    return out;
  }

  /** Names of the preview1 functions this shim implements. */
  static implemented(): string[] {
    return Object.keys(new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {} }).functions()).sort();
  }

  private wrap(name: string, fn: (...args: never[]) => number | void) {
    const trace = this.opts.trace;
    return (...args: never[]) => {
      try {
        const result = fn(...args);
        if (trace) trace(`${name}(${args.join(", ")}) = ${result}`);
        return result;
      } catch (err) {
        if (err instanceof WasiExit) throw err;
        this.opts.stderr(encoder.encode(`[wasi] ${name} failed: ${String(err)}\n`));
        return EIO;
      }
    };
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  private str(ptr: number, len: number): string {
    return decoder.decode(this.bytes().slice(ptr, ptr + len));
  }

  private iovecs(ptr: number, count: number): Uint8Array[] {
    const view = this.view();
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const buf = view.getUint32(ptr + i * 8, true);
      const len = view.getUint32(ptr + i * 8 + 4, true);
      out.push(new Uint8Array(this.memory.buffer, buf, len));
    }
    return out;
  }

  private resolve(dirfd: number, ptr: number, len: number): string | number {
    const dir = this.fds.get(dirfd);
    if (!dir) return EBADF;
    if (dir.type !== "dir") return ENOTDIR;
    return normalize(this.str(ptr, len), dir.path);
  }

  private parentOf(path: string): DirNode | number {
    const parent = this.opts.fs.lookup(dirname(path));
    if (!parent) return ENOENT;
    if (parent.kind !== "dir") return ENOTDIR;
    return parent;
  }

  private writeFilestat(ptr: number, node: Node | null): void {
    const view = this.view();
    const times = node ? msToNs(node.mtime) : 0n;
    view.setBigUint64(ptr, 0n, true); // dev
    view.setBigUint64(ptr + 8, BigInt(node?.ino ?? 0), true);
    view.setUint8(ptr + 16, node ? (node.kind === "dir" ? FT_DIR : FT_FILE) : FT_CHAR);
    view.setBigUint64(ptr + 24, 1n, true); // nlink
    view.setBigUint64(ptr + 32, BigInt(node?.kind === "file" ? node.data.length : 0), true);
    view.setBigUint64(ptr + 40, times, true);
    view.setBigUint64(ptr + 48, times, true);
    view.setBigUint64(ptr + 56, times, true);
  }

  private writeOut(fd: Fd & { type: "file" }, chunks: Uint8Array[], at: number | null): number {
    let pos = at ?? (fd.append ? fd.node.data.length : fd.pos);
    let written = 0;
    for (const chunk of chunks) {
      ensureSize(fd.node, pos + chunk.length);
      fd.node.data.set(chunk, pos);
      pos += chunk.length;
      written += chunk.length;
    }
    if (at === null) fd.pos = pos;
    fd.node.mtime = Date.now();
    return written;
  }

  private readIn(fd: Fd & { type: "file" }, chunks: Uint8Array[], at: number | null): number {
    let pos = at ?? fd.pos;
    let read = 0;
    for (const chunk of chunks) {
      const n = Math.max(0, Math.min(chunk.length, fd.node.data.length - pos));
      chunk.set(fd.node.data.subarray(pos, pos + n));
      pos += n;
      read += n;
      if (n < chunk.length) break;
    }
    if (at === null) fd.pos = pos;
    return read;
  }

  private functions(): Record<string, (...args: never[]) => number | void> {
    const fs = this.opts.fs;
    const sizes = (list: Uint8Array[], countPtr: number, sizePtr: number) => {
      const view = this.view();
      view.setUint32(countPtr, list.length, true);
      view.setUint32(sizePtr, list.reduce((n, a) => n + a.length, 0), true);
      return SUCCESS;
    };
    const fill = (list: Uint8Array[], ptrs: number, buf: number) => {
      const view = this.view();
      const mem = this.bytes();
      list.forEach((item, i) => {
        view.setUint32(ptrs + i * 4, buf, true);
        mem.set(item, buf);
        buf += item.length;
      });
      return SUCCESS;
    };

    return {
      args_sizes_get: (countPtr: number, sizePtr: number) => sizes(this.args, countPtr, sizePtr),
      args_get: (argv: number, buf: number) => fill(this.args, argv, buf),
      environ_sizes_get: (countPtr: number, sizePtr: number) => sizes(this.env, countPtr, sizePtr),
      environ_get: (environ: number, buf: number) => fill(this.env, environ, buf),

      clock_res_get: (_id: number, ptr: number) => {
        this.view().setBigUint64(ptr, 1000n, true);
        return SUCCESS;
      },
      clock_time_get: (id: number, _precision: bigint, ptr: number) => {
        if (id > 3) return EINVAL;
        this.view().setBigUint64(ptr, nowNs(id), true);
        return SUCCESS;
      },

      fd_advise: () => SUCCESS,
      fd_allocate: (fd: number, offset: bigint, len: bigint) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type !== "file") return EINVAL;
        ensureSize(entry.node, Number(offset + len));
        return SUCCESS;
      },
      fd_close: (fd: number) => (this.fds.delete(fd) ? SUCCESS : EBADF),
      fd_datasync: (fd: number) => (this.fds.has(fd) ? SUCCESS : EBADF),
      fd_sync: (fd: number) => (this.fds.has(fd) ? SUCCESS : EBADF),
      fd_fdstat_get: (fd: number, ptr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        const view = this.view();
        const filetype = entry.type === "stdio" ? FT_CHAR : entry.type === "dir" ? FT_DIR : FT_FILE;
        const rights = entry.type === "stdio" ? RIGHTS_TTY : RIGHTS_ALL;
        view.setUint8(ptr, filetype);
        view.setUint16(ptr + 2, entry.type === "file" && entry.append ? FDFLAG_APPEND : 0, true);
        view.setBigUint64(ptr + 8, rights, true);
        view.setBigUint64(ptr + 16, rights, true);
        return SUCCESS;
      },
      fd_fdstat_set_flags: (fd: number, flags: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type === "file") entry.append = (flags & FDFLAG_APPEND) !== 0;
        return SUCCESS;
      },
      fd_fdstat_set_rights: (fd: number) => (this.fds.has(fd) ? SUCCESS : EBADF),
      fd_filestat_get: (fd: number, ptr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        this.writeFilestat(ptr, entry.type === "stdio" ? null : entry.node);
        return SUCCESS;
      },
      fd_filestat_set_size: (fd: number, size: bigint) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type !== "file") return EINVAL;
        const n = Number(size);
        if (n < entry.node.data.length) entry.node.data = entry.node.data.slice(0, n);
        else ensureSize(entry.node, n);
        entry.node.mtime = Date.now();
        return SUCCESS;
      },
      fd_filestat_set_times: (fd: number, _atim: bigint, mtim: bigint, flags: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type !== "stdio") entry.node.mtime = flags & 8 ? Date.now() : flags & 4 ? Number(mtim / 1_000_000n) : entry.node.mtime;
        return SUCCESS;
      },
      fd_pread: (fd: number, iovs: number, count: number, offset: bigint, nreadPtr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type === "dir") return EISDIR;
        if (entry.type === "stdio") return ESPIPE;
        this.view().setUint32(nreadPtr, this.readIn(entry, this.iovecs(iovs, count), Number(offset)), true);
        return SUCCESS;
      },
      fd_pwrite: (fd: number, iovs: number, count: number, offset: bigint, nwrittenPtr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type === "dir") return EISDIR;
        if (entry.type === "stdio") return ESPIPE;
        this.view().setUint32(nwrittenPtr, this.writeOut(entry, this.iovecs(iovs, count), Number(offset)), true);
        return SUCCESS;
      },
      fd_prestat_get: (fd: number, ptr: number) => {
        const entry = this.fds.get(fd);
        if (!entry || entry.type !== "dir" || entry.preopen === undefined) return EBADF;
        const view = this.view();
        view.setUint8(ptr, 0);
        view.setUint32(ptr + 4, encoder.encode(entry.preopen).length, true);
        return SUCCESS;
      },
      fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
        const entry = this.fds.get(fd);
        if (!entry || entry.type !== "dir" || entry.preopen === undefined) return EBADF;
        this.bytes().set(encoder.encode(entry.preopen).subarray(0, len), ptr);
        return SUCCESS;
      },
      fd_read: (fd: number, iovs: number, count: number, nreadPtr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type === "dir") return EISDIR;
        const n = entry.type === "stdio" ? this.readStdin(this.iovecs(iovs, count)) : this.readIn(entry, this.iovecs(iovs, count), null);
        this.view().setUint32(nreadPtr, n, true);
        return SUCCESS;
      },
      fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type !== "dir") return ENOTDIR;
        const parent = fs.lookup(dirname(entry.path));
        const list: [string, Node][] = [
          [".", entry.node],
          ["..", parent?.kind === "dir" ? parent : entry.node],
        ];
        for (const item of entry.node.children) list.push(item);
        const mem = this.bytes();
        let used = 0;
        for (let i = Number(cookie); i < list.length; i++) {
          const [name, node] = list[i]!;
          const nameBytes = encoder.encode(name);
          const record = new Uint8Array(24 + nameBytes.length);
          const rv = new DataView(record.buffer);
          rv.setBigUint64(0, BigInt(i + 1), true);
          rv.setBigUint64(8, BigInt(node.ino), true);
          rv.setUint32(16, nameBytes.length, true);
          rv.setUint8(20, node.kind === "dir" ? FT_DIR : FT_FILE);
          record.set(nameBytes, 24);
          const room = bufLen - used;
          mem.set(record.subarray(0, Math.min(room, record.length)), buf + used);
          used += Math.min(room, record.length);
          if (used >= bufLen) break;
        }
        this.view().setUint32(usedPtr, used, true);
        return SUCCESS;
      },
      fd_renumber: (from: number, to: number) => {
        const entry = this.fds.get(from);
        if (!entry || !this.fds.has(to)) return EBADF;
        this.fds.set(to, entry);
        this.fds.delete(from);
        return SUCCESS;
      },
      fd_seek: (fd: number, offset: bigint, whence: number, newOffsetPtr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type === "stdio") return ESPIPE;
        if (entry.type === "dir") return EISDIR;
        const base = whence === 0 ? 0 : whence === 1 ? entry.pos : whence === 2 ? entry.node.data.length : NaN;
        const pos = base + Number(offset);
        if (!(pos >= 0)) return EINVAL;
        entry.pos = pos;
        this.view().setBigUint64(newOffsetPtr, BigInt(pos), true);
        return SUCCESS;
      },
      fd_tell: (fd: number, ptr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type !== "file") return ESPIPE;
        this.view().setBigUint64(ptr, BigInt(entry.pos), true);
        return SUCCESS;
      },
      fd_write: (fd: number, iovs: number, count: number, nwrittenPtr: number) => {
        const entry = this.fds.get(fd);
        if (!entry) return EBADF;
        if (entry.type === "dir") return EISDIR;
        let written: number;
        if (entry.type === "stdio") {
          const chunks = this.iovecs(iovs, count);
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.length;
          }
          if (total > 0) (entry.which === 2 ? this.opts.stderr : this.opts.stdout)(out);
          written = total;
        } else {
          written = this.writeOut(entry, this.iovecs(iovs, count), null);
        }
        this.view().setUint32(nwrittenPtr, written, true);
        return SUCCESS;
      },

      path_create_directory: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        if (fs.lookup(path)) return EEXIST;
        const parent = this.parentOf(path);
        if (typeof parent === "number") return parent;
        parent.children.set(basename(path), newDir());
        parent.mtime = Date.now();
        return SUCCESS;
      },
      path_filestat_get: (fd: number, _flags: number, ptr: number, len: number, buf: number) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        const node = fs.lookup(path);
        if (!node) return ENOENT;
        this.writeFilestat(buf, node);
        return SUCCESS;
      },
      path_filestat_set_times: (fd: number, _flags: number, ptr: number, len: number, _atim: bigint, mtim: bigint, fst: number) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        const node = fs.lookup(path);
        if (!node) return ENOENT;
        if (fst & 8) node.mtime = Date.now();
        else if (fst & 4) node.mtime = Number(mtim / 1_000_000n);
        return SUCCESS;
      },
      path_link: (oldFd: number, _flags: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) => {
        const from = this.resolve(oldFd, oldPtr, oldLen);
        if (typeof from === "number") return from;
        const to = this.resolve(newFd, newPtr, newLen);
        if (typeof to === "number") return to;
        const node = fs.lookup(from);
        if (!node) return ENOENT;
        if (node.kind === "dir") return EPERM;
        if (fs.lookup(to)) return EEXIST;
        const parent = this.parentOf(to);
        if (typeof parent === "number") return parent;
        parent.children.set(basename(to), node);
        return SUCCESS;
      },
      path_open: (
        fd: number,
        _dirflags: number,
        ptr: number,
        len: number,
        oflags: number,
        _rightsBase: bigint,
        _rightsInheriting: bigint,
        fdflags: number,
        fdOut: number,
      ) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        let node = fs.lookup(path);
        if (node && oflags & O_CREAT && oflags & O_EXCL) return EEXIST;
        if (!node) {
          if (!(oflags & O_CREAT)) return ENOENT;
          const parent = this.parentOf(path);
          if (typeof parent === "number") return parent;
          node = newFile();
          parent.children.set(basename(path), node);
          parent.mtime = Date.now();
        }
        if (oflags & O_DIRECTORY && node.kind !== "dir") return ENOTDIR;
        let entry: Fd;
        if (node.kind === "dir") {
          if (oflags & O_TRUNC) return EISDIR;
          entry = { type: "dir", node, path };
        } else {
          if (oflags & O_TRUNC) {
            node.data = new Uint8Array(0);
            node.mtime = Date.now();
          }
          entry = { type: "file", node, path, pos: 0, append: (fdflags & FDFLAG_APPEND) !== 0 };
        }
        const newFd = this.nextFd++;
        this.fds.set(newFd, entry);
        this.view().setUint32(fdOut, newFd, true);
        return SUCCESS;
      },
      path_readlink: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        return fs.lookup(path) ? EINVAL : ENOENT; // no symlinks in MemFS
      },
      path_remove_directory: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        const node = fs.lookup(path);
        if (!node) return ENOENT;
        if (node.kind !== "dir") return ENOTDIR;
        if (node.children.size > 0) return ENOTEMPTY;
        if (path === "/") return EPERM;
        fs.remove(path);
        return SUCCESS;
      },
      path_rename: (oldFd: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) => {
        const from = this.resolve(oldFd, oldPtr, oldLen);
        if (typeof from === "number") return from;
        const to = this.resolve(newFd, newPtr, newLen);
        if (typeof to === "number") return to;
        const node = fs.lookup(from);
        if (!node) return ENOENT;
        if (from === to) return SUCCESS;
        if (to.startsWith(`${from}/`)) return EINVAL;
        const target = fs.lookup(to);
        if (target?.kind === "dir" && node.kind !== "dir") return EISDIR;
        if (target && target.kind !== "dir" && node.kind === "dir") return ENOTDIR;
        if (target?.kind === "dir" && target.children.size > 0) return ENOTEMPTY;
        const parent = this.parentOf(to);
        if (typeof parent === "number") return parent;
        fs.remove(from);
        parent.children.set(basename(to), node);
        parent.mtime = Date.now();
        return SUCCESS;
      },
      path_symlink: () => ENOTSUP,
      path_unlink_file: (fd: number, ptr: number, len: number) => {
        const path = this.resolve(fd, ptr, len);
        if (typeof path === "number") return path;
        const node = fs.lookup(path);
        if (!node) return ENOENT;
        if (node.kind === "dir") return EISDIR;
        fs.remove(path);
        return SUCCESS;
      },

      poll_oneoff: (inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) => {
        if (nsubs === 0) return EINVAL;
        const view = this.view();
        const ready: { userdata: bigint; type: number; nbytes: bigint; flags: number }[] = [];
        const clocks: { userdata: bigint; deadline: bigint; clock: number }[] = [];
        for (let i = 0; i < nsubs; i++) {
          const sub = inPtr + i * 48;
          const userdata = view.getBigUint64(sub, true);
          const tag = view.getUint8(sub + 8);
          if (tag === EVENTTYPE_CLOCK) {
            const clock = view.getUint32(sub + 16, true);
            const timeout = view.getBigUint64(sub + 24, true);
            const abs = (view.getUint16(sub + 40, true) & SUBCLOCK_ABSTIME) !== 0;
            clocks.push({ userdata, clock, deadline: abs ? timeout : nowNs(clock) + timeout });
            continue;
          }
          // fd_read / fd_write: memory-backed fds never block. stdin reports end of file.
          const fd = view.getUint32(sub + 16, true);
          const entry = this.fds.get(fd);
          const isStdin = entry?.type === "stdio" && entry.which === 0;
          const remaining = entry?.type === "file" ? BigInt(Math.max(0, entry.node.data.length - entry.pos)) : 0n;
          ready.push({
            userdata,
            type: tag,
            nbytes: tag === EVENTTYPE_FD_READ ? remaining : 0n,
            flags: isStdin && tag === EVENTTYPE_FD_READ ? EVENTRWFLAGS_HANGUP : 0,
          });
        }
        if (ready.length === 0 && clocks.length > 0) {
          const first = clocks.reduce((a, b) => (b.deadline - nowNs(b.clock) < a.deadline - nowNs(a.clock) ? b : a));
          const waitNs = first.deadline - nowNs(first.clock);
          if (waitNs > 0n) this.opts.sleep(Number(waitNs) / 1e6);
          for (const c of clocks) {
            if (c === first || c.deadline <= nowNs(c.clock)) ready.push({ userdata: c.userdata, type: EVENTTYPE_CLOCK, nbytes: 0n, flags: 0 });
          }
        }
        ready.forEach((ev, i) => {
          const at = outPtr + i * 32;
          view.setBigUint64(at, ev.userdata, true);
          view.setUint16(at + 8, SUCCESS, true);
          view.setUint8(at + 10, ev.type);
          view.setBigUint64(at + 16, ev.nbytes, true);
          view.setUint16(at + 24, ev.flags, true);
        });
        view.setUint32(neventsPtr, ready.length, true);
        return SUCCESS;
      },

      proc_exit: (code: number) => {
        throw new WasiExit(code);
      },
      proc_raise: () => ENOSYS,
      random_get: (ptr: number, len: number) => {
        const mem = this.bytes();
        for (let at = 0; at < len; at += 65536) {
          const chunk = new Uint8Array(Math.min(65536, len - at));
          getRandomValues(chunk);
          mem.set(chunk, ptr + at);
        }
        return SUCCESS;
      },
      sched_yield: () => SUCCESS,
      sock_accept: () => ENOTSUP,
      sock_recv: () => ENOTSUP,
      sock_send: (fd: number, siData: number, siLen: number, _flags: number, retPtr: number) => {
        if (fd !== HOST_CALL_FD || !this.hostCall || siLen !== 5) return ENOTSUP;
        const view = new DataView(this.memory.buffer);
        const at = siData >>> 0;
        const words = [0, 1, 2, 3, 4].map((i) => view.getInt32(at + 4 * i, true));
        const result = this.hostCall(words[0]!, words.slice(1));
        // The call may have grown memory: take a fresh view.
        new DataView(this.memory.buffer).setInt32(retPtr >>> 0, result, true);
        return SUCCESS;
      },
      sock_shutdown: () => ENOTSUP,
    };
  }
}
