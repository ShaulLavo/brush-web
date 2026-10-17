import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bound,
  boundaryBodies,
  boundaryCases,
  boundaryClosings,
  boundaryContexts,
  boundaryOpeners,
  boundaryProtections,
  boundarySpellings,
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

test("default seeds retain 3000 original paired cases and append the complete boundary matrix", (t) => {
  t.diagnostic(
    `fixed=${fixedCases().length} originalGenerated=3000 boundaryGenerated=${boundaryCases(1).length} total=${generateCases(1, 3000).length}`,
  );
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed, 3000);
    assert.deepEqual(cases, generateCases(seed, 3000));
    assert.equal(cases.length, 3000 + fixedCases().length + boundaryCases(seed).length);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.deepEqual(cases.slice(fixedCases().length + 3000), boundaryCases(seed));
    const generated = cases.slice(fixedCases().length, fixedCases().length + 3000);
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
  assert.equal(generateCases(1, 3).length, fixedCases().length + 3 + boundaryCases(1).length);
  assert.equal(generateCases(1, 0).length, fixedCases().length + boundaryCases(1).length);
});

function nodesIn(node) {
  return [node].concat(
    node.child ? nodesIn(node.child) : [],
    node.children ? node.children.flatMap(nodesIn) : [],
  );
}

for (const seed of [1, 42]) {
  test(`seed ${seed} covers every boundary feature/context/depth/mode tuple without exclusions`, () => {
    const cases = boundaryCases(seed);
    assert.deepEqual(cases, boundaryCases(seed));
    assert.equal(cases.length, 4047);
    assert.deepEqual(boundaryClosings, [1, 2, 3]);
    const matrix = cases.filter((item) => item.tags.includes("boundary-guard"));
    assert.equal(matrix.length, 2016);
    const actual = [];
    for (const item of matrix) {
      const nodes = nodesIn(item.node);
      const feature = nodes.find((node) => node.kind === "boundary");
      const context = nodes.find((node) => node.kind === "boundary-context").context;
      const depth = nodes.filter((node) => node.kind === "boundary-nest").length;
      assert.ok(item.tags.includes(`boundary-depth-${depth}`));
      assert.ok(item.tags.includes(`boundary-context-${context}`));
      assert.ok(depth >= 0 && depth <= 3);
      assert.equal(nodes.filter((node) => node.kind === "boundary-guard").length, 1);
      actual.push(
        [
          feature.form,
          feature.opener,
          feature.protection ?? feature.body,
          Boolean(feature.open),
          feature.closings ?? 0,
          context,
          depth,
          item.mode,
        ].join("/"),
      );
      assert.ok(bound(item.node) <= 128);
      assert.ok(item.script.length < 4096);
      assert.equal(item.context, "word");
      assert.ok(!Object.hasOwn(item, "unsupported"));
      assert.ok(!Object.hasOwn(item, "skip"));
      if (feature.form === "ambiguity") {
        assert.ok(spelling(feature).startsWith(feature.opener === "fused" ? "$((" : "$( ("));
        assert.ok(item.tags.includes(`boundary-closings-${feature.closings}`));
        assert.equal(
          /\)(?: \))*$/.exec(spelling(feature))[0],
          Array.from({ length: feature.closings }, () => ")").join(" "),
        );
        if (feature.body.includes("case")) {
          assert.ok(spelling(feature).includes("case x in x)"));
          assert.ok(spelling(feature).includes("esac"));
        }
        if (feature.body.includes("subshell")) assert.ok(spelling(feature).includes("(printf x)"));
        if (feature.body.startsWith("comment-"))
          assert.ok(
            spelling(feature).includes(
              feature.body === "comment-open" ? "# (\nprintf x" : "# )\nprintf x",
            ),
          );
      } else {
        const dollar = { escaped: "\\$", single: "'$'", double: '"$"' }[feature.protection];
        const opener = { brace: "{", command: "(", arithmetic: "((" }[feature.opener];
        assert.ok(spelling(feature).startsWith(dollar + opener));
      }
    }
    const features = boundarySpellings
      .flatMap((opener) =>
        boundaryBodies.flatMap((body) =>
          boundaryClosings.map((closings) => ["ambiguity", opener, body, false, closings]),
        ),
      )
      .concat(
        boundaryProtections.flatMap((protection) =>
          boundaryOpeners.flatMap((opener) =>
            (opener === "brace" ? [false, true] : [false]).map((open) => [
              "protected",
              opener,
              protection,
              open,
              0,
            ]),
          ),
        ),
      );
    const expected = features.flatMap((feature) =>
      boundaryContexts.flatMap((context) =>
        [0, 1, 2, 3].flatMap((depth) =>
          ["unquoted", "double"].map((mode) => feature.concat([context, depth, mode]).join("/")),
        ),
      ),
    );
    assert.equal(new Set(actual).size, expected.length);
    assert.deepEqual(actual.sort(), expected.sort());
    const selected = cases.filter((item) => !item.tags.includes("boundary-guard"));
    assert.equal(selected.length, 2031);
    // Every guarded exercise also runs selected, after all guarded cases.
    const twins = selected.filter((item) => /-selected-(unquoted|double)$/.test(item.id));
    assert.equal(twins.length, 2016);
    assert.deepEqual(
      twins.map((item) => item.id.replace("-selected-", "-")).sort(),
      matrix.map((item) => item.id).sort(),
    );
    assert.ok(cases.indexOf(twins[0]) > cases.indexOf(matrix.at(-1)));
    assert.equal(
      selected.filter((item) => item.tags.includes("boundary-selected-literal")).length,
      9,
    );
    assert.equal(selected.filter((item) => item.tags.includes("boundary-arithmetic")).length, 6);
  });
}

test("boundary reductions preserve guards, context and protected/ambiguous opener structure", () => {
  let reduced = 0;
  for (const item of boundaryCases(1)) {
    const original = nodesIn(item.node);
    const feature = original.find((node) => node.kind === "boundary");
    const guard = original.some((node) => node.kind === "boundary-guard");
    const context = original.find((node) => node.kind === "boundary-context")?.context;
    for (const candidate of reductions(item.node)) {
      if (spelling(candidate).length >= spelling(item.node).length) continue;
      reduced++;
      const nodes = nodesIn(candidate);
      const smaller = nodes.find((node) => node.kind === "boundary");
      assert.ok(smaller);
      assert.equal(smaller.form, feature.form);
      assert.equal(smaller.opener, feature.opener);
      assert.equal(smaller.protection, feature.protection);
      assert.equal(smaller.open, feature.open);
      assert.equal(smaller.closings, feature.closings);
      assert.equal(
        nodes.some((node) => node.kind === "boundary-guard"),
        guard,
      );
      assert.equal(nodes.find((node) => node.kind === "boundary-context")?.context, context);
      assert.ok(
        nodes.filter((node) => node.kind === "boundary-nest").length <=
          original.filter((node) => node.kind === "boundary-nest").length,
      );
      assert.ok(bound(candidate) <= 128);
    }
  }
  assert.ok(reduced > 600);
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
    "invalid-enclosing-range",
    "variable-name-boundary",
    "explicit-variable-boundary",
    "long-source-storage",
    "source-continuation",
    "continued-opaque-parameter",
    "ansi-quote-boundary",
    "inactive-command-comment",
    "inactive-deep-parameter",
    "generated-deep-parameter",
    "arithmetic-shift-boundary",
    "arithmetic-keyword-boundary",
    "inactive-arithmetic-boundary",
    "arithmetic-parenthesis-boundary",
    "inactive-subshell-case-boundary",
    "inactive-escaped-dollar-boundary",
  ])
    assert.ok(tags.has(tag), tag);
});

test("boundary syntax failures remain valid scored fixture observations", () => {
  const fixture = fixtureFor();
  for (const entry of fixture.cases) {
    if (entry.case.tags.includes("boundary-guard")) entry.bash.status = 2;
  }
  assert.equal(
    validateFixture("shell-braces-seed-1.json", fixture, options).length,
    fixture.cases.length,
  );
  assert.ok(
    matches(
      result({ status: 2, stdout: Buffer.alloc(0) }),
      result({ status: 2, stdout: Buffer.alloc(0) }),
    ),
  );
  assert.ok(
    !matches(
      result({ status: 2, stdout: Buffer.alloc(0) }),
      result({ status: 0, stdout: Buffer.alloc(0) }),
    ),
  );
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
    fixedCases().length + boundaryCases(1).length,
  );
  assert.equal(
    validateFixture("shell-braces-seed-42.json", fixtureFor(42), options).length,
    fixedCases().length + boundaryCases(1).length,
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
