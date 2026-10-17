import { afterEach, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { Wasi, type WasiOptions } from "../core/wasi";
import type { Readiness, Stream } from "../core/descriptors";
import { MemFS } from "../fs/memory";
import { PipeController } from "../proc/pipes";
import { createSignalState, requestSignal, setSignalDisposition, takeSignal } from "../proc/signals";
import { outcomeWord } from "../proc/outcome";

const ALL = (1n << 29n) - 1n;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
type Wait = (word: Int32Array, expected: number, milliseconds: number) => void;
function fixture(options: Partial<WasiOptions> & { wait?: Wait; interrupt?: Int32Array } = {}) {
  const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {},
    sleep() { throw new Error("poll slept on an unrelated cell instead of the stream notification"); }, ...options });
  cleanups.push(() => wasi.descriptors.dispose());
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  wasi.start({ exports: { memory, _start() {} } } as unknown as WebAssembly.Instance);
  const view = () => new DataView(memory.buffer);
  const subscribe = (index: number, fd: number, type = 1, userdata = BigInt(fd)) => {
    const at = index * 48;
    view().setBigUint64(at, userdata, true); view().setUint8(at + 8, type); view().setUint32(at + 16, fd, true);
  };
  const clock = (index: number, nanoseconds: bigint, userdata = 99n) => {
    const at = index * 48;
    subscribe(index, 0, 0, userdata);
    view().setUint32(at + 16, 1, true); view().setBigUint64(at + 24, nanoseconds, true);
  };
  const functions = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions();
  const poll = (count = 1) => functions.poll_oneoff!(0, 1024, count, 2048);
  return { wasi, memory, view, subscribe, clock, poll };
}
function endpoint(state: Readiness, notification?: Int32Array): Stream & { notification?: Int32Array } {
  return { kind: "pipe", read: () => 0, write: () => 0, readiness: () => state, notification };
}
const idle = (): Readiness => ({ readable: false, writable: false, hangup: false });
function publish(word: Int32Array): void { Atomics.add(word, 0, 1); Atomics.notify(word, 0); }

test("preview1 poll waits directly on the stream notification and retains its event layout", () => {
  const notification = new Int32Array(new SharedArrayBuffer(4)), state = idle();
  let waits = 0;
  const f = fixture({ wait(word, expected, milliseconds) {
    waits++;
    expect(word).toBe(notification); expect(expected).toBe(0); expect(milliseconds).toBe(Infinity);
    state.readable = true; state.nbytes = 7; publish(notification);
  } });
  const fd = f.wasi.descriptors.open(endpoint(state, notification), ALL, ALL);
  f.subscribe(0, fd, 1, 0xfedcba9876543210n);
  expect(f.poll()).toBe(0);
  expect(waits).toBe(1);
  expect(f.view().getUint32(2048, true)).toBe(1);
  expect(f.view().getBigUint64(1024, true)).toBe(0xfedcba9876543210n);
  expect(f.view().getUint16(1032, true)).toBe(0);
  expect(f.view().getUint8(1034)).toBe(1);
  expect(f.view().getBigUint64(1040, true)).toBe(7n);
});

test("notification sequence is observed before readiness so a racing publish cannot be lost", () => {
  const notification = new Int32Array(new SharedArrayBuffer(4));
  let scans = 0, waits = 0;
  const stream = endpoint(idle(), notification);
  stream.readiness = () => {
    if (++scans === 1) { publish(notification); return idle(); }
    return { readable: true, writable: false, hangup: false };
  };
  const f = fixture({ wait(word, expected) {
    waits++;
    expect(expected).toBe(0); expect(Atomics.load(word, 0)).toBe(1);
    expect(Atomics.wait(word, 0, expected, 0)).toBe("not-equal");
  } });
  const fd = f.wasi.descriptors.open(stream, ALL, ALL);
  f.subscribe(0, fd);
  expect(f.poll()).toBe(0);
  expect(waits).toBe(1); expect(scans).toBe(2);
});

test("different views of one shared notification form one unbounded wait source", () => {
  const buffer = new SharedArrayBuffer(12);
  const first = new Int32Array(buffer, 4, 1), second = new Int32Array(buffer, 4, 1);
  const blocked = idle(), ready = idle();
  const f = fixture({ wait(word, _expected, milliseconds) {
    expect(word.buffer).toBe(buffer); expect(word.byteOffset).toBe(4); expect(milliseconds).toBe(Infinity);
    ready.writable = true; publish(second);
  } });
  const firstFd = f.wasi.descriptors.open(endpoint(blocked, first), ALL, ALL);
  const secondFd = f.wasi.descriptors.open(endpoint(ready, second), ALL, ALL);
  f.subscribe(0, firstFd); f.subscribe(1, secondFd, 2);
  expect(f.poll(2)).toBe(0);
  expect(f.view().getUint32(2048, true)).toBe(1);
  expect(f.view().getBigUint64(1024, true)).toBe(BigInt(secondFd));
  expect(f.view().getUint8(1034)).toBe(2);
});

test("distinct notification sources use a bounded notified wait and recheck every fd", () => {
  const first = new Int32Array(new SharedArrayBuffer(4)), second = new Int32Array(new SharedArrayBuffer(4));
  const firstState = idle(), secondState = idle();
  const f = fixture({ wait(word, _expected, milliseconds) {
    expect(word).toBe(first); expect(milliseconds).toBeGreaterThan(0); expect(milliseconds).toBeLessThanOrEqual(10);
    secondState.readable = true; publish(second);
  } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(firstState, first), ALL, ALL));
  const secondFd = f.wasi.descriptors.open(endpoint(secondState, second), ALL, ALL);
  f.subscribe(1, secondFd);
  expect(f.poll(2)).toBe(0);
  expect(f.view().getBigUint64(1024, true)).toBe(BigInt(secondFd));
});

test("stream plus legacy descriptor keeps bounded fallback without discarding the stream wake", () => {
  const notification = new Int32Array(new SharedArrayBuffer(4)), state = idle(), legacy = idle();
  const f = fixture({ wait(word, _expected, milliseconds) {
    expect(word).toBe(notification); expect(milliseconds).toBeLessThanOrEqual(10);
    legacy.readable = true;
  } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(state, notification), ALL, ALL));
  const legacyFd = f.wasi.descriptors.open(endpoint(legacy), ALL, ALL);
  f.subscribe(1, legacyFd);
  expect(f.poll(2)).toBe(0);
  expect(f.view().getBigUint64(1024, true)).toBe(BigInt(legacyFd));
});

test("legacy streams still use the sleep hook and do not enter an atomic wait", () => {
  const state = idle(); let sleeps = 0;
  const f = fixture({ sleep(milliseconds) { sleeps++; expect(milliseconds).toBeLessThanOrEqual(10); state.readable = true; },
    wait() { throw new Error("legacy descriptor has no notification"); } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(state), ALL, ALL));
  expect(f.poll()).toBe(0); expect(sleeps).toBe(1);
});

test("stream waits are bounded by clock deadlines and expired clocks never wait", () => {
  const notification = new Int32Array(new SharedArrayBuffer(4)), state = idle();
  let waits = 0;
  const f = fixture({ wait(_word, _expected, milliseconds) {
    waits++; expect(milliseconds).toBeGreaterThan(0); expect(milliseconds).toBeLessThanOrEqual(1000);
    state.readable = true;
  } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(state, notification), ALL, ALL));
  f.clock(1, 1_000_000_000n);
  expect(f.poll(2)).toBe(0); expect(waits).toBe(1);
  state.readable = false; f.clock(1, 0n);
  expect(f.poll(2)).toBe(0); expect(waits).toBe(1);
  expect(f.view().getUint8(1034)).toBe(0);
  expect(f.view().getBigUint64(1024, true)).toBe(99n);
});

test("a handled signal interrupts preview1 poll without consuming its hint or pending delivery", () => {
  const signals = { signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)), requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord() };
  setSignalDisposition(signals.signalState, 2, 2);
  const notification = new Int32Array(new SharedArrayBuffer(4));
  const f = fixture({ interrupt: signals.interrupt, wait(_word, _expected, milliseconds) {
    expect(milliseconds).toBeLessThanOrEqual(10);
    requestSignal(signals, 2);
  } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(idle(), notification), ALL, ALL));
  expect(f.poll()).toBe(27);
  expect(Atomics.load(signals.interrupt, 0)).toBe(2);
  expect(takeSignal(signals.signalState)).toBe(2);
});

test("an already pending interrupt returns EINTR without sleeping or changing event memory", () => {
  const interrupt = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(interrupt, 0, 15);
  const f = fixture({ interrupt, wait() { throw new Error("pending interrupt slept"); } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(idle()), ALL, ALL));
  f.view().setUint32(1024, 0xabcdef12, true);
  expect(f.poll()).toBe(27);
  expect(f.view().getUint32(1024, true)).toBe(0xabcdef12);
  expect(Atomics.load(interrupt, 0)).toBe(15);
});

test("clock-only preview1 poll can wait on the interrupt cell and preserve signal delivery", () => {
  const interrupt = new Int32Array(new SharedArrayBuffer(4));
  const f = fixture({ interrupt, wait(word, expected, milliseconds) {
    expect(word).toBe(interrupt); expect(expected).toBe(0); expect(milliseconds).toBeGreaterThan(0);
    expect(milliseconds).toBeLessThanOrEqual(1000); Atomics.store(interrupt, 0, 2); Atomics.notify(interrupt, 0);
  } });
  f.clock(0, 1_000_000_000n);
  expect(f.poll()).toBe(27);
  expect(Atomics.load(interrupt, 0)).toBe(2);
});

test("preview1 poll refreshes its output view after a notification wait grows guest memory", () => {
  const notification = new Int32Array(new SharedArrayBuffer(4)), state = idle();
  let f: ReturnType<typeof fixture>;
  f = fixture({ wait() { f.memory.grow(1); state.readable = true; state.hangup = true; } });
  f.subscribe(0, f.wasi.descriptors.open(endpoint(state, notification), ALL, ALL));
  expect(f.poll()).toBe(0);
  expect(f.view().getUint32(2048, true)).toBe(1);
  expect(f.view().getUint16(1048, true)).toBe(1);
});

test("worker preview1 poll wakes from the same pipe endpoint used by ordinary fd_read", async () => {
  const controller = new PipeController({ capacity: 8 });
  const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
  // Install all teardown before starting the worker. The parent owns both endpoint references.
  cleanups.push(() => { reader.close(); writer.close(); });
  const worker = new Worker(new URL("./fixtures/wasi-poll-guest.ts", import.meta.url), { workerData: { endpoint: reader.handle() } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("preview1 pipe notification did not wake poll")), 5000);
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error(`preview1 poll worker exited ${code}`)); });
      worker.on("message", message => {
        if (message.phase === "waiting") {
          if (message.milliseconds !== Infinity) { reject(new Error("single pipe used timed polling")); return; }
          if (writer.tryWrite([new Uint8Array([65, 66])]) !== 2) reject(new Error("parent pipe write failed"));
        } else resolve(message);
      });
    });
    expect(result).toEqual({ phase: "done", poll: 0, events: 1, userdata: 77n, read: 0, bytes: [65, 66] });
  } finally { clearTimeout(timer); await worker.terminate(); }
});
