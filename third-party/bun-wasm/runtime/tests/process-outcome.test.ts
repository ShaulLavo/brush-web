import { expect, test } from "bun:test";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome";

for (const code of [0, 23, 143, -1, -2147483648, 2147483647, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
  test(`terminal exit ${code} round-trips without truncation and wins against later kill`, () => {
    const word = outcomeWord();
    expect(readOutcome(word)).toBeNull();
    expect(claimOutcome(word, { kind: "exited", code })).toEqual({ kind: "exited", code, status: code });
    expect(claimOutcome(outcomeWord(word.buffer as SharedArrayBuffer), { kind: "signaled", code: 9 })).toEqual({ kind: "exited", code, status: code });
  });
}

test("the same status retains distinct own-exit and default-signal outcome kinds", () => {
  expect(claimOutcome(outcomeWord(), { kind: "exited", code: 143 })).toEqual({ kind: "exited", code: 143, status: 143 });
  expect(claimOutcome(outcomeWord(), { kind: "signaled", code: 15 })).toEqual({ kind: "signaled", code: 15, status: 143 });
});

test("a competing terminal claim at the CAS boundary wins immutably", () => {
  const word = outcomeWord();
  const original = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
    if (!raced && array === word) {
      raced = true;
      claimOutcome(word, { kind: "signaled", code: 9 });
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try {
    expect(claimOutcome(word, { kind: "exited", code: 126 })).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { Atomics.compareExchange = original; }
  expect(raced).toBe(true);
  expect(claimOutcome(word, { kind: "exited", code: 23 })).toEqual({ kind: "signaled", code: 9, status: 137 });
});

for (const signal of [2, 9, 13, 15]) {
  test(`default signal ${signal} and guest exit share one immutable terminal winner`, () => {
    const killed = outcomeWord();
    expect(claimOutcome(killed, { kind: "signaled", code: signal })).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
    expect(claimOutcome(killed, { kind: "exited", code: 0 })).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
    const exited = outcomeWord();
    claimOutcome(exited, { kind: "exited", code: 23 });
    expect(claimOutcome(exited, { kind: "signaled", code: signal })).toEqual({ kind: "exited", code: 23, status: 23 });
  });
}


for (const signal of [2, 13, 15]) {
  test(`default signal ${signal} wins a guest exit CAS race immutably`, () => {
    const word = outcomeWord();
    const original = Atomics.compareExchange;
    let raced = false;
    Atomics.compareExchange = ((array: BigInt64Array, index: number, expected: bigint, replacement: bigint) => {
      if (!raced && array === word) {
        raced = true;
        claimOutcome(word, { kind: "signaled", code: signal });
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try { expect(claimOutcome(word, { kind: "exited", code: 0 })).toEqual({ kind: "signaled", code: signal, status: 128 + signal }); }
    finally { Atomics.compareExchange = original; }
    expect(raced).toBe(true);
    expect(claimOutcome(word, { kind: "exited", code: 23 })).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
  });
}
