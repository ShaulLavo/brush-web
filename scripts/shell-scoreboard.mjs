// Fixed GNU bash observations and exact, comparable per-case score changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const bytesDigest = (value) => createHash("sha256").update(value).digest("hex");

export function identityFor(oracle) {
  return {
    schema: oracle.schema,
    caseSet: digest(oracle.cases.map(({ bash, ...item }) => item)),
    oracle: digest({
      executable: oracle.oracle,
      observations: oracle.cases.map((item) => [item.id, item.bash]),
    }),
    environment: digest(oracle.environment),
    sources: digest(oracle.sources),
  };
}
export function sealOracle(oracle) {
  return { ...oracle, identity: identityFor(oracle) };
}
export function verifyOracle(oracle) {
  assert.equal(oracle.schema, 1, "unsupported oracle schema");
  assert.deepEqual(oracle.identity, identityFor(oracle), "oracle identity mismatch");
  const ids = new Set();
  for (const item of oracle.cases) {
    assert.ok(!ids.has(item.id), `duplicate oracle case ${item.id}`);
    ids.add(item.id);
    if (item.excluded || item.kind !== "builtins-only") continue;
    assert.ok(
      Number.isInteger(item.bash?.status) && item.bash.status >= 0 && item.bash.status <= 255,
      `invalid oracle status: ${item.id}`,
    );
    for (const stream of ["stdout", "stderr"])
      assert.equal(
        Buffer.from(item.bash[stream], "base64").toString("base64"),
        item.bash[stream],
        `invalid oracle bytes: ${item.id}`,
      );
  }
}
export function summarize(score) {
  const result = {};
  for (const item of score.cases) {
    const corpus = (result[item.corpus] ??= { total: 0, passed: 0, skipped: 0, categories: {} });
    const category = (corpus.categories[item.category] ??= { total: 0, passed: 0, skipped: 0 });
    for (const count of [corpus, category]) {
      count.total++;
      count.passed += Number(item.outcome === "pass");
      count.skipped += Number(item.outcome === "skip");
    }
  }
  return result;
}
function indexCases(score) {
  const cases = new Map(score.cases.map((item) => [item.id, item]));
  assert.equal(cases.size, score.cases.length, "duplicate result case");
  return cases;
}
export function compareScores(base, next, { requireMembership = false } = {}) {
  assert.deepEqual(
    next.identity,
    base.identity,
    "incomparable case-set/oracle/environment/source identity",
  );
  const previous = indexCases(base);
  const current = indexCases(next);
  assert.equal(current.size, previous.size, "result case count changed");
  const corpora = {};
  for (const [id, before] of previous) {
    const after = current.get(id);
    assert.ok(after, `missing result case: ${id}`);
    assert.equal(after.corpus, before.corpus, `case corpus changed: ${id}`);
    assert.equal(after.category, before.category, `case category changed: ${id}`);
    assert.equal(after.kind, before.kind, `case kind changed: ${id}`);
    assert.equal(after.excluded, before.excluded, `case exclusion changed: ${id}`);
    assert.equal(after.outcome === "skip", before.outcome === "skip", `case skip changed: ${id}`);
    const delta = (corpora[before.corpus] ??= {
      before: 0,
      after: 0,
      gained: [],
      lost: [],
      newlyFailing: [],
    });
    delta.before += Number(before.outcome === "pass");
    delta.after += Number(after.outcome === "pass");
    if (before.outcome === "pass" && after.outcome !== "pass") delta.lost.push(id);
    if (before.outcome !== "pass" && after.outcome === "pass") delta.gained.push(id);
    if (before.outcome === "pass" && after.outcome !== "pass")
      delta.newlyFailing.push({ id, outcome: after.outcome });
  }
  if (requireMembership) {
    const changed = Object.values(corpora).flatMap((row) => row.gained.concat(row.lost));
    assert.equal(
      changed.length,
      0,
      `stale candidate baseline: update pass membership for ${changed.join(", ")}`,
    );
  }
  return { ok: Object.values(corpora).every((row) => row.after >= row.before), corpora };
}

export function validateScore(oracle, score) {
  if (score.counts)
    assert.deepEqual(score.counts, summarize(score), "stored counts differ from case outcomes");
  const expected = {
    identity: oracle.identity,
    cases: oracle.cases.map((item) => ({
      id: item.id,
      corpus: item.corpus,
      category: item.category,
      kind: item.kind,
      excluded: item.excluded,
      outcome: item.excluded || item.kind !== "builtins-only" ? "skip" : "fail",
    })),
  };
  compareScores(expected, score);
}

export function compactResult(result, limit = 240) {
  const stream = (bytes) =>
    bytes.length <= limit
      ? bytes.toString("base64")
      : {
          base64: bytes.subarray(0, limit).toString("base64"),
          bytes: bytes.length,
          sha256: bytesDigest(bytes),
          prefixBytes: limit,
        };
  return {
    status: result.status,
    stdout: stream(result.stdout),
    stderr: stream(result.stderr),
    ...(result.timeout ? { timeout: true } : {}),
    ...(result.outputLimit ? { outputLimit: true } : {}),
    ...(result.crash ? { crash: result.crash.slice(0, 240) } : {}),
  };
}
