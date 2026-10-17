import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  boundaryBodies,
  boundaryClosings,
  boundaryContexts,
  boundaryOpeners,
  boundarySpellings,
  boundaryCases,
  classify,
  coverage,
  fixedCases,
  generateCases,
  matches,
  reductions,
  spelling,
  validateFixture,
} from "./fuzz-shell-substitution-boundaries.mjs";

const options = { seed: 1, count: 0, timeoutMs: 2000 };
const processResult = (patch = {}) => ({
  status: 0,
  signal: null,
  timedOut: false,
  error: null,
  stdout: Buffer.from("ok\n"),
  stderr: Buffer.alloc(0),
  ...patch,
});

test("seeded generation is deterministic and bounded", () => {
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed, 600);
    assert.deepEqual(cases, generateCases(seed, 600));
    assert.equal(cases.length, fixedCases().length + 600 + boundaryCases(seed).length);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.ok(cases.length < 4000);
    for (const item of cases) assert.ok(item.script.length < 4096, item.id);
  }
});

test("the boundary matrix covers each requested dimension", () => {
  const cases = boundaryCases(1);
  const found = coverage(cases);
  assert.deepEqual(found.contexts, boundaryContexts.toSorted());
  assert.deepEqual(found.openers, boundaryOpeners.toSorted());
  assert.deepEqual(found.spellings, boundarySpellings.toSorted());
  assert.deepEqual(found.closings, boundaryClosings);
  for (const [id] of boundaryBodies) assert.ok(found.bodies.includes("body-" + id), id);
  assert.ok(cases.some((item) => item.tags.includes("body-heredoc-multiple")));
  assert.ok(cases.some((item) => item.tags.includes("body-case-pattern")));
  assert.ok(cases.some((item) => item.tags.includes("body-unterminated-redirect-less")));
});

test("spelling preserves fused and spaced opener families", () => {
  const cases = boundaryCases(42);
  for (const opener of boundaryOpeners) {
    const variants = cases.filter((item) => item.opener === opener);
    assert.ok(
      variants.some((item) => item.spacing === "fused"),
      opener,
    );
    assert.ok(
      variants.some((item) => item.spacing === "spaced"),
      opener,
    );
    for (const item of variants.slice(0, 8)) {
      const raw = spelling(item.node.child);
      assert.ok(raw.length > 0);
      if (item.closings !== null && opener !== "backtick")
        assert.ok(raw.endsWith(")".repeat(item.closings)));
    }
  }
});

test("classification only grants the narrow substitution unsupported exemption", () => {
  assert.equal(
    classify(processResult(), processResult({ status: 2, stdout: Buffer.alloc(0) })),
    "UNSUPPORTED",
  );
  assert.equal(
    classify(processResult(), processResult({ status: 2, stdout: Buffer.from("x") })),
    "MISMATCH",
  );
  assert.equal(classify(processResult({ status: 2 }), processResult({ status: 2 })), "MATCH");
  assert.equal(classify(processResult({ status: 2 }), processResult({ status: 127 })), "MISMATCH");
  assert.equal(
    classify(processResult(), processResult({ status: 2, stdout: Buffer.alloc(0) }), true),
    "MISMATCH",
  );
});

test("matching ignores stderr but rejects process failures", () => {
  assert.ok(matches(processResult({ stderr: Buffer.from("bash warning") }), processResult()));
  assert.ok(!matches(processResult(), processResult({ stdout: Buffer.from("different") })));
  assert.ok(
    !matches(processResult({ status: 2 }), processResult({ status: 2, signal: "SIGKILL" })),
  );
  assert.ok(!matches(processResult({ timedOut: true }), processResult({ timedOut: true })));
});

test("structural reductions preserve boundary identity and shorten spelling", () => {
  const original = boundaryCases(1).find(
    (item) => item.opener === "command" && item.spacing === "spaced" && item.closings === 3,
  );
  assert.ok(original);
  const candidates = reductions(original.node);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.some((node) => spelling(node).length < spelling(original.node).length));
  for (const node of candidates) {
    assert.equal(node.kind, "context");
    assert.equal(node.context, original.context);
    assert.equal(node.child.kind, "boundary");
    assert.equal(node.child.opener, original.opener);
  }
});

test("strict fixture validation accepts regenerated synthetic observations", () => {
  const cases = generateCases(1, 0);
  const fixture = {
    schema: 1,
    sourceHash: createHash("sha256")
      .update(readFileSync(new URL("./fuzz-shell-substitution-boundaries.mjs", import.meta.url)))
      .digest("hex"),
    seed: 1,
    count: 0,
    timeoutMs: 2000,
    bash: "GNU bash, version 5.3.15(1)-release (test)",
    coverage: coverage(cases),
    cases: cases.map((item) => ({
      case: item,
      bash: {
        status: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdoutBase64: "",
        stderrBase64: "",
      },
    })),
  };
  assert.equal(
    validateFixture("shell-substitutions-seed-1.json", fixture, options).length,
    cases.length,
  );
  fixture.cases[0].case.script += " changed";
  assert.throws(
    () => validateFixture("shell-substitutions-seed-1.json", fixture, options),
    /case differs/,
  );
});
