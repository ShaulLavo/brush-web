import { afterEach, describe, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import { ProcessError } from "../proc/types";
import { attachPipeController, attachPipeEndpoint, attachPipePublicationRegistry, PipeController, PipeErrno, PipePublicationRegistry } from "../proc/pipes";

const encode = new TextEncoder();
const decode = new TextDecoder();
const controllers: PipeController[] = [];
function pipe(capacity = 8) {
  const controller = new PipeController({ capacity });
  controllers.push(controller);
  const reader = controller.retain(1, "read");
  const writer = controller.retain(2, "write");
  return { controller, reader, writer };
}
function output(endpoint: ReturnType<PipeController["retain"]>, capacity = 64) {
  const bytes = new Uint8Array(capacity);
  const count = endpoint.tryRead([bytes]);
  return count < 0 ? count : decode.decode(bytes.subarray(0, count));
}
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });

describe("process pipe endpoints", () => {
  test("zero-length IO succeeds without waiting, including closed opposite ends", () => {
    const { reader, writer } = pipe();
    expect(reader.tryRead([])).toBe(0);
    expect(writer.tryWrite([new Uint8Array()])).toBe(0);
    expect(reader.read([new Uint8Array()])).toBe(0);
    expect(writer.write([])).toBe(0);
    reader.close();
    expect(writer.tryWrite([])).toBe(0);
    expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.PIPE);
  });

  test("bounded partial scatter/gather IO wraps without overwriting queued bytes", () => {
    const { reader, writer } = pipe();
    expect(writer.tryWrite([encode.encode("abc"), encode.encode("defghi")])).toBe(8);
    expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.AGAIN);
    expect(output(reader, 3)).toBe("abc");
    expect(writer.tryWrite([encode.encode("XYZ")])).toBe(3);
    const first = new Uint8Array(2), second = new Uint8Array(6);
    expect(reader.tryRead([first, second])).toBe(5);
    expect(decode.decode(first) + decode.decode(second.subarray(0, 3))).toBe("defgh");
    expect(output(reader)).toBe("XYZ");
    expect(output(reader)).toBe(-PipeErrno.AGAIN);
  });

  test("read and write access modes are enforced", () => {
    const { reader, writer } = pipe();
    expect(reader.tryWrite([])).toBe(-PipeErrno.BADF);
    expect(writer.tryRead([])).toBe(-PipeErrno.BADF);
    reader.close();
    expect(reader.tryRead([])).toBe(-PipeErrno.BADF);
  });

  test("a process's duplicate writers share one ring, other processes have independent capacity", () => {
    const { controller, reader, writer } = pipe();
    const duplicate = controller.duplicate(writer), inherited = writer.forProcess(3);
    expect(duplicate.handle().slot).toBe(writer.handle().slot);
    expect(inherited.handle().slot).not.toBe(writer.handle().slot);
    expect(writer.tryWrite([encode.encode("12345678")])).toBe(8);
    expect(duplicate.tryWrite([encode.encode("x")])).toBe(-PipeErrno.AGAIN);
    expect(inherited.tryWrite([encode.encode("abcdefgh")])).toBe(8);
    let all = "";
    all += output(reader, 8);
    all += output(reader, 8);
    expect(all).toBe("12345678abcdefgh");
  });

  test("merging retains a write record across short reads, then advances to the next writer", () => {
    const { reader, writer } = pipe();
    const second = writer.forProcess(3);
    writer.tryWrite([encode.encode("AAAA")]);
    second.tryWrite([encode.encode("BBBB")]);
    expect(output(reader, 2)).toBe("AA");
    expect(output(reader, 2)).toBe("AA");
    expect(output(reader, 2)).toBe("BB");
    expect(output(reader, 2)).toBe("BB");
  });

  test("EOF waits for every inherited writer and drains queued bytes first", () => {
    const { reader, writer } = pipe();
    const inherited = writer.forProcess(3);
    writer.tryWrite([encode.encode("before")]);
    writer.close();
    expect(output(reader)).toBe("before");
    expect(output(reader)).toBe(-PipeErrno.AGAIN);
    inherited.tryWrite([encode.encode("after")]);
    inherited.close();
    expect(reader.readiness()).toMatchObject({ readable: true, hangup: true, nbytes: 5 });
    expect(output(reader)).toBe("after");
    expect(output(reader)).toBe("");
  });

  test("descriptor duplicates hold a single endpoint until the final fd closes", () => {
    const { reader, writer } = pipe();
    const descriptors = new DescriptorTable();
    const fd = descriptors.open(writer, 0n, 0n);
    const duplicate = descriptors.dup(fd);
    descriptors.close(fd);
    expect(output(reader)).toBe(-PipeErrno.AGAIN);
    descriptors.close(duplicate);
    expect(output(reader)).toBe("");
  });

  test("explicit endpoint refs retain the writer independently", () => {
    const { controller, reader, writer } = pipe();
    const duplicate = controller.duplicate(writer);
    writer.close();
    expect(duplicate.tryWrite([encode.encode("ok")])).toBe(2);
    expect(output(reader)).toBe("ok");
    expect(output(reader)).toBe(-PipeErrno.AGAIN);
    duplicate.close();
    expect(output(reader)).toBe("");
  });

  test("last reader close immediately gives EPIPE and writable hangup", () => {
    const { controller, reader, writer } = pipe();
    const duplicate = controller.duplicate(reader);
    reader.close();
    expect(writer.tryWrite([encode.encode("ok")])).toBe(2);
    duplicate.close();
    expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.PIPE);
    expect(writer.readiness()).toMatchObject({ writable: false, hangup: true });
  });

  test("revoking a writer drains committed output, keeps live writers, and disallows new refs", () => {
    const { controller, reader, writer } = pipe();
    const live = writer.forProcess(3);
    writer.tryWrite([encode.encode("queued")]);
    controller.revoke(2);
    expect(output(reader)).toBe("queued");
    expect(output(reader)).toBe(-PipeErrno.AGAIN);
    expect(writer.tryWrite([encode.encode("late")])).toBe(-PipeErrno.BADF);
    expect(() => controller.retain(2, "write")).toThrow();
    live.close();
    expect(output(reader)).toBe("");
  });

  test("kill between producer's check/copy and publish never exposes delayed bytes", () => {
    const { controller, reader, writer } = pipe();
    writer.tryWrite([encode.encode("good")]);
    const source = encode.encode("evil");
    const original = source.subarray.bind(source);
    source.subarray = (begin, end) => { controller.revoke(2); return original(begin, end); };
    expect(writer.tryWrite([source])).toBe(-PipeErrno.BADF);
    expect(output(reader)).toBe("good");
    expect(output(reader)).toBe("");
  });

  test("a dead writer's buffer is not reassigned to another writer", () => {
    const { controller, reader, writer } = pipe();
    const slot = writer.handle().slot;
    controller.revoke(2);
    const next = controller.retain(3, "write");
    expect(next.handle().slot).not.toBe(slot);
    next.tryWrite([encode.encode("new")]);
    expect(output(reader)).toBe("new");
  });

  test("structured cloned handles share capabilities and idempotent closure", () => {
    const { reader, writer } = pipe();
    const attached = attachPipeEndpoint(structuredClone(writer.handle()));
    expect(attached.tryWrite([encode.encode("worker")])).toBe(6);
    expect(output(reader)).toBe("worker");
    attached.close();
    writer.close();
    expect(output(reader)).toBe("");
  });

  test("readiness wait wakes for data, EOF, freed capacity, and reader revocation", async () => {
    const { controller, reader, writer } = pipe();
    const ready = reader.waitReadable();
    writer.tryWrite([encode.encode("12345678")]);
    await ready;
    const writable = writer.waitWritable();
    expect(output(reader)).toBe("12345678");
    await writable;
    const eof = reader.waitReadable();
    writer.close();
    await eof;
    expect(reader.readiness().hangup).toBe(true);
    const second = pipe();
    second.writer.tryWrite([encode.encode("12345678")]);
    const broken = second.writer.waitWritable();
    second.controller.revoke(1);
    await broken;
    expect(second.writer.readiness().hangup).toBe(true);
    controller.revoke(1);
  });

  test("every IO transition notifies the service-wide poll word", () => {
    const wake = new Int32Array(new SharedArrayBuffer(4));
    const controller = new PipeController({ capacity: 8, wake });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    const changed = (operation: () => void) => {
      const before = Atomics.load(wake, 0);
      operation();
      expect(Atomics.load(wake, 0)).not.toBe(before);
    };
    changed(() => { writer.tryWrite([encode.encode("x")]); });
    changed(() => { output(reader); });
    changed(() => { writer.close(); });
    changed(() => { controller.revoke(1); });
    const attachedWake = attachPipeEndpoint(structuredClone(reader.handle())).notification;
    Atomics.add(attachedWake, 0, 1);
    expect(Atomics.load(attachedWake, 0)).toBe(Atomics.load(wake, 0));
  });
});

describe("supervisor-owned multi-reader relay", () => {
  test("switches without replaying bytes already read directly and distributes each byte once", () => {
    const { controller, reader, writer } = pipe(16);
    writer.tryWrite([encode.encode("0123456789")]);
    expect(output(reader, 2)).toBe("01");
    const inherited = reader.forProcess(4);
    expect(controller.mode).toBe("relay");
    expect(output(reader)).toBe(-PipeErrno.AGAIN);
    expect(output(inherited)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    let received = "";
    for (const endpoint of [reader, inherited]) {
      const value = output(endpoint);
      if (typeof value === "string") received += value;
    }
    expect(received.split("").sort().join("")).toBe("23456789");
    writer.close();
    controller.pumpRelay();
    expect(output(reader)).toBe("");
    expect(output(inherited)).toBe("");
  });

  test("revocation during a relay chunk does not deliver bytes to a dead reader", () => {
    const { controller, reader, writer } = pipe();
    const inherited = reader.forProcess(4);
    controller.revoke(1);
    writer.tryWrite([encode.encode("alive")]);
    expect(output(inherited)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(output(reader)).toBe(-PipeErrno.BADF);
    expect(output(inherited)).toBe("alive");
    controller.revoke(4);
    expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.PIPE);
  });

  test("relay is serviced automatically for async readers and closes after every producer drains", async () => {
    const { reader, writer } = pipe();
    const inherited = reader.forProcess(4);
    const firstReady = reader.waitReadable(), secondReady = inherited.waitReadable();
    writer.tryWrite([encode.encode("abc")]);
    writer.close();
    await Promise.all([firstReady, secondReady]);
    const first = await asynchronousOutput(reader), second = await asynchronousOutput(inherited);
    expect(first + second).toBe("abc");
    expect(output(reader)).toBe("");
    expect(output(inherited)).toBe("");
  });

  test("bounded reader delivery buffers backpressure writers without data loss", () => {
    const { controller, reader, writer } = pipe();
    const inherited = reader.forProcess(4);
    let received = "";
    for (let round = 0; round < 8; round++) {
      const value = String(round).repeat(8);
      expect(writer.tryWrite([encode.encode(value)])).toBe(8);
      output(reader); output(inherited);
      controller.pumpRelay();
      for (const endpoint of [reader, inherited]) {
        const chunk = output(endpoint);
        if (typeof chunk === "string") received += chunk;
      }
    }
    expect(received.length).toBe(64);
    for (let round = 0; round < 8; round++) expect(received.split(String(round)).length - 1).toBe(8);
  });
});

/** Probe the actual commit cell, not a duplicate flag, to exercise the final publish race. */
function publication(endpoint: ReturnType<PipeController["retain"]>): BigInt64Array {
  const handle = endpoint.handle();
  const at = ringOffset(handle);
  if (!handle.registry) return new BigInt64Array(handle.buffer, at + 8, 1);
  const mapped = Atomics.load(new Int32Array(handle.buffer, at + 24, 1), 0);
  return attachPipePublicationRegistry(handle.registry).canonical(mapped - 1);
}

describe("canonical publication revocation", () => {
  test("registry-only kill freezes an unknown pipe and preserves precisely its committed prefix", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
    const controller = new PipeController({ capacity: 16, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("accepted")]);
    attachPipePublicationRegistry(structuredClone(registry.handle())).revoke(2);
    expect(Atomics.load(publication(writer), 0) & 0xffffffffn).toBe(8n);
    expect(writer.tryWrite([encode.encode("zombie")])).toBe(-PipeErrno.BADF);
    expect(output(reader)).toBe("accepted");
    expect(output(reader)).toBe("");
    expect(() => controller.retain(2, "write")).toThrow();
  });

  test("registry freezes unused cells too, preventing registration after unknown-process kill", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 4, cellsPerProcess: 4 });
    registry.revoke(99);
    const controller = new PipeController({ capacity: 8, registry });
    controllers.push(controller);
    expect(() => controller.retain(99, "write")).toThrow();
    expect(() => registry.allocate(99)).toThrow();
    // A fresh pid has a fresh permanent row even when its initial hash collides.
    const writer = controller.retain(103, "write");
    expect(writer.handle().pid).toBe(103);
  });

  test("kill after the final liveness check still defeats the producer CAS", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
    const controller = new PipeController({ capacity: 8, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("old")]);
    const original = Atomics.compareExchange;
    let intercepted = false;
    Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
      if (!intercepted && array instanceof BigInt64Array && (replacement & 0xffffffffn) === 6n) {
        intercepted = true;
        registry.revoke(2);
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try { expect(writer.tryWrite([encode.encode("new")])).toBe(-PipeErrno.BADF); }
    finally { Atomics.compareExchange = original; }
    expect(intercepted).toBe(true);
    expect(output(reader)).toBe("old");
    expect(output(reader)).toBe("");
  });

  test("direct-reader handoff revokes an already copied but not consumed read", () => {
    const { controller, reader, writer } = pipe();
    writer.tryWrite([encode.encode("safe")]);
    const original = Atomics.compareExchange;
    let inherited: typeof reader | undefined;
    Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
      if (!inherited && array instanceof BigInt64Array && (replacement & 0xffffffffn) === 4n) inherited = reader.forProcess(4);
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    const bytes = new Uint8Array(8);
    try { expect(reader.tryRead([bytes])).toBe(-PipeErrno.AGAIN); }
    finally { Atomics.compareExchange = original; }
    expect(inherited).toBeDefined();
    expect(bytes).toEqual(new Uint8Array(8));
    output(reader); output(inherited!);
    controller.pumpRelay();
    const values = [output(reader), output(inherited!)].filter(value => typeof value === "string");
    expect(values.join("")).toBe("safe");
  });

  test("registry-only reader kill freezes its lease and wakes writers with EPIPE", async () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
    const controller = new PipeController({ capacity: 8, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("12345678")]);
    const ready = writer.waitWritable();
    registry.revoke(1);
    await ready;
    expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.PIPE);
    expect(output(reader)).toBe(-PipeErrno.BADF);
  });

  test("registry-only writer kill wakes supervisor relay and delivers EOF to inherited readers", async () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
    const controller = new PipeController({ capacity: 8, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write"), second = reader.forProcess(4);
    // Let the relay enter its asynchronous wait first, then revoke from a registry-only client.
    await Promise.resolve();
    const firstReady = reader.waitReadable(), secondReady = second.waitReadable();
    registry.revoke(2);
    await Promise.all([firstReady, secondReady]);
    expect(output(reader)).toBe("");
    expect(output(second)).toBe("");
    expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.BADF);
  });

  test("disposing one pipe does not revoke unrelated endpoints of the same live process", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 32 });
    const first = new PipeController({ capacity: 8, registry }), second = new PipeController({ capacity: 8, registry });
    controllers.push(first, second);
    first.retain(1, "read"); first.retain(2, "write");
    const reader = second.retain(1, "read"), writer = second.retain(2, "write");
    first.dispose();
    expect(registry.isRevoked(2)).toBe(false);
    expect(writer.tryWrite([encode.encode("alive")])).toBe(5);
    expect(output(reader)).toBe("alive");
  });

  test("32-bit counters wrap while canonical allocation and close bits survive", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
    const controller = new PipeController({ capacity: 8, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    const handle = writer.handle(), at = ringOffset(handle);
    const readIndex = Atomics.load(new Int32Array(handle.buffer, at + 28, 1), 0) - 1;
    const consumed = registry.canonical(readIndex), published = publication(writer);
    Atomics.or(published, 0, 0xfffffffcn);
    Atomics.or(consumed, 0, 0xfffffffcn);
    expect(writer.tryWrite([encode.encode("abcdefgh")])).toBe(8);
    expect(output(reader)).toBe("abcdefgh");
    expect(Atomics.load(published, 0)).toBe((1n << 34n) | (1n << 33n) | 4n);
    expect(Atomics.load(consumed, 0)).toBe((1n << 34n) | (1n << 33n) | 4n);
    registry.revoke(2);
    expect(output(reader)).toBe("");
  });

  test("cloned handles preserve stable pipe identity and supervisor relay ownership", () => {
    const { controller, reader } = pipe();
    const cloned = attachPipeEndpoint(structuredClone(reader.handle()));
    expect(cloned.handle().id).toBe(reader.handle().id);
    expect(cloned.forProcess(1)).toBe(cloned);
    const duplicate = controller.duplicate(cloned);
    reader.close();
    expect(duplicate.tryRead([])).toBe(0);
    expect(() => attachPipeController(cloned.handle())).toThrow("relay supervisor");
  });
});

function pipeWorker(source: string): Worker {
  const module = new URL("../proc/pipes.ts", import.meta.url).href;
  return new Worker(new URL(`data:application/typescript,${encodeURIComponent(`import {attachPipeEndpoint} from ${JSON.stringify(module)};\n${source}`)}`));
}
function message<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.addEventListener("message", event => resolve(event.data), { once: true });
    worker.addEventListener("error", event => reject(event.error ?? new Error(event.message)), { once: true });
  });
}

describe("worker-backed synchronous pipe waits", () => {
  test("fd_read blocks in the worker and wakes on direct shared-memory publication", async () => {
    const { reader, writer } = pipe();
    const worker = pipeWorker(`self.onmessage = ({data}) => {
      const endpoint = attachPipeEndpoint(data);
      self.postMessage("waiting");
      const bytes = new Uint8Array(8);
      const count = endpoint.read([bytes]);
      self.postMessage({count, text: new TextDecoder().decode(bytes.subarray(0,count))});
    };`);
    try {
      const waiting = message(worker);
      worker.postMessage(reader.handle());
      expect(await waiting).toBe("waiting");
      const result = message(worker);
      writer.tryWrite([encode.encode("awake")]);
      expect(await result).toEqual({ count: 5, text: "awake" });
    } finally { await worker.terminate(); }
  });

  test("a spinning producer cannot publish one byte past the frozen kill watermark", async () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
    const controller = new PipeController({ capacity: 1024, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    const worker = pipeWorker(`self.onmessage = ({data}) => {
      const endpoint = attachPipeEndpoint(data);
      const bytes = new Uint8Array(16).fill(42);
      let committed = 0;
      self.postMessage("started");
      for (;;) {
        const count = endpoint.tryWrite([bytes]);
        if (count === -8) break;
        if (count > 0) committed += count;
      }
      self.postMessage(committed);
    };`);
    try {
      const started = message(worker);
      worker.postMessage(writer.handle());
      expect(await started).toBe("started");
      const chunk = new Uint8Array(128);
      let drained = 0;
      // Keep the producer making real progress before revoking while it is still running.
      for (let turn = 0; turn < 32; turn++) {
        await reader.waitReadable();
        const count = reader.tryRead([chunk]);
        if (count > 0) { drained += count; expect(chunk.subarray(0, count).every(byte => byte === 42)).toBe(true); }
      }
      const completed = message<number>(worker);
      registry.revoke(2);
      const watermark = Number(Atomics.load(publication(writer), 0) & 0xffffffffn);
      for (;;) {
        const count = reader.tryRead([chunk]);
        if (!count) break;
        expect(count).toBeGreaterThan(0);
        drained += count;
        expect(chunk.subarray(0, count).every(byte => byte === 42)).toBe(true);
      }
      expect(await completed).toBe(watermark);
      expect(drained).toBe(watermark);
      expect(Atomics.load(publication(writer), 0) & 0xffffffffn).toBe(BigInt(watermark));
      expect(output(reader)).toBe("");
    } finally { await worker.terminate(); }
  });
});

test("relay redirects a chunk when its selected reader is killed at the source claim CAS", () => {
  const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
  const controller = new PipeController({ capacity: 8, registry });
  controllers.push(controller);
  const reader = controller.retain(1, "read"), writer = controller.retain(2, "write"), inherited = reader.forProcess(4);
  writer.tryWrite([encode.encode("safe")]);
  expect(output(reader)).toBe(-PipeErrno.AGAIN);
  const original = Atomics.compareExchange;
  let killed = false;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    if (!killed && array instanceof BigInt64Array && (expected & (1n << 32n)) !== 0n && (replacement & 0xffffffffn) === 4n) {
      killed = true;
      registry.revoke(1);
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try { controller.pumpRelay(); }
  finally { Atomics.compareExchange = original; }
  expect(killed).toBe(true);
  expect(output(reader)).toBe(-PipeErrno.BADF);
  expect(output(inherited)).toBe(-PipeErrno.AGAIN);
  controller.pumpRelay();
  expect(output(inherited)).toBe("safe");
});

test("a registry-only kill wakes fd_read blocked in another worker with EOF", async () => {
  const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
  const controller = new PipeController({ capacity: 8, registry });
  controllers.push(controller);
  const reader = controller.retain(1, "read");
  controller.retain(2, "write");
  const worker = pipeWorker(`self.onmessage = ({data}) => {
    const endpoint = attachPipeEndpoint(data);
    self.postMessage("waiting");
    self.postMessage(endpoint.read([new Uint8Array(8)]));
  };`);
  try {
    const waiting = message(worker);
    worker.postMessage(reader.handle());
    expect(await waiting).toBe("waiting");
    const result = message(worker);
    registry.revoke(2);
    expect(await result).toBe(0);
  } finally { await worker.terminate(); }
});

test("concurrent first reader and writer reservation cannot omit the canonical reader lease", () => {
  const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 16 });
  const controller = new PipeController({ capacity: 8, registry });
  controllers.push(controller);
  const original = Atomics.store;
  let reader: ReturnType<PipeController["retain"]> | undefined;
  Atomics.store = ((array: Int32Array, index: number, value: number) => {
    if (!reader && array instanceof Int32Array && value === 2 && Atomics.load(array, index) === -2) reader = controller.retain(1, "read");
    return original(array, index, value);
  }) as typeof Atomics.store;
  let writer: ReturnType<PipeController["retain"]>;
  try { writer = controller.retain(2, "write"); }
  finally { Atomics.store = original; }
  expect(reader).toBeDefined();
  const handle = writer!.handle(), at = ringOffset(handle);
  const readIndex = Atomics.load(new Int32Array(handle.buffer, at + 28, 1), 0) - 1;
  expect(readIndex).toBeGreaterThanOrEqual(0);
  registry.revoke(1);
  expect(Atomics.load(registry.canonical(readIndex), 0) & (1n << 32n)).toBe(1n << 32n);
  expect(writer!.tryWrite([encode.encode("x")])).toBe(-PipeErrno.PIPE);
});

test("failed canonical lease allocation does not leave an unpublished writer holding EOF open", () => {
  const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 2 });
  const controller = new PipeController({ capacity: 8, registry });
  controllers.push(controller);
  const reader = controller.retain(1, "read"), allocate = PipePublicationRegistry.prototype.allocate;
  PipePublicationRegistry.prototype.allocate = function(pid: number) {
    if (pid === 1) throw new Error("injected cursor allocation failure");
    return allocate.call(this, pid);
  };
  try { expect(() => controller.retain(2, "write")).toThrow("allocation failure"); }
  finally { PipePublicationRegistry.prototype.allocate = allocate; }
  expect(output(reader)).toBe("");
});

describe("relay shared-queue regressions", () => {
  test("an idle reader and readiness observers do not reserve another reader's bytes", () => {
    const controller = new PipeController({ capacity: 8, relay: "manual" });
    controllers.push(controller);
    const idle = controller.retain(1, "read"), active = idle.forProcess(4), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("abc")]);
    expect(idle.readiness().readable).toBe(true);
    controller.pumpRelay();
    expect(output(active)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(output(active)).toBe("abc");
    expect(idle.readiness().nbytes).toBe(0);
    idle.close(); writer.close(); controller.pumpRelay();
    expect(output(active)).toBe("");
  });

  for (const death of ["close", "registry"] as const) {
    test(`unconsumed delivery survives reader ${death} and precedes later source bytes`, () => {
      const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 32 });
      const controller = new PipeController({ capacity: 8, registry, relay: "manual" });
      controllers.push(controller);
      const first = controller.retain(1, "read"), active = first.forProcess(4), writer = controller.retain(2, "write");
      writer.tryWrite([encode.encode("abc")]);
      expect(output(first, 3)).toBe(-PipeErrno.AGAIN);
      controller.pumpRelay();
      if (death === "close") first.close(); else registry.revoke(1);
      writer.tryWrite([encode.encode("def")]);
      writer.close();
      expect(output(active)).toBe(-PipeErrno.AGAIN);
      controller.pumpRelay();
      let received = String(output(active));
      if (received.length < 6) {
        expect(output(active)).toBe(-PipeErrno.AGAIN);
        controller.pumpRelay();
        received += output(active);
      }
      expect(received).toBe("abcdef");
      controller.pumpRelay();
      expect(output(active)).toBe("");
    });
  }

  test("a one-byte read cannot reserve the rest of the pipe", () => {
    const controller = new PipeController({ capacity: 8, relay: "manual" });
    controllers.push(controller);
    const first = controller.retain(1, "read"), active = first.forProcess(4), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("abcdef")]);
    expect(output(first, 1)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(output(first, 1)).toBe("a");
    expect(output(active)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(output(active)).toBe("bcdef");
  });

  test("a pending inherited writer prevents irreversible relay EOF", () => {
    const controller = new PipeController({ capacity: 8, relay: "manual" });
    controllers.push(controller);
    const first = controller.retain(1, "read"), active = first.forProcess(4), writer = controller.retain(2, "write");
    const original = Atomics.store;
    let interleaved = false;
    Atomics.store = ((array: Int32Array, index: number, value: number) => {
      if (!interleaved && array instanceof Int32Array && value === 3 && Atomics.load(array, index) === -3) {
        interleaved = true;
        writer.close();
        controller.pumpRelay();
      }
      return original(array, index, value);
    }) as typeof Atomics.store;
    let inherited: typeof writer;
    try { inherited = writer.forProcess(3); }
    finally { Atomics.store = original; }
    expect(interleaved).toBe(true);
    expect(inherited!.tryWrite([encode.encode("later")])).toBe(5);
    expect(output(active)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(output(active)).toBe("later");
  });
});

describe("causal write ordering and small-write atomicity", () => {
  test("a later lower-pid writer cannot overtake a completed write", () => {
    const controller = new PipeController({ capacity: 16 });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), later = controller.retain(2, "write"), first = later.forProcess(3);
    first.tryWrite([encode.encode("first")]);
    later.tryWrite([encode.encode("second")]);
    expect(output(reader)).toBe("first");
    expect(output(reader)).toBe("second");
  });

  test("one-byte writes retain actual call order across inherited stdout/stderr endpoints", () => {
    const { reader, writer } = pipe();
    const child = writer.forProcess(3);
    child.tryWrite([encode.encode("a")]);
    writer.tryWrite([encode.encode("b")]);
    child.tryWrite([encode.encode("c")]);
    writer.tryWrite([encode.encode("d")]);
    expect([output(reader), output(reader), output(reader), output(reader)].join("")).toBe("abcd");
  });

  test("short reader buffers cannot interleave atomic write records", () => {
    const { reader, writer } = pipe();
    const second = writer.forProcess(3);
    writer.tryWrite([encode.encode("AAAA")]);
    second.tryWrite([encode.encode("BBBB")]);
    expect([output(reader, 2), output(reader, 2), output(reader, 2), output(reader, 2)]).toEqual(["AA", "AA", "BB", "BB"]);
  });

  test("small writes are all-or-EAGAIN when configured ring space is insufficient", () => {
    const { reader, writer } = pipe();
    writer.tryWrite([encode.encode("123456")]);
    expect(writer.tryWrite([encode.encode("abc")])).toBe(-PipeErrno.AGAIN);
    expect(output(reader)).toBe("123456");
    expect(writer.tryWrite([encode.encode("abc")])).toBe(3);
    expect(output(reader)).toBe("abc");
  });

  test("an abandoned EAGAIN request cannot hide bytes from another live reader", () => {
    const controller = new PipeController({ capacity: 8, relay: "manual" });
    controllers.push(controller);
    const abandoned = controller.retain(1, "read"), active = abandoned.forProcess(4), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("abc")]);
    expect(output(abandoned)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(active.readiness()).toMatchObject({ readable: true, nbytes: 3 });
    expect(output(active)).toBe(-PipeErrno.AGAIN);
    controller.pumpRelay();
    expect(output(active)).toBe("abc");
    expect(abandoned.readiness().nbytes).toBe(0);
  });
});

function ringOffset(handle: ReturnType<ReturnType<PipeController["retain"]>["handle"]>): number {
  return 40 + (handle.slot + (handle.mode === "read" ? handle.maxWriters : 0)) * (40 + handle.capacity + Math.min(handle.capacity, 1024) * 16);
}
async function asynchronousOutput(endpoint: ReturnType<PipeController["retain"]>): Promise<string> {
  for (;;) {
    const value = output(endpoint);
    if (typeof value === "string") return value;
    if (value !== -PipeErrno.AGAIN) throw new Error(`unexpected pipe error ${value}`);
    await endpoint.waitReadable();
  }
}

describe("ordered record adversarial boundaries", () => {
  test("a write issued during a source scan cannot overtake the earlier slot already scanned empty", () => {
    const { reader, writer } = pipe();
    const later = writer.forProcess(3), commit = publication(writer);
    const original = Atomics.load;
    let inserted = false;
    Atomics.load = ((array: BigInt64Array, index: number) => {
      const value = original(array, index);
      if (!inserted && array instanceof BigInt64Array && array.buffer === commit.buffer && array.byteOffset === commit.byteOffset) {
        inserted = true;
        writer.tryWrite([encode.encode("first")]);
        later.tryWrite([encode.encode("second")]);
      }
      return value;
    }) as typeof Atomics.load;
    let first: string | number;
    try { first = output(reader); }
    finally { Atomics.load = original; }
    expect(inserted).toBe(true);
    expect(first!).toBe(-PipeErrno.AGAIN);
    expect(output(reader)).toBe("first");
    expect(output(reader)).toBe("second");
  });

  test("another observer can release a record pin abandoned after the final consumption CAS", () => {
    const { reader, writer } = pipe();
    const later = writer.forProcess(3);
    writer.tryWrite([encode.encode("AAAA")]); later.tryWrite([encode.encode("BBBB")]);
    const original = Atomics.compareExchange, handle = writer.handle();
    let abandoned = false;
    Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
      if (!abandoned && array instanceof BigInt64Array && array.buffer === handle.buffer && array.byteOffset === 32 && expected !== 0n && replacement === 0n) {
        abandoned = true;
        throw new Error("reader paused before releasing pin");
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    const bytes = new Uint8Array(4);
    try { expect(() => reader.tryRead([bytes])).toThrow("paused"); }
    finally { Atomics.compareExchange = original; }
    expect(abandoned).toBe(true);
    expect(decode.decode(bytes)).toBe("AAAA");
    expect(output(reader)).toBe("BBBB");
  });

  test("global write tickets preserve order across signed 64-bit wrap", () => {
    const { reader, writer } = pipe();
    const first = writer.forProcess(3);
    Atomics.store(new BigInt64Array(writer.handle().buffer, 24, 1), 0, (1n << 63n) - 2n);
    first.tryWrite([encode.encode("a")]); writer.tryWrite([encode.encode("b")]); first.tryWrite([encode.encode("c")]);
    expect([output(reader), output(reader), output(reader)].join("")).toBe("abc");
  });

  test("record counters wrap without dropping their final metadata slot", () => {
    const { reader, writer } = pipe();
    const handle = writer.handle(), at = ringOffset(handle), before = ((1n << 29n) - 1n) << 34n;
    Atomics.store(new BigInt64Array(handle.buffer, at + 8, 1), 0, before);
    Atomics.store(new BigInt64Array(handle.buffer, at + 16, 1), 0, before);
    expect(writer.tryWrite([encode.encode("a")])).toBe(1);
    expect(output(reader)).toBe("a");
    expect(Atomics.load(publication(writer), 0)).toBe(1n);
    expect(writer.tryWrite([encode.encode("b")])).toBe(1);
    expect(output(reader)).toBe("b");
  });

  test("bounded record metadata applies backpressure even while payload capacity remains", () => {
    const { reader, writer } = pipe(2048);
    let committed = 0;
    for (let index = 0; index < 1024; index++) committed += writer.tryWrite([encode.encode("x")]);
    expect(committed).toBe(1024);
    expect(writer.readiness().writable).toBe(false);
    expect(writer.tryWrite([encode.encode("y")])).toBe(-PipeErrno.AGAIN);
    expect(output(reader, 1)).toBe("x");
    expect(writer.readiness().writable).toBe(true);
    expect(writer.tryWrite([encode.encode("y")])).toBe(1);
  });

  test("4096-byte writes are atomic while larger writes may make partial progress", () => {
    const { reader, writer } = pipe(8192);
    expect(writer.tryWrite([new Uint8Array(4097).fill(65)])).toBe(4097);
    expect(writer.tryWrite([new Uint8Array(4096).fill(66)])).toBe(-PipeErrno.AGAIN);
    expect(writer.tryWrite([new Uint8Array(4097).fill(67)])).toBe(4095);
    expect(output(reader, 8192)).toBe("A".repeat(4097));
    expect(output(reader, 8192)).toBe("C".repeat(4095));
    expect(writer.tryWrite([new Uint8Array(4096).fill(66)])).toBe(4096);
    expect(output(reader, 8192)).toBe("B".repeat(4096));
  });

  test("an uncommitted ticket left by a killed writer never blocks later committed writers", () => {
    const { controller, reader, writer } = pipe();
    const survivor = writer.forProcess(3), source = encode.encode("lost"), subarray = source.subarray.bind(source);
    source.subarray = ((start?: number, end?: number) => {
      const chunk = subarray(start, end);
      controller.revoke(2);
      survivor.tryWrite([encode.encode("good")]);
      return chunk;
    }) as typeof source.subarray;
    expect(writer.tryWrite([source])).toBe(-PipeErrno.BADF);
    expect(output(reader)).toBe("good");
  });
});

describe("relay recovery exactness and scheduling", () => {
  test("only the exact unread suffix of a partially consumed dead delivery is recovered", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 32 });
    const controller = new PipeController({ capacity: 8, registry, relay: "manual" });
    controllers.push(controller);
    const first = controller.retain(1, "read"), active = first.forProcess(4), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("abcdef")]);
    expect(output(first)).toBe(-PipeErrno.AGAIN); controller.pumpRelay();
    expect(output(first, 2)).toBe("ab");
    registry.revoke(1);
    writer.tryWrite([encode.encode("XYZ")]); writer.close();
    expect(output(active)).toBe(-PipeErrno.AGAIN); controller.pumpRelay();
    expect(output(active)).toBe("cdef");
    expect(output(active)).toBe(-PipeErrno.AGAIN); controller.pumpRelay();
    expect(output(active)).toBe("XYZ");
    controller.pumpRelay(); expect(output(active)).toBe("");
  });

  test("guest and dead-delivery reclaimer compete on the same canonical consumed CAS", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 32 });
    const controller = new PipeController({ capacity: 8, registry, relay: "manual" });
    controllers.push(controller);
    const first = controller.retain(1, "read"), active = first.forProcess(4), writer = controller.retain(2, "write");
    writer.tryWrite([encode.encode("abcdef")]);
    expect(output(first)).toBe(-PipeErrno.AGAIN); controller.pumpRelay();
    expect(output(active)).toBe(-PipeErrno.AGAIN);
    const handle = first.handle(), at = ringOffset(handle);
    const mapped = Atomics.load(new Int32Array(handle.buffer, at + 28, 1), 0) - 1, cursor = registry.canonical(mapped);
    const original = Atomics.compareExchange;
    let killed = false;
    Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
      if (!killed && array instanceof BigInt64Array && array.buffer === cursor.buffer && array.byteOffset === cursor.byteOffset) {
        killed = true;
        registry.revoke(1);
        controller.pumpRelay();
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    const bytes = new Uint8Array(2).fill(90);
    try { expect(first.tryRead([bytes])).toBe(-PipeErrno.AGAIN); }
    finally { Atomics.compareExchange = original; }
    expect(killed).toBe(true);
    expect(Array.from(bytes)).toEqual([90, 90]);
    expect(output(active)).toBe("abcdef");
    expect(active.readiness().nbytes).toBe(0);
  });

  test("async read/readiness retry loops yield tasks and still complete relay reads", async () => {
    const { reader, writer } = pipe();
    const inherited = reader.forProcess(4);
    writer.tryWrite([encode.encode("abc")]); writer.close();
    const first = await asynchronousOutput(inherited);
    expect(first).toBe("abc");
    expect(await asynchronousOutput(reader)).toBe("");
  });

  test("continuous real-worker relay traffic cannot starve a timer kill task", async () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 32 });
    const controller = new PipeController({ capacity: 8, registry });
    controllers.push(controller);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
    reader.forProcess(4);
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const worker = pipeWorker(`self.onmessage = ({data}) => {
      const reader = attachPipeEndpoint(data.reader), writer = attachPipeEndpoint(data.writer);
      const stop = new Int32Array(data.stop), bytes = new Uint8Array(1).fill(42), input = new Uint8Array(8);
      let consumed = 0;
      self.postMessage("started");
      const deadline = Date.now() + 700;
      while (!Atomics.load(stop, 0) && Date.now() < deadline) {
        writer.tryWrite([bytes]);
        const count = reader.tryRead([input]);
        if (count > 0) consumed += count;
      }
      self.postMessage(consumed);
    };`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = message(worker), began = performance.now();
      worker.postMessage({ reader: reader.handle(), writer: writer.handle(), stop: stop.buffer });
      expect(await started).toBe("started");
      const completed = message<number>(worker);
      timer = setTimeout(() => { Atomics.store(stop, 0, 1); registry.revoke(1); registry.revoke(2); }, 60);
      expect(await completed).toBeGreaterThan(0);
      expect(performance.now() - began).toBeLessThan(500);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      Atomics.store(stop, 0, 1);
      await worker.terminate();
    }
  });
});

describe("terminal controller lifecycle", () => {
  test("EOF is not terminal while a reader or inherited writer remains", () => {
    const controller = new PipeController({ capacity: 8, relay: "manual" });
    controllers.push(controller);
    expect(controller.closed).toBe(false);
    const reader = controller.retain(1, "read"), writer = controller.retain(2, "write"), child = writer.forProcess(3);
    writer.close(); expect(controller.closed).toBe(false);
    child.close(); expect(output(reader)).toBe(""); expect(controller.closed).toBe(false);
    reader.close(); expect(controller.closed).toBe(true);
    expect(() => controller.retain(4, "read")).toThrow();
  });

  test("automatic terminal observation fires once after fd close or registry-only revoke", async () => {
    for (const registryDeath of [false, true]) {
      const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 32 });
      let calls = 0;
      const controller = new PipeController({ capacity: 8, registry, onClosed: () => { calls++; } });
      controllers.push(controller);
      const reader = controller.retain(1, "read"), writer = controller.retain(2, "write");
      if (registryDeath) { registry.revoke(1); registry.revoke(2); }
      else { reader.close(); writer.close(); }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      expect(controller.closed).toBe(true);
      expect(calls).toBe(1);
      controller.dispose(); controller.dispose();
      expect(calls).toBe(1);
    }
  });
});

test("terminal lifecycle commit loses to a newly admitted writer after its scan passed writer slots", () => {
  const controller = new PipeController({ capacity: 8, relay: "manual" });
  controllers.push(controller);
  const reader = controller.retain(15, "read"), handle = reader.handle();
  const pidOffset = ringOffset(handle), original = Atomics.load;
  let writer: ReturnType<PipeController["retain"]> | undefined;
  Atomics.load = ((array: Int32Array, index: number) => {
    if (!writer && array instanceof Int32Array && array.buffer === handle.buffer && array.byteOffset === pidOffset) {
      // Avoid recursively intercepting the nested retain's own liveness scan.
      Atomics.load = original;
      writer = controller.retain(2, "write");
      reader.close();
    }
    return original(array, index);
  }) as typeof Atomics.load;
  let terminal: boolean;
  try { terminal = controller.closed; }
  finally { Atomics.load = original; }
  expect(writer).toBeDefined();
  expect(terminal!).toBe(false);
  expect(controller.closed).toBe(false);
  expect(writer!.tryWrite([])).toBe(0);
  writer!.close();
  expect(controller.closed).toBe(true);
});

test("standalone reservation cannot overwrite a concurrent revocation tombstone", () => {
  const controller = new PipeController({ capacity: 8, relay: "manual" });
  controllers.push(controller);
  const reader = controller.retain(1, "read"), writer = controller.retain(2, "write"), handle = reader.handle();
  const refsOffset = ringOffset({ ...handle, slot: 4 % handle.maxReaders }) + 4;
  const store = Atomics.store, compareExchange = Atomics.compareExchange;
  let killed = false;
  function kill(array: Int32Array, replacement: number): void {
    if (!killed && array instanceof Int32Array && array.buffer === handle.buffer && array.byteOffset === refsOffset && replacement === 1) {
      killed = true;
      controller.revoke(4);
    }
  }
  Atomics.store = ((array: Int32Array, index: number, value: number) => {
    kill(array, value); return store(array, index, value);
  }) as typeof Atomics.store;
  Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
    kill(array, replacement); return compareExchange(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try { expect(() => reader.forProcess(4)).toThrow("revoked"); }
  finally { Atomics.store = store; Atomics.compareExchange = compareExchange; }
  expect(killed).toBe(true);
  reader.close();
  expect(writer.tryWrite([encode.encode("x")])).toBe(-PipeErrno.PIPE);
});

test("a reservation paused after claiming its negative owner cannot publish after terminal commit", () => {
  const controller = new PipeController({ capacity: 8, relay: "manual" });
  controllers.push(controller);
  const reader = controller.retain(15, "read"), handle = reader.handle(), lifecycle = new Int32Array(handle.buffer, 20, 1);
  const writerPid = ringOffset({ ...handle, mode: "write", slot: 2 % handle.maxWriters });
  const original = Atomics.compareExchange;
  let terminalized = false;
  Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
    const value = original(array, index, expected, replacement);
    if (!terminalized && array instanceof Int32Array && array.buffer === handle.buffer && array.byteOffset === writerPid && replacement === -2 && value === 0) {
      terminalized = true;
      reader.close();
      // Complete a scan whose generation was captured before this reservation existed.
      expect(original(lifecycle, 0, 1, -1)).toBe(1);
    }
    return value;
  }) as typeof Atomics.compareExchange;
  try { expect(() => controller.retain(2, "write")).toThrow("closed"); }
  finally { Atomics.compareExchange = original; }
  expect(terminalized).toBe(true);
  expect(controller.closed).toBe(true);
  expect(Atomics.load(new Int32Array(handle.buffer, writerPid + 4, 1), 0)).toBe(-1);
});

describe("growable canonical registry", () => {
  test("10000 sequential pipes grow a shared registry without reusing old canonical cells", () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 1 });
    const initial = registry.handle().buffer.byteLength, cloned = attachPipePublicationRegistry(structuredClone(registry.handle()));
    const old = registry.allocate(7), oldCursor = registry.canonical(old);
    Atomics.or(oldCursor, 0, 1n << 32n);
    let completed = 0;
    for (let index = 0; index < 10000; index++) {
      const controller = new PipeController({ capacity: 8, maxWriters: 2, maxReaders: 2, registry: index % 2 ? registry : cloned, relay: "manual" });
      try {
        const reader = controller.retain(1, "read"), writer = controller.retain(1, "write");
        if (writer.tryWrite([encode.encode("x")]) !== 1 || output(reader) !== "x") throw new Error(`pipe ${index} failed`);
        reader.close(); writer.close();
        if (!controller.closed) throw new Error(`pipe ${index} leaked`);
        completed++;
      } finally { controller.dispose(); }
    }
    expect(completed).toBe(10000);
    expect(registry.handle().buffer.byteLength).toBeGreaterThan(initial);
    expect(cloned.handle().buffer.byteLength).toBe(registry.handle().buffer.byteLength);
    expect(Atomics.load(cloned.canonical(old), 0) & (1n << 32n)).toBe(1n << 32n);
    const after = cloned.allocate(7);
    expect(after).toBeGreaterThan(old);
    registry.revoke(7);
    expect(Atomics.load(cloned.canonical(after), 0) & (1n << 32n)).toBe(1n << 32n);
  });
});

for (const killAt of ["before-link", "after-link", "after-final-check"] as const) {
  test(`registry allocation cannot escape revocation ${killAt}`, () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 1 });
    const buffer = registry.handle().buffer, headsAt = 16 + 8 * 8, revokedAt = 16 + 8 * 4;
    const compareExchange = Atomics.compareExchange, load = Atomics.load;
    let killed = false, revokedLoads = 0;
    Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => {
      const link = array instanceof Int32Array && array.buffer === buffer && array.byteOffset === headsAt && index === 2;
      if (!killed && link && killAt === "before-link") { killed = true; registry.revoke(2); }
      const result = compareExchange(array, index, expected, replacement);
      if (!killed && link && killAt === "after-link") { killed = true; registry.revoke(2); }
      return result;
    }) as typeof Atomics.compareExchange;
    Atomics.load = ((array: Int32Array, index: number) => {
      const result = load(array, index);
      if (array instanceof Int32Array && array.buffer === buffer && array.byteOffset === revokedAt && index === 2) {
        revokedLoads++;
        if (!killed && killAt === "after-final-check" && revokedLoads === 2) { killed = true; registry.revoke(2); }
      }
      return result;
    }) as typeof Atomics.load;
    try {
      if (killAt === "after-final-check") expect(registry.allocate(2)).toBe(0);
      else expect(() => registry.allocate(2)).toThrow("revoked");
    } finally { Atomics.compareExchange = compareExchange; Atomics.load = load; }
    expect(killed).toBe(true);
    expect(Atomics.load(registry.canonical(0), 0) & (1n << 32n)).toBe(1n << 32n);
    expect(() => registry.allocate(2)).toThrow("revoked");
  });
}

test("a competing larger SAB growth makes a smaller stale grow target harmless", () => {
  const registry = new PipePublicationRegistry({ processCapacity: 2, cellsPerProcess: 1 }), buffer = registry.handle().buffer;
  registry.allocate(1); registry.allocate(1);
  const prototype = SharedArrayBuffer.prototype as SharedArrayBuffer & { grow(length: number): void };
  const grow = prototype.grow;
  let raced = false;
  prototype.grow = function(length: number) {
    if (this === buffer && !raced) { raced = true; grow.call(this, length + 16); }
    return grow.call(this, length);
  };
  try { expect(registry.allocate(1)).toBe(2); }
  finally { prototype.grow = grow; }
  expect(raced).toBe(true);
  registry.revoke(1);
  expect(Atomics.load(registry.canonical(2), 0) & (1n << 32n)).toBe(1n << 32n);
});

test("concurrent same-pid workers grow and contend on one registry list through pre-growth handles", async () => {
  const registry = new PipePublicationRegistry({ processCapacity: 4, cellsPerProcess: 1 });
  const module = new URL("../proc/pipes.ts", import.meta.url).href;
  const source = `import {attachPipePublicationRegistry} from ${JSON.stringify(module)};
    self.onmessage = ({data}) => {
      const registry = attachPipePublicationRegistry(data.registry), indices = [];
      for (let index = 0; index < 256; index++) indices.push(registry.allocate(data.pid));
      self.postMessage(indices);
    };`;
  const first = pipeWorker(source), second = pipeWorker(source);
  try {
    const left = message<number[]>(first), right = message<number[]>(second), handle = structuredClone(registry.handle());
    first.postMessage({ registry: handle, pid: 2 }); second.postMessage({ registry: handle, pid: 2 });
    const [a, b] = await Promise.all([left, right]);
    expect(new Set(a.concat(b)).size).toBe(512);
    const unrelated = registry.allocate(3);
    registry.revoke(2);
    expect(a.concat(b).every(index => (Atomics.load(registry.canonical(index), 0) & (1n << 32n)) !== 0n)).toBe(true);
    expect(Atomics.load(registry.canonical(unrelated), 0) & (1n << 32n)).toBe(0n);
  } finally { await Promise.all([first.terminate(), second.terminate()]); }
});


test("registry lifetime budgets fail with ENFILE rather than an untyped host exception", () => {
  const registry = new PipePublicationRegistry({ processCapacity: 2, cellsPerProcess: 1 });
  registry.allocate(1); registry.allocate(2);
  try { registry.allocate(3); throw new Error("unexpected allocation"); }
  catch (error) { expect(error).toBeInstanceOf(ProcessError); expect((error as ProcessError).errno).toBe(41); }
  Atomics.store(new Int32Array(registry.handle().buffer, 0, 1), 0, 1 << 24);
  try { registry.allocate(1); throw new Error("unexpected allocation"); }
  catch (error) { expect(error).toBeInstanceOf(ProcessError); expect((error as ProcessError).errno).toBe(41); }
});


for (const maxCells of [2, 3]) {
  test(`typed global budget exhaustion at ${maxCells} cells leaves no unpublished writer or open EOF`, () => {
    const registry = new PipePublicationRegistry({ processCapacity: 8, cellsPerProcess: 1, maxCells });
    const controller = new PipeController({ capacity: 8, registry, relay: "manual" });
    controllers.push(controller);
    const reader = controller.retain(1, "read");
    try { controller.retain(2, "write"); throw new Error("unexpected admission"); }
    catch (error) { expect(error).toBeInstanceOf(ProcessError); expect((error as ProcessError).errno).toBe(PipeErrno.NFILE); }
    expect(output(reader)).toBe("");
    expect(controller.closed).toBe(false);
    reader.close(); expect(controller.closed).toBe(true);
    if (maxCells === 3) expect(Atomics.load(registry.canonical(2), 0) & (1n << 32n)).toBe(1n << 32n);
  });
}
