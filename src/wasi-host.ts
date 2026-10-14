import {
  ConsoleStdout,
  Directory,
  Fd,
  File,
  OpenFile,
  OpenDirectory,
  PreopenDirectory,
  WASI,
  wasi,
} from "@bjorn3/browser_wasi_shim";
import { SharedBridge, control } from "./bridge";
import { ExecutionProfile, profileFields } from "./execution-profile";
const encoder = new TextEncoder();
const RESIZE = encoder.encode("\x1b[997~");
export class BrowserHost {
  private epoch: number;
  private resizeBytes: Uint8Array = new Uint8Array();
  private previousCR = false;
  private canonical: number[] = [];
  private pendingLine: Uint8Array = new Uint8Array();
  private memory: WebAssembly.Memory | undefined;
  private readonly capacities = new WeakMap<File, Uint8Array>();
  private readonly appendFiles = new WeakSet<OpenFile>();
  private usage: { bytes: number } | undefined;
  private allocatedBytes = 0;
  private scalarWidth: ((codepoint: number) => number) | undefined;
  readonly root = new PreopenDirectory(
    "/",
    new Map([
      [
        "home",
        new Directory([
          [
            "guest",
            new Directory([
              [
                "welcome.txt",
                new File(encoder.encode("Files and commands run inside this browser.\n")),
              ],
            ]),
          ],
        ]),
      ],
      ["tmp", new Directory([])],
      ["dev", new Directory([["null", new NullFile([])]])],
    ]),
  );
  readonly wasi: WASI;
  constructor(
    readonly bridge: SharedBridge,
    private readonly profile?: ExecutionProfile,
  ) {
    this.epoch = Atomics.load(bridge.state, control.resize);
    this.wasi = new WASI(
      ["brush-browser"],
      ["HOME=/home/guest", "TERM=xterm-256color", "USER=guest", "PATH=/bin", "LANG=C.UTF-8"],
      [new TerminalInput(this), new TerminalOutput(this), new TerminalOutput(this), this.root],
      { debug: false },
    );
    this.limitFilesystem();
    this.profileImports();
  }
  attach(memory: WebAssembly.Memory, scalarWidth: (codepoint: number) => number) {
    this.memory = memory;
    this.scalarWidth = scalarWidth;
  }
  get imports() {
    return {
      read: (ptr: number, length: number) => {
        const memory = this.memory;
        if (!memory) throw new Error("WASM memory is unavailable");
        const result = this.read(length);
        if (typeof result === "number") return result;
        new Uint8Array(memory.buffer, ptr, length).set(result);
        return result.length;
      },
      wait: (timeout: number) => this.wait(timeout),
      columns: () => Atomics.load(this.bridge.state, control.cols),
      rows: () => Atomics.load(this.bridge.state, control.rows),
      raw_mode: (enabled: number) => Atomics.store(this.bridge.state, control.raw, enabled),
      cancelled: () => Number(this.bridge.cancelled() || this.bridge.closed()),
      clear_cancel: () => {
        const cancelled = Atomics.exchange(this.bridge.state, control.cancel, 0);
        if (!cancelled) return;
        Atomics.store(
          this.bridge.state,
          control.inputRead,
          Atomics.load(this.bridge.state, control.inputWrite),
        );
        this.canonical = [];
        this.pendingLine = new Uint8Array();
        this.previousCR = false;
        this.write(encoder.encode("\x1b[?1049l\x1b[?25h\x1b[0m\r\n"));
      },
      sleep: (ms: number) => this.sleep(ms),
      event: (kind: number, value: number) => {
        if (kind === 2) this.profile?.start();
        if (kind === 1 || kind === 3) this.profile?.finish();
        Atomics.store(this.bridge.state, control.status, value);
        Atomics.store(this.bridge.state, control.phase, kind);
        Atomics.store(this.bridge.state, control.memory, this.memory?.buffer.byteLength ?? 0);
      },
    };
  }
  wait(timeout: number): number {
    const deadline = performance.now() + timeout;
    for (;;) {
      const wake = Atomics.load(this.bridge.state, control.wake);
      if (this.bridge.cancelled() || this.bridge.closed()) return -1;
      if (this.bridge.availableInput() || this.resized() || this.resizeBytes.length) return 1;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return 0;
      Atomics.wait(this.bridge.state, control.wake, wake, remaining);
    }
  }
  read(length: number): Uint8Array | number {
    if (!length) return new Uint8Array();
    if (this.wait(2147483647) < 0) return this.bridge.closed() ? -2 : -1;
    if (this.resized()) {
      this.epoch = Atomics.load(this.bridge.state, control.resize);
      this.resizeBytes = RESIZE.slice();
    }
    if (!this.resizeBytes.length) return this.bridge.receive(length);
    const result = this.resizeBytes.slice(0, length);
    this.resizeBytes = this.resizeBytes.subarray(result.length);
    return result;
  }
  stdin(length: number): { ret: number; data: Uint8Array } {
    if (!length) return { ret: 0, data: new Uint8Array() };
    if (Atomics.load(this.bridge.state, control.raw)) return this.rawStdin(length);
    if (!this.pendingLine.length) {
      const result = this.readCanonical();
      if (typeof result === "number") return { ret: result, data: new Uint8Array() };
      this.pendingLine = result;
    }
    const data = this.pendingLine.slice(0, length);
    this.pendingLine = this.pendingLine.subarray(data.length);
    return { ret: 0, data };
  }
  private rawStdin(length: number) {
    const data = this.read(length);
    if (typeof data === "number") return { ret: wasi.ERRNO_INTR, data: new Uint8Array() };
    return { ret: 0, data };
  }
  private readCanonical(): Uint8Array | number {
    for (;;) {
      if (this.bridge.cancelled() || this.bridge.closed()) {
        this.canonical = [];
        return wasi.ERRNO_INTR;
      }
      // Resizes wake readers, but canonical stdin consumes only actual typed bytes.
      const wake = Atomics.load(this.bridge.state, control.wake);
      if (!this.bridge.availableInput()) {
        Atomics.wait(this.bridge.state, control.wake, wake, 100);
        continue;
      }
      const byte = this.bridge.receive(1)[0];
      const line = this.canonicalByte(byte);
      if (line) return line;
    }
  }
  private canonicalByte(byte: number): Uint8Array | undefined {
    if (byte === 4) {
      const line = Uint8Array.from(this.canonical);
      this.canonical = [];
      return line;
    }
    if (byte === 13 || byte === 10) {
      this.write(encoder.encode("\n"));
      const line = Uint8Array.from(this.canonical.concat([10]));
      this.canonical = [];
      return line;
    }
    if (byte === 127 || byte === 8) {
      if (this.canonical.length) this.eraseCanonicalGrapheme();
      return;
    }
    if (this.canonical.length === 65536) {
      this.write(Uint8Array.of(7));
      return undefined;
    }
    this.canonical.push(byte);
    this.write(
      byte < 32 && byte !== 9
        ? encoder.encode("^" + String.fromCharCode(byte + 64))
        : Uint8Array.of(byte),
    );
  }
  private eraseCanonicalGrapheme() {
    const text = new TextDecoder().decode(Uint8Array.from(this.canonical));
    const segments = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    );
    const last = segments.at(-1);
    if (!last) return;
    this.canonical = Array.from(encoder.encode(text.slice(0, last.index)));
    const scalarWidth = this.scalarWidth;
    if (!scalarWidth) throw new Error("WASM text-width export is unavailable");
    const cells = Array.from(last.segment).reduce((width, char) => {
      const code = char.codePointAt(0) ?? 0;
      return width + (code < 32 || code === 127 ? 2 : scalarWidth(code));
    }, 0);
    this.write(encoder.encode("\b \b".repeat(cells)));
  }
  sleep(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const wake = Atomics.load(this.bridge.state, control.wake);
      if (this.bridge.cancelled() || this.bridge.closed()) return 1;
      Atomics.wait(this.bridge.state, control.wake, wake, Math.min(50, end - performance.now()));
    }
    return 0;
  }
  write(bytes: Uint8Array): number {
    const output = new Uint8Array(bytes.length * 2);
    let length = 0;
    for (const byte of bytes) {
      if (byte === 10 && !this.previousCR) output[length++] = 13;
      output[length++] = byte;
      this.previousCR = byte === 13;
    }
    const written = this.bridge.write(output.subarray(0, length));
    this.profile?.maximum(
      profileFields.bufferedBytes,
      (Atomics.load(this.bridge.state, control.outputWrite) -
        Atomics.load(this.bridge.state, control.outputRead)) >>>
        0,
    );
    return written === length ? bytes.length : 0;
  }
  private resized() {
    return this.epoch !== Atomics.load(this.bridge.state, control.resize);
  }
  private limitFilesystem() {
    const imports = this.wasi.wasiImport;
    const write = imports.fd_write;
    imports.fd_write = (fd: number, ptr: number, count: number, out: number) => {
      const file = this.fileForFd(fd);
      if (!file) return write(fd, ptr, count, out);
      const position = this.appendFiles.has(file) ? file.file.size : file.file_pos;
      const result = this.writeFile(file, ptr, count, position, out);
      if (result === 0 && this.memory)
        file.file_pos = position + BigInt(new DataView(this.memory.buffer).getUint32(out, true));
      return result;
    };
    const pwrite = imports.fd_pwrite;
    imports.fd_pwrite = (fd: number, ptr: number, count: number, offset: bigint, out: number) => {
      const file = this.fileForFd(fd);
      return file
        ? this.writeFile(file, ptr, count, offset, out)
        : pwrite(fd, ptr, count, offset, out);
    };
    const resize = imports.fd_filestat_set_size;
    imports.fd_filestat_set_size = (fd: number, size: bigint) => {
      const file = this.fileForFd(fd);
      return file ? this.resizeFile(file, size) : resize(fd, size);
    };
    const allocate = imports.fd_allocate;
    imports.fd_allocate = (fd: number, offset: bigint, length: bigint) => {
      const file = this.fileForFd(fd);
      if (!file) return allocate(fd, offset, length);
      return this.resizeFile(
        file,
        file.file.size > offset + length ? file.file.size : offset + length,
      );
    };
    const mkdir = imports.path_create_directory;
    imports.path_create_directory = (fd: number, ptr: number, length: number) => {
      if (this.inodes().length >= 1024) return wasi.ERRNO_NOSPC;
      this.usage = undefined;
      return mkdir(fd, ptr, length);
    };
    for (const name of ["path_unlink_file", "path_remove_directory", "path_rename", "path_link"]) {
      const operation = imports[name];
      imports[name] = (...args: Parameters<typeof operation>) => {
        this.usage = undefined;
        return operation(...args);
      };
    }
    this.limitDescriptors();
  }
  private writeFile(file: OpenFile, ptr: number, count: number, offset: bigint, out: number) {
    if (!this.memory) return wasi.ERRNO_FAULT;
    if (file.file.readonly) return wasi.ERRNO_BADF;
    const length = this.iovecBytes(ptr, count);
    if (length === 0) {
      new DataView(this.memory.buffer).setUint32(out, 0, true);
      return 0;
    }
    const end = offset + BigInt(length);
    if (!this.fits(file, end)) return wasi.ERRNO_NOSPC;
    const size = file.file.size > end ? file.file.size : end;
    const result = this.resizeFile(file, size);
    if (result !== 0) return result;
    const view = new DataView(this.memory.buffer);
    let position = Number(offset);
    for (let index = 0; index < count; index++) {
      const address = view.getUint32(ptr + index * 8, true);
      const bytes = view.getUint32(ptr + index * 8 + 4, true);
      file.file.data.set(new Uint8Array(this.memory.buffer, address, bytes), position);
      position += bytes;
    }
    view.setUint32(out, length, true);
    return 0;
  }
  private resizeFile(open: OpenFile, size: bigint) {
    if (open.file.readonly) return wasi.ERRNO_BADF;
    if (!this.fits(open, size)) return wasi.ERRNO_NOSPC;
    const file = open.file;
    const oldSize = file.data.length;
    const length = Number(size);
    let storage = this.capacities.get(file) ?? file.data;
    if (storage.length < length) {
      const capacity = Math.min(8388608, Math.max(length, storage.length * 2, 4096));
      if (this.allocatedBytes + capacity - storage.length > 16777216) return wasi.ERRNO_NOSPC;
      const enlarged = new Uint8Array(capacity);
      enlarged.set(file.data);
      this.allocatedBytes += capacity - storage.length;
      this.profile?.add(profileFields.fileAllocatedBytes, capacity);
      this.profile?.add(profileFields.fileCopiedBytes, oldSize);
      storage = enlarged;
    }
    if (length > oldSize) storage.fill(0, oldSize, length);
    this.capacities.set(file, storage);
    file.data = storage.subarray(0, length);
    if (this.usage) this.usage.bytes += length - oldSize;
    return 0;
  }
  private profileImports() {
    if (!this.profile) return;
    for (const name of ["fd_read", "fd_write", "fd_pread", "fd_pwrite", "path_open", "fd_close"]) {
      const operation = this.wasi.wasiImport[name];
      this.wasi.wasiImport[name] = (...args: Parameters<typeof operation>) => {
        if (!this.profile?.active) return operation(...args);
        const start = performance.now();
        const result = operation(...args);
        this.profile.add(profileFields.hostMs, performance.now() - start);
        this.recordIo(name, args, result);
        return result;
      };
    }
  }
  private recordIo(name: string, args: unknown[], result: unknown) {
    if (!this.profile || !this.memory || result !== 0) return;
    const [fd, ptr, count, out] = args;
    if (typeof fd !== "number" || typeof ptr !== "number" || typeof count !== "number") return;
    const read = name === "fd_read";
    const write = name === "fd_write";
    if ((!read && !write) || typeof out !== "number") return;
    const view = new DataView(this.memory.buffer);
    this.profile.add(read ? profileFields.reads : profileFields.writes);
    this.profile.add(
      read ? profileFields.readBytes : profileFields.writeBytes,
      view.getUint32(out, true),
    );
    if (read && count === 1 && view.getUint32(ptr + 4, true) === 1)
      this.profile.add(profileFields.oneByteReads);
  }
  private limitDescriptors() {
    const open = this.wasi.wasiImport.path_open;
    this.wasi.wasiImport.path_open = (
      fd: number,
      flags: number,
      ptr: number,
      length: number,
      oflags: number,
      rights: bigint,
      inherited: bigint,
      fdflags: number,
      out: number,
    ) => {
      const fds = this.wasi.fds;
      if (fds.filter(Boolean).length >= 128) return wasi.ERRNO_MFILE;
      if (
        oflags & wasi.OFLAGS_CREAT &&
        this.inodes().length >= 1024 &&
        !this.pathExists(fd, flags, ptr, length)
      )
        return wasi.ERRNO_NOSPC;
      const hole = fds.findIndex((entry, index) => index >= 4 && !entry);
      this.usage = undefined;
      const result = open(fd, flags, ptr, length, oflags, rights, inherited, fdflags, out);
      if (result === 0 && this.memory) {
        const opened = fds[new DataView(this.memory.buffer).getUint32(out, true)];
        if (opened instanceof OpenFile && fdflags & wasi.FDFLAGS_APPEND)
          this.appendFiles.add(opened);
      }
      if (result !== 0 || hole < 4 || !this.memory) return result;
      const opened = fds.pop();
      if (!opened) throw new Error("WASI open succeeded without a descriptor");
      fds[hole] = opened;
      new DataView(this.memory.buffer).setUint32(out, hole, true);
      return result;
    };
    const close = this.wasi.wasiImport.fd_close;
    this.wasi.wasiImport.fd_close = (fd: number) => {
      this.usage = undefined;
      const result = close(fd);
      const fds = this.wasi.fds;
      while (fds.length > 4 && !fds.at(-1)) fds.pop();
      return result;
    };
  }
  private pathExists(fd: number, flags: number, ptr: number, length: number) {
    const directory = this.wasi.fds[fd];
    if (!(directory instanceof OpenDirectory) || !this.memory) return false;
    const path = new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, length));
    return directory.path_lookup(path, flags).ret === 0;
  }
  private fileForFd(fd: number) {
    const file = this.wasi.fds[fd];
    return file instanceof OpenFile && !(file instanceof NullFd) ? file : undefined;
  }
  private fits(open: OpenFile, end: bigint) {
    const growth = end - open.file.size;
    return (
      end >= 0n &&
      end <= 8388608n &&
      this.filesystemBytes() + Number(growth > 0n ? growth : 0n) <= 8388608
    );
  }
  private iovecBytes(ptr: number, count: number) {
    if (!this.memory) return 0;
    const view = new DataView(this.memory.buffer);
    let total = 0;
    for (let index = 0; index < count; index++) total += view.getUint32(ptr + index * 8 + 4, true);
    return total;
  }
  private filesystemBytes() {
    if (this.usage) return this.usage.bytes;
    const inodes = this.inodes();
    this.allocatedBytes = inodes.reduce(
      (sum, inode) =>
        sum +
        (inode instanceof File ? (this.capacities.get(inode)?.length ?? inode.data.length) : 0),
      0,
    );
    this.usage = {
      bytes: inodes.reduce(
        (sum, inode) => sum + (inode instanceof File ? inode.data.byteLength : 0),
        0,
      ),
    };
    return this.usage.bytes;
  }
  private inodes() {
    const found = new Set<Directory | File>();
    let stack = Array.from(this.root.dir.contents.values());
    for (const fd of this.wasi.fds) {
      if (fd instanceof OpenFile) stack.push(fd.file);
      if (fd instanceof OpenDirectory) stack.push(fd.dir);
    }
    while (stack.length) {
      const inode = stack.pop();
      if (!(inode instanceof Directory || inode instanceof File) || found.has(inode)) continue;
      found.add(inode);
      if (inode instanceof Directory) stack = stack.concat(Array.from(inode.contents.values()));
    }
    return Array.from(found);
  }
}
class TerminalInput extends Fd {
  constructor(private readonly host: BrowserHost) {
    super();
  }
  override fd_read(size: number) {
    return this.host.stdin(size);
  }
  override fd_fdstat_get() {
    return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0) };
  }
  override fd_filestat_get() {
    return { ret: 0, filestat: new wasi.Filestat(1n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
  }
}
class TerminalOutput extends ConsoleStdout {
  constructor(private readonly host: BrowserHost) {
    super(() => {});
  }
  override fd_write(bytes: Uint8Array) {
    const nwritten = this.host.write(bytes);
    return { ret: nwritten === bytes.length ? 0 : wasi.ERRNO_INTR, nwritten };
  }
}

class NullFile extends File {
  override path_open() {
    return { ret: 0, fd_obj: new NullFd(this) };
  }
}
class NullFd extends OpenFile {
  override fd_allocate() {
    return 0;
  }
  override fd_filestat_set_size() {
    return 0;
  }
  override fd_pwrite(bytes: Uint8Array) {
    return { ret: 0, nwritten: bytes.length };
  }
  override fd_read() {
    return { ret: 0, data: new Uint8Array() };
  }
  override fd_write(bytes: Uint8Array) {
    return { ret: 0, nwritten: bytes.length };
  }
}
