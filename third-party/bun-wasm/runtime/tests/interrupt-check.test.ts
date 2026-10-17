import { expect, test } from "bun:test";
import { fatalInterrupt } from "../interrupt/check";
import { claimOutcome, outcomeWord } from "../proc/outcome";
import { createSignalState, requestSignal, setSignalDisposition, takeSignal } from "../proc/signals";

function transport() {
  return { outcome: outcomeWord(), signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)), requestedSignal: new Int32Array(new SharedArrayBuffer(4)) };
}

test("injected checkpoints observe recorded default actions without inferring a trap status", () => {
  for (const signal of [2, 9, 13, 15]) {
    const state = transport();
    expect(fatalInterrupt(state.outcome)).toBe(0);
    requestSignal(state, signal);
    expect(fatalInterrupt(state.outcome)).toBe(signal);
    expect(fatalInterrupt(state.outcome)).toBe(signal);
  }
});

test("a handled signal remains queued for a cooperative guest's existing handler checkpoint", () => {
  const state = transport();
  setSignalDisposition(state.signalState, 2, 2);
  requestSignal(state, 2);
  expect(Atomics.load(state.interrupt, 0)).toBe(2);
  expect(fatalInterrupt(state.outcome)).toBe(0);
  expect(takeSignal(state.signalState)).toBe(2);
  expect(takeSignal(state.signalState)).toBe(0);
});

test("ordinary completion and missing shared state are never relabeled as a signal", () => {
  const state = transport();
  claimOutcome(state.outcome, { kind: "exited", code: 143 });
  requestSignal(state, 15);
  expect(fatalInterrupt(state.outcome)).toBe(0);
  expect(fatalInterrupt(null)).toBe(0);
});
