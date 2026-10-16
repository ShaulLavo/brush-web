import assert from "node:assert/strict";
import { test } from "node:test";
import { sealOracle, identityFor, summarize, compareScores, verifyOracle } from "./shell-scoreboard.mjs";

function fixture() {
  return sealOracle({
    schema: 1,
    oracle: { version: "GNU bash 5.3.15", sha256: "oracle-binary" },
    environment: { locale: "C.UTF-8", stdin: "empty" },
    sources: { oils: "pinned", "brush-suite": "pinned", "bashkit-suite": "pinned" },
    cases: ["oils", "brush-suite", "bashkit-suite"].map((corpus) => ({
      id: `${corpus}:example:1`, corpus, category: "example", code: "printf '\\377'",
      kind: "builtins-only", bash: { status: 0, stdout: "/w==", stderr: "" },
    })),
  });
}
function score(oracle, outcomes = ["pass", "pass", "pass"]) {
  return { identity: identityFor(oracle), cases: oracle.cases.map((item, index) => ({
    id: item.id, corpus: item.corpus, category: item.category, outcome: outcomes[index],
  })) };
}

test("exact per-corpus counts reject a single lost pass", () => {
  const oracle = fixture();
  const base = score(oracle);
  const next = score(oracle, ["fail", "pass", "pass"]);
  const delta = compareScores(base, next);
  assert.equal(delta.ok, false);
  assert.deepEqual(delta.corpora.oils.lost, ["oils:example:1"]);
  assert.equal(summarize(next).oils.passed, 0);
});

test("gains cannot conceal a regression in another corpus", () => {
  const oracle = fixture();
  const delta = compareScores(score(oracle, ["pass", "fail", "pass"]), score(oracle, ["fail", "pass", "pass"]));
  assert.equal(delta.ok, false);
  assert.deepEqual(delta.corpora["brush-suite"].gained, ["brush-suite:example:1"]);
});

test("identity changes and incomplete/duplicate results are rejected", () => {
  for (const key of ["caseSet", "oracle", "environment", "sources"]) {
    const oracle = fixture();
    const next = score(oracle);
    next.identity[key] = "changed";
    assert.throws(() => compareScores(score(oracle), next), /incomparable/);
  }
  const oracle = fixture();
  const next = score(oracle);
  next.cases.pop();
  assert.throws(() => compareScores(score(oracle), next), /case/);
  next.cases.push(next.cases[0]);
  assert.throws(() => compareScores(score(oracle), next), /case/);
});

test("oracle bytes, code, skips and source pins participate in identity", () => {
  for (const change of [
    (o) => { o.cases[0].code = "false"; },
    (o) => { o.cases[0].bash.stdout = "AA=="; },
    (o) => { o.cases[0].excluded = "new skip"; },
    (o) => { o.sources.oils = "changed"; },
  ]) {
    const oracle = fixture();
    change(oracle);
    assert.throws(() => verifyOracle(oracle), /identity/);
  }
});

test("category counts and unchanged skips are explicit", () => {
  const oracle = fixture();
  oracle.cases.push({ id: "oils:skip:2", corpus: "oils", category: "example", code: "", excluded: "fixture required" });
  const sealed = sealOracle(oracle);
  const actual = score(sealed);
  actual.cases[3].outcome = "skip";
  const summary = summarize(actual);
  assert.deepEqual(summary.oils.categories.example, { total: 2, passed: 1, skipped: 1 });
  assert.equal(compareScores(actual, actual).ok, true);
});
