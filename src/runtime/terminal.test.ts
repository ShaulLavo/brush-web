import { test } from "node:test";
import assert from "node:assert/strict";
import { DescriptorTable } from "@bun-wasm/runtime/core";
import { SharedBridge, control, INPUT_CAPACITY, OUTPUT_CAPACITY } from "../bridge";
import { createBridgeTerminal, createRuntimeTerminalCodec } from "./runtime-terminals";

const unsupported = () => {
  throw new Error("unexpected nonterminal descriptor");
};
const codec = () =>
  createRuntimeTerminalCodec({
    fallback: { export: unsupported, import: unsupported, discard: unsupported },
  });

test("terminal immediate operations return EAGAIN without entering a blocking path", () => {
  const bridge = new SharedBridge();
  const input = createBridgeTerminal(bridge.buffer, 0);
  const output = createBridgeTerminal(bridge.buffer, 1);
  assert.equal(input.tryRead!([new Uint8Array(1)]), -6);
  assert.equal(input.tryRead!([new Uint8Array()]), 0);
  assert.equal(output.tryWrite!([new Uint8Array(OUTPUT_CAPACITY + 1).fill(97)]), OUTPUT_CAPACITY);
  assert.equal(output.tryWrite!([new Uint8Array([98])]), -6);
  assert.equal(output.readiness().writable, false);
  Atomics.store(bridge.state, control.inputLock, 1);
  assert.equal(input.tryRead!([new Uint8Array(1)]), -6);
  Atomics.store(bridge.state, control.inputLock, 0);
  bridge.drain(OUTPUT_CAPACITY);
  Atomics.store(bridge.state, control.outputLock, 1);
  assert.equal(output.tryWrite!([new Uint8Array([98])]), -6);
  Atomics.store(bridge.state, control.outputLock, 0);
  assert.equal(output.tryWrite!([new Uint8Array([98])]), 1);
  assert.deepEqual(bridge.drain(), new Uint8Array([98]));
});

test("terminal ring wraps without losing binary bytes or exceeding its fixed capacity", () => {
  const bridge = new SharedBridge();
  const input = createBridgeTerminal(bridge.buffer, 0);
  const first = new Uint8Array(INPUT_CAPACITY - 2).fill(11);
  assert.equal(bridge.send(first), true);
  assert.equal(input.tryRead!([new Uint8Array(first.length)]), first.length);
  const binary = new Uint8Array([0, 255, 13, 10, 27]);
  assert.equal(bridge.send(binary), true);
  const a = new Uint8Array(2),
    b = new Uint8Array(10);
  assert.equal(input.tryRead!([a, b]), binary.length);
  assert.deepEqual(a, binary.subarray(0, 2));
  assert.deepEqual(b.subarray(0, 3), binary.subarray(2));
  assert.equal(bridge.availableInput(), 0);
  assert.equal(bridge.buffer.byteLength, 64 + INPUT_CAPACITY + OUTPUT_CAPACITY);
});

test("arbitrary fd remapping preserves transferable terminal endpoint provenance", () => {
  const bridge = new SharedBridge();
  const table = new DescriptorTable();
  const fd = table.open(createBridgeTerminal(bridge.buffer, 2), 1n << 6n, 0n);
  const token = codec().export(table.get(fd)!, 2);
  const imported = codec().import(token, 2);
  const remapped = new DescriptorTable();
  remapped.inherit(77, {
    description: imported,
    resource: imported.resource,
    rightsBase: 1n << 6n,
    rightsInheriting: 0n,
  });
  const nextToken = codec().export(remapped.get(77)!, 3);
  const grandchild = codec().import(nextToken, 3);
  assert.equal(grandchild.resource.kind, "terminal");
  if (grandchild.resource.kind !== "terminal") throw new Error("expected terminal");
  assert.equal(grandchild.resource.tryWrite!([new Uint8Array([0, 255, 10])]), 3);
  assert.deepEqual(bridge.drain(), new Uint8Array([0, 255, 10]));
  remapped.dispose();
  table.dispose();
  assert.equal(bridge.closed(), false);
});

test("independently imported stdin readers consume one shared cursor", () => {
  const bridge = new SharedBridge();
  const source = new DescriptorTable();
  source.open(createBridgeTerminal(bridge.buffer, 0), 1n << 1n, 0n);
  const token = codec().export(source.get(0)!, 2);
  const first = codec().import(token, 2).resource;
  const second = codec().import(token, 3).resource;
  if (first.kind !== "terminal" || second.kind !== "terminal")
    throw new Error("expected terminals");
  bridge.send(new Uint8Array([1, 2, 3, 4]));
  const a = new Uint8Array(2),
    b = new Uint8Array(2);
  assert.equal(first.tryRead!([a]), 2);
  assert.equal(second.tryRead!([b]), 2);
  assert.deepEqual(a, new Uint8Array([1, 2]));
  assert.deepEqual(b, new Uint8Array([3, 4]));
  bridge.close();
  assert.equal(first.tryRead!([a]), 0);
  assert.equal(second.readiness().hangup, true);
  source.dispose();
});
