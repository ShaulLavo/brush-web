import { afterEach, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { PipeEndpointHandle } from "../proc/pipes";
import { DescriptorTable, type Stream } from "../core/descriptors";
import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { createFilesystemIdentity, reapFilesystem } from "../fs/protocol";
import { MemFS } from "../fs/memory";
import { ProcessABI, ProcessSignalExit, type ProcessABIOptions } from "../proc/abi";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { Signal } from "../proc/types";

const ALL = (1n << 29n) - 1n;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(overrides: Partial<ProcessABIOptions> = {}) {
  const fs = new MemFS(), descriptors = new DescriptorTable();
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch() { throw new Error("not launched by synchronous tests"); } });
  const pid = supervisor.createRoot({ descriptors });
  const signals = supervisor.get(pid)!;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  let waits = 0;
  const abi = new ProcessABI({ memory, descriptors, fs, pid, service: supervisor, signals,
    wait() { waits++; throw new Error("nonblocking call slept"); }, ...overrides });
  cleanups.push(() => supervisor.dispose());
  const bytes = () => new Uint8Array(memory.buffer), view = () => new DataView(memory.buffer);
  const put = (text: string, at = 2048) => { const data = encoder.encode(text); bytes().set(data, at); return data.length; };
  const spawn = (fds: { child: number; parent: number }[] = [], job = 0) => {
    const length = put(JSON.stringify({ executable: "fixture", argv: ["fixture", "a b"], env: { A: "b" }, cwd: "/tmp", job, fds }));
    return abi.imports.spawn!(2048, length);
  };
  const pipe = () => { expect(abi.imports.pipe!(32)).toBe(0); return [view().getUint32(32, true), view().getUint32(36, true)] as const; };
  const sub = (index: number, kind: number, id: number, userdata = BigInt(index + 1)) => {
    const at = 256 + index * 16;
    view().setUint32(at, kind, true); view().setUint32(at + 4, id, true); view().setBigUint64(at + 8, userdata, true);
  };
  return { fs, descriptors, supervisor, pid, signals, memory, abi, bytes, view, put, spawn, pipe, sub, waits: () => waits };
}

test("spawn snapshots JSON and retains arbitrary fd bindings before returning", () => {
  const f = fixture();
  const [read, write] = f.pipe();
  const child = f.spawn([{ child: 0, parent: read }, { child: 1, parent: write }, { child: 2, parent: write }, { child: 19, parent: write }]);
  expect(child).toBeGreaterThan(0);
  f.bytes().fill(0, 2048);
  f.descriptors.close(read); f.descriptors.close(write);
  const childTable = f.supervisor.get(child)!.descriptors;
  expect(childTable.get(0)!.resource.kind).toBe("pipe");
  expect(childTable.get(19)!.resource.kind).toBe("pipe");
  expect(f.supervisor.get(child)!.request!.argv).toEqual(["fixture", "a b"]);
  expect(f.abi.imports.job_of!(child)).toBe(f.supervisor.jobOf(child));
  expect(f.abi.imports.wait!(child, 64)).toBe(-6);
  expect(f.waits()).toBe(0);
});

test("spawn decodes resizable guest memory through a fixed WebIDL buffer", () => {
  const f = fixture();
  const memory = f.memory as WebAssembly.Memory & { toResizableBuffer(): ArrayBuffer };
  const buffer = memory.toResizableBuffer();
  expect(buffer.resizable).toBe(true);
  const nativeDecode = TextDecoder.prototype.decode;
  // TextDecoder's BufferSource does not permit resizable buffers. Enforce that WebIDL
  // contract even on hosts whose decoder currently accepts them.
  const strictDecode = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
    const storage = ArrayBuffer.isView(input) ? input.buffer : input;
    if (storage instanceof ArrayBuffer && storage.resizable) throw new TypeError("resizable BufferSource is not allowed");
    return nativeDecode.call(this, input, options);
  });
  try {
    expect(() => decoder.decode(new Uint8Array(buffer, 2048, 1))).toThrow("resizable BufferSource is not allowed");
    const request = { executable: "fixture", argv: ["fixture", "日本語"], env: { A: "é" }, cwd: "/tmp", job: 0, fds: [] };
    const child = f.abi.imports.spawn!(2048, f.put(JSON.stringify(request)));
    expect(child).toBeGreaterThan(0);
    expect(f.supervisor.get(child)!.request!.argv).toEqual(request.argv);
    expect(f.supervisor.get(child)!.request!.env).toEqual(request.env);
    f.memory.grow(1);
    expect(f.spawn()).toBeGreaterThan(0);
    expect(f.abi.imports.spawn!(2048, f.put("not json"))).toBe(-28);
    f.bytes()[2048] = 0xff;
    expect(f.abi.imports.spawn!(2048, 1)).toBe(-28);
  } finally { strictDecode.mockRestore(); }
});

test("spawn rejects malformed descriptions, invalid bindings and out-of-bounds memory", () => {
  const f = fixture();
  for (const value of ["not json", "null", "{}", JSON.stringify({ executable: "x", argv: [4], env: {}, cwd: "/", job: 0, fds: [] })]) {
    expect(f.abi.imports.spawn!(2048, f.put(value))).toBe(-28);
  }
  expect(f.spawn([{ child: 3, parent: 9999 }])).toBe(-8);
  const [, write] = f.pipe();
  expect(f.spawn([{ child: 3, parent: write }, { child: 3, parent: write }])).toBe(-28);
  expect(f.abi.imports.spawn!(65535, 2)).toBe(-21);
  expect(f.abi.imports.pipe!(65532)).toBe(-21);
  expect(f.abi.imports.dup!(9999)).toBe(-8);
});

test("pipe reads and writes are nonblocking, partial, zero-length, EOF and EPIPE aware", () => {
  const f = fixture({ pipeCapacity: 8 });
  const [read, write] = f.pipe();
  const length = f.put("abcdefghij");
  expect(f.abi.imports.read!(read, 4096, 0)).toBe(0);
  expect(f.abi.imports.read!(read, 4096, 2)).toBe(-6);
  expect(f.abi.imports.write!(write, 2048, length)).toBe(8);
  expect(f.abi.imports.write!(write, 2048, 0)).toBe(0);
  expect(f.abi.imports.write!(write, 2048, 1)).toBe(-6);
  expect(f.abi.imports.read!(read, 4096, 2)).toBe(2);
  expect(decoder.decode(f.bytes().subarray(4096, 4098))).toBe("ab");
  const duplicate = f.abi.imports.dup!(write);
  f.descriptors.close(write);
  expect(f.abi.imports.read!(read, 4096, 9)).toBe(6);
  expect(f.abi.imports.read!(read, 4096, 1)).toBe(-6);
  f.descriptors.close(duplicate);
  expect(f.abi.imports.read!(read, 4096, 1)).toBe(0);
  const [otherRead, otherWrite] = f.pipe();
  f.descriptors.close(otherRead);
  expect(f.abi.imports.write!(otherWrite, 2048, 0)).toBe(0);
  expect(f.abi.imports.write!(otherWrite, 2048, 1)).toBe(-64);
  expect(f.waits()).toBe(0);
});

test("dup preserves write order for 2>&1 and shares the ordinary preview1 fd path", () => {
  const f = fixture();
  const [read, stdout] = f.pipe(), stderr = f.abi.imports.dup!(stdout);
  f.put("one-two");
  expect(f.abi.imports.write!(stdout, 2048, 4)).toBe(4);
  const wasi = new Wasi({ args: [], env: {}, fs: f.fs, preopens: {}, stdout() {}, stderr() {}, sleep() { throw new Error("ready pipe blocked"); } });
  wasi.start({ exports: { memory: f.memory, _start() {} } } as unknown as WebAssembly.Instance);
  wasi.descriptors.inherit(9, f.descriptors.get(stderr)!);
  wasi.descriptors.inherit(10, f.descriptors.get(read)!);
  cleanups.push(() => wasi.descriptors.dispose());
  f.view().setUint32(64, 2052, true); f.view().setUint32(68, 3, true);
  const functions = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions();
  expect(functions.fd_write!(9, 64, 1, 80)).toBe(0);
  expect(f.view().getUint32(80, true)).toBe(3);
  let received = 0;
  while (received < 7) {
    f.view().setUint32(64, 4096 + received, true); f.view().setUint32(68, 7 - received, true);
    expect(functions.fd_read!(10, 64, 1, 80)).toBe(0);
    const count = f.view().getUint32(80, true);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(7 - received);
    received += count;
  }
  expect(decoder.decode(f.bytes().subarray(4096, 4103))).toBe("one-two");
});

test("runtime_proc handles files in the existing fd namespace and shares offsets with dup", () => {
  const f = fixture();
  const root = f.fs.preopen("/");
  const resolved = f.fs.resolve(root, "data");
  if (typeof resolved === "number") throw new Error("resolve failed");
  const handle = f.fs.create(resolved, "file");
  if (typeof handle !== "number") throw new Error("create failed");
  f.fs.retain(handle);
  const fd = f.descriptors.open({ kind: "file", handle, offset: 0, append: false }, ALL, ALL, () => f.fs.release(handle));
  f.put("abcdef");
  expect(f.abi.imports.write!(fd, 2048, 6)).toBe(6);
  const file = f.descriptors.get(fd)!.resource;
  if (file.kind !== "file") throw new Error("not file");
  file.offset = 0;
  const duplicate = f.abi.imports.dup!(fd);
  expect(f.abi.imports.read!(fd, 4096, 2)).toBe(2);
  expect(f.abi.imports.read!(duplicate, 4098, 4)).toBe(4);
  expect(decoder.decode(f.bytes().subarray(4096, 4102))).toBe("abcdef");
  expect(file.offset).toBe(6);
  expect(f.abi.imports.read!(duplicate, 4096, 2)).toBe(0);
  file.append = true; file.offset = 0;
  expect(f.abi.imports.write!(duplicate, 2048, 2)).toBe(2);
  expect(file.offset).toBe(8);
  f.sub(0, 0, fd); f.sub(1, 1, duplicate);
  expect(f.abi.imports.poll!(256, 2, 0, 512)).toBe(2);
});

test("file errors and capability checks do not advance offsets or write guest buffers", () => {
  const f = fixture();
  const directory = f.descriptors.open({ kind: "directory", handle: f.fs.preopen("/") }, ALL, ALL);
  expect(f.abi.imports.read!(directory, 4096, 1)).toBe(-31);
  const denied = f.descriptors.open({ kind: "terminal", read() { throw new Error("denied read"); }, write() { throw new Error("denied write"); }, readiness: () => ({ readable: true, writable: true, hangup: false }) }, 0n, 0n);
  expect(f.abi.imports.read!(denied, 4096, 1)).toBe(-76);
  expect(f.abi.imports.write!(denied, 2048, 1)).toBe(-76);
  const [read, write] = f.pipe();
  expect(f.abi.imports.read!(read, 65535, 2)).toBe(-21);
  expect(f.abi.imports.write!(write, 65535, 2)).toBe(-21);
  expect(f.abi.imports.read!(write, 4096, 1)).toBe(-76);
  expect(f.abi.imports.write!(read, 2048, 1)).toBe(-76);
});

test("wait emits little-endian exit/signal records and remains level-triggered", () => {
  const f = fixture();
  const normal = f.spawn(), signaled = f.spawn();
  f.supervisor.exit(normal, 23);
  expect(f.abi.imports.wait!(normal, 64)).toBe(0);
  expect(Array.from(f.bytes().subarray(64, 72))).toEqual([0, 0, 0, 0, 23, 0, 0, 0]);
  expect(f.abi.imports.wait!(normal, 64)).toBe(0);
  expect(f.abi.imports.kill!(signaled, Signal.SIGTERM)).toBe(0);
  expect(f.abi.imports.wait!(signaled, 64)).toBe(0);
  expect(Array.from(f.bytes().subarray(64, 72))).toEqual([1, 0, 0, 0, 15, 0, 0, 0]);
  expect(f.abi.imports.wait!(99999, 64)).toBe(-12);
  expect(f.abi.imports.kill!(99999, 2)).toBe(-71);
  expect(f.abi.imports.kill!(normal, 3)).toBe(-28);
  expect(f.abi.imports.job_of!(99999)).toBe(-71);
});

test("kill_job terminates joined descendants while preserving independent background jobs", () => {
  const f = fixture();
  const child = f.spawn(), job = f.abi.imports.job_of!(child);
  const sibling = f.spawn([], job), background = f.spawn([], -1);
  expect(f.abi.imports.kill_job!(job, Signal.SIGKILL)).toBe(0);
  for (const pid of [child, sibling]) {
    expect(f.abi.imports.wait!(pid, 64)).toBe(0);
    expect(f.view().getUint32(64, true)).toBe(1);
    expect(f.view().getInt32(68, true)).toBe(9);
  }
  expect(f.abi.imports.wait!(background, 64)).toBe(-6);
  expect(f.abi.imports.kill_job!(99999, 2)).toBe(-71);
});

test("poll uses exact 16-byte subscription/event layouts with opaque u64 userdata", () => {
  const f = fixture();
  const [read, write] = f.pipe();
  f.put("x"); f.abi.imports.write!(write, 2048, 1);
  const child = f.spawn(); f.supervisor.exit(child, 0);
  const tag = 0xfedcba9876543210n;
  f.sub(0, 0, read, tag); f.sub(1, 1, write, 0x1020304050607080n); f.sub(2, 2, child, 9n);
  f.bytes().fill(0xaa, 512, 576);
  expect(f.abi.imports.poll!(256, 3, 0, 512)).toBe(3);
  expect(f.view().getBigUint64(512, true)).toBe(tag);
  expect(f.view().getUint32(520, true)).toBe(0);
  expect(f.view().getUint32(524, true)).toBe(0);
  expect(f.view().getBigUint64(528, true)).toBe(0x1020304050607080n);
  expect(f.view().getUint32(536, true)).toBe(1);
  expect(f.view().getUint32(540, true)).toBe(0);
  expect(f.view().getBigUint64(544, true)).toBe(9n);
  expect(f.view().getUint32(552, true)).toBe(2);
  expect(f.view().getUint32(556, true)).toBe(0);
  expect(f.bytes()[560]).toBe(0xaa);
});

test("poll waits for readiness, hangup, child exit or interrupt, not read/write/wait", () => {
  let tick = 0, action: () => void = () => {};
  const f = fixture({ now: () => tick, wait(ms) { tick += ms; action(); } });
  const [read, write] = f.pipe();
  f.sub(0, 0, read);
  expect(f.abi.imports.read!(read, 4096, 1)).toBe(-6);
  expect(tick).toBe(0);
  action = () => { f.put("x"); f.abi.imports.write!(write, 2048, 1); };
  expect(f.abi.imports.poll!(256, 1, 100, 512)).toBe(1);
  expect(tick).toBeGreaterThan(0);
  f.abi.imports.read!(read, 4096, 1);
  action = () => f.descriptors.close(write);
  expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(1);
  expect(f.view().getUint32(524, true)).toBe(1);
  const child = f.spawn(); f.sub(0, 2, child);
  action = () => f.supervisor.exit(child, 0);
  expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(1);
  f.sub(0, 0, f.pipe()[0]);
  expect(f.abi.imports.signal!(Signal.SIGINT, 2)).toBe(0);
  action = () => f.supervisor.kill(f.pid, Signal.SIGINT);
  expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(0);
  expect(f.abi.imports.interrupted!()).toBe(Signal.SIGINT);
});

test("poll timeout, invalid subscriptions and filesystem completion do not corrupt output", () => {
  let tick = 0, complete = false;
  const f = fixture({ now: () => tick, wait(ms) { tick += ms; complete = true; } });
  f.sub(0, 0, f.pipe()[0]);
  expect(f.abi.imports.poll!(256, 1, 7, 512)).toBe(0);
  expect(tick).toBe(7);
  f.sub(0, 9, 0);
  expect(f.abi.imports.poll!(256, 1, 0, 512)).toBe(-28);
  f.sub(0, 0, 99999);
  expect(f.abi.imports.poll!(256, 1, 0, 512)).toBe(-8);
  expect(f.abi.imports.poll!(65528, 1, 0, 512)).toBe(-21);
  expect(f.abi.imports.poll!(256, -1, 0, 512)).toBe(-21);
  expect(f.abi.imports.poll!(256, 1, 0, 65528)).toBe(-21);
  const service = { spawn: f.supervisor.spawn.bind(f.supervisor), wait: f.supervisor.wait.bind(f.supervisor), kill: f.supervisor.kill.bind(f.supervisor), killJob: f.supervisor.killJob.bind(f.supervisor), jobOf: f.supervisor.jobOf.bind(f.supervisor), defaultSignal: f.supervisor.defaultSignal.bind(f.supervisor), filesystemReady: (_pid: number, request: number) => request === 77 && complete };
  const other = new ProcessABI({ memory: f.memory, descriptors: f.descriptors, fs: f.fs, pid: f.pid, signals: f.signals, service });
  f.sub(0, 3, 77);
  expect(other.imports.poll!(256, 1, 0, 512)).toBe(1);
  expect(f.view().getUint32(520, true)).toBe(3);
});

test("signal registration, shared dequeue, ignored delivery and explicit default unwind", () => {
  const f = fixture();
  expect(f.abi.imports.signal!(9, 2)).toBe(-22);
  expect(f.abi.imports.signal!(0, 2)).toBe(-22);
  expect(f.abi.imports.signal!(2, 4)).toBe(-22);
  expect(f.abi.imports.signal!(2, 2)).toBe(0);
  expect(f.abi.imports.signal!(15, 2)).toBe(0);
  f.supervisor.kill(f.pid, 2); f.supervisor.kill(f.pid, 15);
  expect(f.abi.imports.interrupted!()).toBe(2);
  expect(f.abi.imports.signal!(0, 0)).toBe(15);
  expect(f.abi.imports.interrupted!()).toBe(0);
  expect(Atomics.load(f.signals.interrupt, 0)).toBe(0);
  expect(f.abi.imports.signal!(2, 1)).toBe(0);
  expect(f.abi.imports.signal!(2, 3)).toBe(0);
  expect(f.abi.imports.interrupted!()).toBe(0);
  expect(f.supervisor.get(f.pid)!.result).toBeNull();
  let error: unknown;
  try { f.abi.imports.default_signal!(15); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(ProcessSignalExit);
  expect(f.supervisor.get(f.pid)!.result).toEqual({ kind: "signaled", code: 15, status: 143 });
});

test("restoring default with a pending signal and raising a default signal terminate synchronously", () => {
  const f = fixture();
  f.abi.imports.signal!(2, 2); f.supervisor.kill(f.pid, 2);
  expect(() => f.abi.imports.signal!(2, 0)).toThrow(ProcessSignalExit);
  expect(f.supervisor.get(f.pid)!.result!.status).toBe(130);
  const other = fixture();
  expect(() => other.abi.imports.signal!(13, 3)).toThrow(ProcessSignalExit);
  expect(other.supervisor.get(other.pid)!.result!.status).toBe(141);
});

test("guest memory growth does not leave stale IO or poll output views", () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ wait() { f.memory.grow(1); f.put("x"); f.abi.imports.write!(write, 2048, 1); } });
  const [read, write] = f.pipe();
  f.sub(0, 0, read);
  expect(f.abi.imports.poll!(256, 1, 100, 512)).toBe(1);
  expect(f.view().getBigUint64(512, true)).toBe(1n);
  expect(f.abi.imports.read!(read, 65536, 1)).toBe(1);
  expect(f.bytes()[65536]).toBe(120);
});

test("guest kill authority rejects siblings and foreign jobs while allowing descendants", () => {
  const f = fixture();
  const first = f.spawn(), sibling = f.spawn();
  const record = f.supervisor.get(first)!;
  const child = new ProcessABI({ memory: f.memory, descriptors: record.descriptors, fs: f.fs, pid: first, service: f.supervisor, signals: record });
  expect(child.imports.kill!(sibling, 9)).toBe(-63);
  expect(child.imports.kill!(f.pid, 9)).toBe(-63);
  expect(child.imports.kill_job!(f.supervisor.jobOf(sibling), 9)).toBe(-63);
  const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] };
  const descendant = f.supervisor.reserveSpawn(first, request);
  expect(child.imports.kill!(descendant, 15)).toBe(0);
  expect(f.supervisor.wait(first, descendant)!.status).toBe(143);
  expect(f.supervisor.wait(f.pid, sibling)).toBeNull();
});

test("cold file I/O uses nonblocking hooks and commits only the successful retry", () => {
  let ready = false, commits = 0, text = "";
  class AsyncFiles extends MemFS {
    override read(): never { throw new Error("blocking file read"); }
    override write(): never { throw new Error("blocking file write"); }
    override append(): never { throw new Error("blocking file append"); }
    tryRead(_handle: number, chunks: readonly Uint8Array[]): number {
      if (!ready) return -6;
      chunks[0]!.set([120]); return 1;
    }
    tryWrite(_handle: number, chunks: readonly Uint8Array[]): number {
      if (!ready) return -6;
      commits++; text = decoder.decode(chunks[0]); return chunks[0]!.length;
    }
    tryAppend(handle: number, chunks: readonly Uint8Array[]) {
      const written = this.tryWrite(handle, chunks);
      return written < 0 ? written : { written, offset: 20 + written };
    }
    ioReadiness() { return { readable: ready, writable: ready, hangup: false }; }
    readiness(id: number) { return id === 8 ? { ready } : undefined; }
  }
  const f = fixture({ fs: new AsyncFiles(), wait() { ready = true; } });
  const resource = { kind: "file" as const, handle: 42, offset: 3, append: false };
  const fd = f.descriptors.open(resource, ALL, ALL);
  f.put("first");
  expect(f.abi.imports.write!(fd, 2048, 5)).toBe(-6);
  expect(resource.offset).toBe(3); expect(commits).toBe(0);
  f.sub(0, 1, fd); f.sub(1, 3, 8);
  expect(f.abi.imports.poll!(256, 2, 100, 512)).toBe(2);
  f.put("later");
  expect(f.abi.imports.write!(fd, 2048, 5)).toBe(5);
  expect(text).toBe("later"); expect(commits).toBe(1); expect(resource.offset).toBe(8);
  expect(f.abi.imports.read!(fd, 4096, 1)).toBe(1);
  expect(f.bytes()[4096]).toBe(120); expect(resource.offset).toBe(9);
  resource.append = true;
  expect(f.abi.imports.write!(fd, 2048, 5)).toBe(5);
  expect(resource.offset).toBe(25);
});

test("shared file-offset contention returns EAGAIN until poll can observe the lock release", () => {
  const identity = createFilesystemIdentity(undefined, 16 * 1024 * 1024);
  cleanups.push(() => reapFilesystem(identity));
  let cells!: Int32Array;
  const f = fixture({ wait() { Atomics.store(cells, 0, 0); } });
  const resource = { kind: "file" as const, handle: 0, offset: 0, append: false };
  const buffer = shareFileResource(resource, identity);
  cells = new Int32Array(buffer);
  const otherOwner = identity.owner + 1;
  Atomics.store(cells, 0, otherOwner);
  const fd = f.descriptors.open(resource, ALL, ALL);
  expect(f.abi.imports.read!(fd, 4096, 1)).toBe(-6);
  expect(resource.offset).toBe(0);
  f.sub(0, 0, fd);
  expect(f.abi.imports.poll!(256, 1, 100, 512)).toBe(1);
  expect(Atomics.load(cells, 0)).toBe(0);
});

test("poll observes remaining handled signals after a wake hint is consumed and returns on fatal interrupts", () => {
  const f = fixture();
  const [read] = f.pipe(); f.sub(0, 0, read);
  f.abi.imports.signal!(2, 2); f.abi.imports.signal!(15, 2);
  f.supervisor.kill(f.pid, 2); f.supervisor.kill(f.pid, 15);
  expect(f.abi.imports.interrupted!()).toBe(2);
  expect(Atomics.load(f.signals.interrupt, 0)).toBe(0);
  expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(0);
  expect(f.abi.imports.interrupted!()).toBe(15);
  f.supervisor.kill(f.pid, 9);
  expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(0);
  expect(() => f.abi.imports.interrupted!()).toThrow(ProcessSignalExit);
});

test("local pipe revocation registrations end with the last endpoint reference", () => {
  const f = fixture();
  const [read, write] = f.pipe();
  expect(f.supervisor.get(f.pid)!.revocations.size).toBe(1);
  const duplicate = f.abi.imports.dup!(write);
  f.descriptors.close(read); f.descriptors.close(write);
  expect(f.supervisor.get(f.pid)!.revocations.size).toBe(1);
  f.descriptors.close(duplicate);
  expect(f.supervisor.get(f.pid)!.revocations.size).toBe(0);
});

test("ABI never invokes a pipe's potentially blocking preview1 methods", () => {
  const f = fixture();
  const stream: Stream = { kind: "pipe", read() { throw new Error("blocking preview1 read"); }, write() { throw new Error("blocking preview1 write"); }, readiness: () => ({ readable: true, writable: true, hangup: false }) };
  const fd = f.descriptors.open(stream, ALL, ALL);
  expect(f.abi.imports.read!(fd, 4096, 1)).toBe(-52);
  expect(f.abi.imports.write!(fd, 2048, 1)).toBe(-52);
});

test("runtime_proc never calls the preview1 terminal's blocking stdin callback", () => {
  const f = fixture(); let calls = 0;
  const wasi = new Wasi({ args: [], env: {}, fs: f.fs, preopens: {}, stdout() {}, stderr() {}, sleep() {},
    stdin() { calls++; throw new Error("BLOCKING_STDIN_INVOKED"); },
  });
  cleanups.push(() => wasi.descriptors.dispose());
  wasi.start({ exports: { memory: f.memory, _start() {} } } as unknown as WebAssembly.Instance);
  const abi = new ProcessABI({ memory: f.memory, descriptors: wasi.descriptors, fs: f.fs, pid: f.pid, service: f.supervisor, signals: f.signals });
  expect(abi.imports.read!(0, 4096, 1)).toBe(-6);
  expect(calls).toBe(0);
  f.put("output");
  expect(abi.imports.write!(1, 2048, 6)).toBe(6);
});

test("blocking terminal stdin does not turn async read-poll-read into a hot loop", () => {
  const f = fixture(); let calls = 0, waits = 0;
  const wasi = new Wasi({ args: [], env: {}, fs: f.fs, preopens: {}, stdout() {}, stderr() {},
    sleep() { throw new Error("preview1 stdin poll changed its existing immediate semantics"); },
    stdin() { calls++; return new Uint8Array([122]); },
  });
  cleanups.push(() => wasi.descriptors.dispose());
  wasi.start({ exports: { memory: f.memory, _start() {} } } as unknown as WebAssembly.Instance);
  const functions = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions();
  f.view().setUint8(8, 1); f.view().setUint32(16, 0, true);
  expect(functions.poll_oneoff!(0, 1024, 1, 2048)).toBe(0);
  expect(f.view().getUint32(2048, true)).toBe(1);
  const abi = new ProcessABI({ memory: f.memory, descriptors: wasi.descriptors, fs: f.fs, pid: f.pid, service: f.supervisor, signals: f.signals,
    wait() { waits++; f.supervisor.kill(f.pid, 2); },
  });
  abi.imports.signal!(2, 2);
  expect(abi.imports.read!(0, 4096, 1)).toBe(-6);
  f.sub(0, 0, 0);
  expect(abi.imports.poll!(256, 1, -1, 512)).toBe(0);
  expect(waits).toBe(1);
  expect(abi.imports.interrupted!()).toBe(2);
  expect(abi.imports.read!(0, 4096, 1)).toBe(-6);
  expect(calls).toBe(0);
  f.view().setUint32(64, 4096, true); f.view().setUint32(68, 1, true);
  expect(functions.fd_read!(0, 64, 1, 80)).toBe(0);
  expect(f.view().getUint32(80, true)).toBe(1);
  expect(f.bytes()[4096]).toBe(122);
  expect(calls).toBe(1);
});

test("async terminal EOF remains ready and unsupported hangup does not mask a supported direction", () => {
  const f = fixture();
  const wasi = new Wasi({ args: [], env: {}, fs: f.fs, preopens: {}, stdout() {}, stderr() {}, sleep() {} });
  cleanups.push(() => wasi.descriptors.dispose());
  const abi = new ProcessABI({ memory: f.memory, descriptors: wasi.descriptors, fs: f.fs, pid: f.pid, service: f.supervisor, signals: f.signals,
    wait() { throw new Error("EOF terminal must not wait"); },
  });
  f.sub(0, 0, 0);
  expect(abi.imports.poll!(256, 1, -1, 512)).toBe(1);
  expect(f.view().getUint32(524, true)).toBe(1);
  expect(abi.imports.read!(0, 4096, 1)).toBe(0);
  const terminal: Stream = { kind: "terminal", read: () => 0, write: () => 0, tryWrite: chunks => chunks[0]!.length,
    readiness: () => ({ readable: true, writable: true, hangup: true }),
  };
  const fd = wasi.descriptors.open(terminal, ALL, ALL);
  f.sub(0, 0, fd);
  expect(abi.imports.poll!(256, 1, 0, 512)).toBe(0);
  f.sub(0, 1, fd);
  expect(abi.imports.poll!(256, 1, 0, 512)).toBe(1);
  expect(abi.imports.write!(fd, 2048, 1)).toBe(1);
});

test("custom terminal immediate I/O keeps its explicit async readiness contract", () => {
  const f = fixture(); let ready = false, waits = 0;
  const stdin: Stream = { kind: "terminal", read() { throw new Error("blocking read entered"); }, write: () => 0,
    tryRead(chunks) { if (!ready) return -6; chunks[0]![0] = 120; ready = false; return 1; },
    readiness: () => ({ readable: ready, writable: false, hangup: false }),
  };
  const wasi = new Wasi({ args: [], env: {}, fs: f.fs, preopens: {}, stdout() {}, stderr() {}, sleep() {}, stdio: { 0: stdin } });
  cleanups.push(() => wasi.descriptors.dispose());
  const abi = new ProcessABI({ memory: f.memory, descriptors: wasi.descriptors, fs: f.fs, pid: f.pid, service: f.supervisor, signals: f.signals,
    wait() { waits++; ready = true; },
  });
  expect(abi.imports.read!(0, 4096, 1)).toBe(-6);
  f.sub(0, 0, 0);
  expect(abi.imports.poll!(256, 1, -1, 512)).toBe(1);
  expect(waits).toBe(1);
  expect(abi.imports.read!(0, 4096, 1)).toBe(1);
  expect(f.bytes()[4096]).toBe(120);
});

test("spawn rejects unrepresentable fd bindings and high valid fd allocation stays positive and resolvable", () => {
  const endpoint = (): Stream => ({ kind: "pipe", read: () => 0, write: () => 0, readiness: () => ({ readable: true, writable: true, hangup: false }) });
  const f = fixture({ createPipe: () => [endpoint(), endpoint()] });
  const fd = f.descriptors.open({ kind: "directory", handle: 42 }, ALL, ALL);
  expect(f.spawn([{ child: 0xffffffff, parent: fd }])).toBe(-28);
  f.descriptors.inherit(0x7fffffff, f.descriptors.get(fd)!);
  const guest = new WebAssembly.Instance(guestModule(), { env: { memory: f.memory }, runtime_proc: f.abi.imports });
  const dup = guest.exports.dup as (fd: number) => number;
  const duplicate = dup(fd);
  expect(duplicate).toBeGreaterThanOrEqual(0);
  expect(duplicate).toBeLessThanOrEqual(0x7fffffff);
  expect(f.descriptors.get(duplicate)).toBeDefined();
  const [read, write] = f.pipe();
  expect(f.descriptors.get(read)!.resource.kind).toBe("pipe");
  expect(f.descriptors.get(write)!.resource.kind).toBe("pipe");
  expect(read).not.toBe(write);
  expect(f.descriptors.get(fd)!.resource.kind).toBe("directory");
});

test("the wait hook receives the sequence captured before a racing ready publication", () => {
  const wake = new Int32Array(new SharedArrayBuffer(4)); let ready = false;
  const f = fixture({ wake, wait(milliseconds, word, expected) {
    ready = true; Atomics.add(wake, 0, 1); Atomics.notify(wake, 0);
    expect(word).toBe(wake); expect(expected).toBe(0);
    expect(Atomics.wait(word, 0, expected, milliseconds)).toBe("not-equal");
  } });
  const stream: Stream = { kind: "pipe", notification: wake, read: () => 0, write: () => 0,
    readiness: () => ({ readable: ready, writable: false, hangup: false }) };
  f.sub(0, 0, f.descriptors.open(stream, ALL, ALL));
  expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(1);
});

for (const mode of ["signal", "child"] as const) {
  test(`native worker poll wakes for a ${mode} change without any common-wake notification`, async () => {
    const f = fixture(), wake = new Int32Array(new SharedArrayBuffer(4));
    f.abi.imports.signal!(2, 2);
    const child = f.supervisor.reserveSpawn(f.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    const worker = new Worker(new URL("./fixtures/process-abi-poll-guest.ts", import.meta.url), { workerData: { mode, pid: f.pid, child, childOutcome: f.supervisor.get(child)!.outcome, wake,
      signals: { signalState: f.signals.signalState, interrupt: f.signals.interrupt, requestedSignal: f.signals.requestedSignal, outcome: f.signals.outcome },
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`poll missed ${mode} publication on an independent source`));
          // Release a regressed unbounded waiter before teardown; do not mistake this for success.
          Atomics.add(wake, 0, 1); Atomics.notify(wake, 0);
        }, 1000);
        worker.once("error", reject);
        worker.once("exit", code => { if (code !== 0) reject(new Error(`native poll worker exited ${code}`)); });
        let published = false;
        worker.on("message", message => {
          if (message.phase === "waiting") {
            if (published) return;
            published = true;
            if (mode === "signal") f.supervisor.kill(f.pid, 2); else f.supervisor.exit(child, 23);
          } else resolve(message);
        });
      });
      expect(result).toEqual(mode === "signal" ? { phase: "done", ready: 0, interrupt: 2, code: 0 } : { phase: "done", ready: 1, interrupt: 0, code: 23 });
      expect(Atomics.load(wake, 0)).toBe(0);
    } finally { clearTimeout(timer); await worker.terminate(); }
  });
}

function guestModule(): WebAssembly.Module {
  // Import/re-export the ABI through a real WASM boundary, plus the same linear memory.
  const names = ["read", "write", "poll", "dup"];
  const text = (value: string) => Array.from(encoder.encode(value));
  const str = (value: string) => [text(value).length].concat(text(value));
  const section = (id: number, payload: number[]) => [id, payload.length].concat(payload);
  const type = [3, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f];
  const imports = [5].concat(str("env"), str("memory"), [2, 0, 1], names.flatMap((name, index) => str("runtime_proc").concat(str(name), [0, index === 3 ? 2 : index === 2 ? 1 : 0])));
  const exports = [4].concat(names.flatMap((name, index) => str(name).concat([0, index === 3 ? 4 : index])));
  // dup goes through a defined WASM function so its host result crosses the actual i32 boundary.
  const functions = [1, 2], code = [1, 6, 0, 0x20, 0, 0x10, 3, 0x0b];
  const binary = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(section(1, type), section(2, imports), section(3, functions), section(7, exports), section(10, code)));
  return new WebAssembly.Module(binary);
}

test("async-style WASM guest imports return synchronously and block only in poll", () => {
  const f = fixture();
  const guest = new WebAssembly.Instance(guestModule(), { env: { memory: f.memory }, runtime_proc: f.abi.imports });
  const funcs = guest.exports as Record<string, (...args: number[]) => number>;
  const [read, write] = f.pipe();
  expect(funcs.read!(read, 4096, 1)).toBe(-6);
  f.put("x"); expect(funcs.write!(write, 2048, 1)).toBe(1);
  f.sub(0, 0, read); expect(funcs.poll!(256, 1, 0, 512)).toBe(1);
  expect(f.waits()).toBe(0);
});

test("a worker-hosted WASM guest returns EAGAIN before poll blocks and wakes on a pipe publish", async () => {
  const f = fixture(), [read, write] = f.pipe();
  const endpoint = f.descriptors.get(read)!.resource as Stream & { handle(): PipeEndpointHandle };
  const worker = new Worker(new URL("./fixtures/process-abi-guest.ts", import.meta.url), { workerData: {
    endpoint: endpoint.handle(), module: guestModule(), pid: f.pid,
    signals: { interrupt: f.signals.interrupt, requestedSignal: f.signals.requestedSignal, signalState: f.signals.signalState, outcome: f.signals.outcome },
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("worker guest poll did not wake")), 5000);
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
      worker.on("message", message => {
        if (message.phase === "before-poll") {
          if (message.read !== -6) reject(new Error("guest read blocked or failed to report EAGAIN"));
        } else if (message.phase === "blocked") {
          f.put("x");
          if (f.abi.imports.write!(write, 2048, 1) !== 1) reject(new Error("parent pipe publish failed"));
        } else resolve(message);
      });
    });
    expect(result).toEqual({ phase: "done", ready: 1, count: 1, byte: 120, userdata: 77n });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
