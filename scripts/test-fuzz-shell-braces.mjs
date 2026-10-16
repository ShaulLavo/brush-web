import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bound,
  fixedCases,
  generateCases,
  matches,
  reductions,
  spelling,
  validateFixture,
} from "./fuzz-shell-braces.mjs";

const options = { seed: 1, count: 0, timeoutMs: 2000 };
function fixtureFor(seed = 1) {
  const cases = generateCases(seed, 0);
  return {
    schema: 1,
    sourceHash: createHash("sha256")
      .update(readFileSync(new URL("./fuzz-shell-braces.mjs", import.meta.url)))
      .digest("hex"),
    seed,
    count: 0,
    timeoutMs: 2000,
    bash: "GNU bash, version 5.3.15(1)-release (test)",
    coverage: {
      contexts: Array.from(new Set(cases.map((item) => item.context))).sort(),
      modes: Array.from(new Set(cases.map((item) => item.mode))).sort(),
      tags: Array.from(new Set(cases.flatMap((item) => item.tags))).sort(),
    },
    // Synthetic in-memory validator inputs only; never recorded oracle fixtures.
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
}
const result = (patch = {}) => ({
  status: 0,
  signal: null,
  timedOut: false,
  error: null,
  stdout: Buffer.from("ok\n"),
  ...patch,
});

test("default seeds generate 3000 paired cases plus fixed controls deterministically", () => {
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed, 3000);
    assert.deepEqual(cases, generateCases(seed, 3000));
    assert.equal(cases.length, 3000 + fixedCases().length);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    const generated = cases.slice(fixedCases().length);
    for (let index = 0; index < generated.length; index += 2) {
      const [left, right] = generated.slice(index, index + 2);
      assert.equal(left.mode, "unquoted");
      assert.equal(right.mode, "double");
      assert.deepEqual(left.node, right.node);
      assert.equal(left.context, right.context);
      assert.ok(bound(left.node) <= 128);
      assert.ok(!/\$\((?!\()/.test(left.script));
      assert.ok(!left.script.includes("~"));
      assert.ok(!left.script.includes("`"));
      const inspect = (node) => {
        if (node.children) return node.children.forEach(inspect);
        if (node.tag === "ascii-range") {
          const [, first, last] = /^\{([A-Za-z])\.\.([A-Za-z])/.exec(node.text);
          assert.equal(first === first.toUpperCase(), last === last.toUpperCase());
        }
      };
      inspect(left.node);
    }
  }
});

test("odd count preserves the requested generated count", () => {
  assert.equal(generateCases(1, 3).length, fixedCases().length + 3);
});

test("all fields observers have a leading fixed argument, including empty alternatives", () => {
  for (const item of fixedCases()) assert.ok(item.script.includes("printf '<%s>\\n' 'fields' "));
  const tags = new Set(fixedCases().flatMap((item) => item.tags));
  for (const tag of [
    "zero-field",
    "quoted-empty",
    "ascending",
    "descending",
    "step-zero",
    "signed-zero-padding",
    "arithmetic-control",
    "arithmetic-once-per-word",
    "arithmetic-error",
    "assignment",
    "parameter-operand",
    "opaque-parameter",
    "generated-braces",
    "lookahead",
  ])
    assert.ok(tags.has(tag), tag);
});

test("exact stdout and status decide matches, not stderr", () => {
  assert.ok(
    matches(result({ stderr: Buffer.from("one") }), result({ stderr: Buffer.from("two") })),
  );
  assert.ok(!matches(result(), result({ stdout: Buffer.from("ok") })));
  assert.ok(!matches(result(), result({ status: 2 })));
  assert.ok(matches(result({ status: 2 }), result({ status: 2 })));
});

for (const [label, patch] of [
  ["timeout", { timedOut: true }],
  ["signal", { signal: "SIGKILL", status: null }],
  ["spawn error", { error: "ENOENT", status: null }],
  ["output limit", { error: "ENOBUFS" }],
  ["missing status", { status: null }],
])
  test(`even identical ${label} failures are never MATCH`, () => {
    assert.ok(!matches(result(patch), result(patch)));
  });

test("structural reductions preserve brace trees and lower spelling length", () => {
  const node = {
    kind: "concat",
    children: [
      {
        kind: "list",
        children: [
          { kind: "atom", text: "long" },
          { kind: "atom", text: "tail" },
        ],
      },
      { kind: "atom", text: "suffix" },
    ],
  };
  const smaller = reductions(node).filter(
    (candidate) => spelling(candidate).length < spelling(node).length,
  );
  assert.ok(smaller.length > 3);
  assert.ok(smaller.some((candidate) => candidate.kind === "list"));
  assert.ok(smaller.some((candidate) => candidate.kind === "concat"));
});

test("strict fixture validator accepts complete synthetic in-memory observations", () => {
  assert.equal(
    validateFixture("shell-braces-seed-1.json", fixtureFor(), options).length,
    fixedCases().length,
  );
  assert.equal(
    validateFixture("shell-braces-seed-42.json", fixtureFor(42), options).length,
    fixedCases().length,
  );
});

const mutations = [
  [
    "schema",
    (fixture) => {
      fixture.schema = 2;
    },
  ],
  [
    "source hash",
    (fixture) => {
      fixture.sourceHash = "0".repeat(64);
    },
  ],
  [
    "Bash version",
    (fixture) => {
      fixture.bash = "GNU bash, version 5.3.150(1)-release";
    },
  ],
  [
    "count",
    (fixture) => {
      fixture.count = 1;
    },
  ],
  [
    "timeout",
    (fixture) => {
      fixture.timeoutMs = 1;
    },
  ],
  [
    "seed",
    (fixture) => {
      fixture.seed = -1;
    },
  ],
  [
    "filename seed",
    (fixture) => {
      fixture.seed = 42;
    },
  ],
  [
    "coverage",
    (fixture) => {
      fixture.coverage.tags.pop();
    },
  ],
  [
    "missing case",
    (fixture) => {
      fixture.cases.pop();
    },
  ],
  [
    "case identity",
    (fixture) => {
      fixture.cases[0].case.id = "wrong";
    },
  ],
  [
    "script",
    (fixture) => {
      fixture.cases[0].case.script += "; true";
    },
  ],
  [
    "case order",
    (fixture) => {
      fixture.cases.reverse();
    },
  ],
  [
    "missing status",
    (fixture) => {
      delete fixture.cases[0].bash.status;
    },
  ],
  [
    "invalid status",
    (fixture) => {
      fixture.cases[0].bash.status = 256;
    },
  ],
  [
    "string status",
    (fixture) => {
      fixture.cases[0].bash.status = "0";
    },
  ],
  [
    "signal",
    (fixture) => {
      fixture.cases[0].bash.signal = "SIGKILL";
    },
  ],
  [
    "timeout result",
    (fixture) => {
      fixture.cases[0].bash.timedOut = true;
    },
  ],
  [
    "spawn error",
    (fixture) => {
      fixture.cases[0].bash.error = "ENOENT";
    },
  ],
  [
    "absent bytes",
    (fixture) => {
      delete fixture.cases[0].bash.stdoutBase64;
    },
  ],
  [
    "invalid stdout",
    (fixture) => {
      fixture.cases[0].bash.stdoutBase64 = "%%%";
    },
  ],
  [
    "noncanonical stderr",
    (fixture) => {
      fixture.cases[0].bash.stderrBase64 = "eA";
    },
  ],
];
for (const [label, mutate] of mutations)
  test(`reject changed fixture ${label} before replay`, () => {
    const fixture = fixtureFor();
    mutate(fixture);
    assert.throws(() => validateFixture("shell-braces-seed-1.json", fixture, options));
  });

test("an explicitly requested seed must match the fixture", () => {
  assert.throws(() =>
    validateFixture("shell-braces-seed-42.json", fixtureFor(42), {
      ...options,
      explicitSeed: true,
    }),
  );
});
