import { expect, test } from "bun:test";
import { interruptFixtureMemory, interruptLoopFixture, interruptShapes, InterruptWord } from "./fixtures/interrupt-browser-loops";
import { interruptWorkloadFixture } from "./fixtures/interrupt-browser-workload";

// Tests-first safety gate: an uninstrumented failed test can always be rescued on Safari.
test("all five original cancellation fixtures validate and return through independent rescue", () => {
  const bytes = interruptLoopFixture();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([{ module: "env", name: "memory", kind: "memory" }]);
  const memory = interruptFixtureMemory(), words = new Int32Array(memory.buffer);
  Atomics.store(words, InterruptWord.rescue, 1);
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  for (const shape of interruptShapes) {
    (instance.exports[shape] as () => void)();
    expect(Atomics.load(words, InterruptWord.heartbeat)).toBe(0);
    expect(Atomics.load(words, InterruptWord.interrupt)).toBe(0);
    expect(Atomics.load(words, InterruptWord.trapped)).toBe(0);
  }
});

test("the frozen original CPU workloads validate and produce repeatable checksums", () => {
  const bytes = interruptWorkloadFixture();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const tight = instance.exports.tight as (n: number) => number;
  const sort = instance.exports.sort as (n: number) => number;
  expect(tight(100_000)).toBe(-718026261);
  expect(tight(100_000)).toBe(-718026261);
  expect(sort(4096)).toBe(-1203665494);
  expect(sort(4096)).toBe(-1203665494);
});
