import { expect, test } from "bun:test";
import { InterruptModuleCache } from "../interrupt/loader";

const empty = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

test("equal module bytes share rewriting and compilation across concurrent loads", async () => {
  const cache = new InterruptModuleCache();
  const modules = await Promise.all([cache.compile(empty()), cache.compile(empty())]);
  expect(modules[0]).toBe(modules[1]);
  expect(WebAssembly.Module.imports(modules[0]!)).toEqual([
    { module: "runtime_proc", name: "interrupted", kind: "function" },
  ]);
  expect(await cache.compile(empty())).toBe(modules[0]);
});

test("the content hash observes only the supplied view", async () => {
  const cache = new InterruptModuleCache();
  const padded = new Uint8Array(16);
  padded.set(empty(), 4);
  const fromView = await cache.compile(padded.subarray(4, 12));
  expect(await cache.compile(empty())).toBe(fromView);
});

test("load snapshots borrowed bytes before asynchronous hashing", async () => {
  const cache = new InterruptModuleCache();
  const bytes = empty();
  const pending = cache.compile(bytes);
  bytes.fill(255);
  expect(await pending).toBeInstanceOf(WebAssembly.Module);
  expect(await cache.compile(empty())).toBe(await pending);
});

test("cache evicts old modules at its bounded capacity", async () => {
  const cache = new InterruptModuleCache(1);
  const original = await cache.compile(empty());
  // A harmless custom section makes a distinct original-content hash.
  const other = new Uint8Array(Array.from(empty()).concat([0, 2, 1, 120]));
  const second = await cache.compile(other);
  expect(second).not.toBe(original);
  expect(await cache.compile(empty())).not.toBe(original);
});

test("refused modules reject clearly and do not poison subsequent valid loads", async () => {
  const cache = new InterruptModuleCache();
  await expect(cache.compile(new Uint8Array([0, 1, 2]))).rejects.toThrow();
  expect(await cache.compile(empty())).toBeInstanceOf(WebAssembly.Module);
});

test("cache limits must be positive integers", () => {
  for (const capacity of [0, -1, 1.5, NaN]) expect(() => new InterruptModuleCache(capacity)).toThrow();
});
