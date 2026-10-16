#!/usr/bin/env node
// Deterministic differential fuzzer for quote and parameter-word boundaries.
// The native shell binary is intentionally used here: this lane is about parser,
// lexer, and lazy-reparse behavior, not the browser/WASI adapter.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const queue = "/work/tmp/wave-heavy/run.sh";
const operators = [
  ":-",
  "-",
  ":=",
  "=",
  ":+",
  "+",
  ":?",
  "/",
  "//",
  "/#",
  "/%",
  "#",
  "##",
  "%",
  "%%",
  "^",
  "^^",
  ",",
  ",,",
  "!",
  "#name",
];
const knownUnsupportedOperators = new Set();
const operatorGroups = new Map([
  [":-", "default"],
  ["-", "default"],
  [":=", "assignment"],
  ["=", "assignment"],
  [":+", "alternative"],
  ["+", "alternative"],
  [":?", "error"],
  ["/", "replacement"],
  ["//", "replacement"],
  ["/#", "replacement"],
  ["/%", "replacement"],
  ["#", "trim-prefix"],
  ["##", "trim-prefix"],
  ["%", "trim-suffix"],
  ["%%", "trim-suffix"],
  ["^", "case"],
  ["^^", "case"],
  [",", "case"],
  [",,", "case"],
  ["!", "indirection"],
  ["#name", "length"],
]);

function usage() {
  console.log(`Usage: npm run fuzz:shell-words -- [options]

Options:
  --count N       Generated cases, excluding fixed regressions (default: 3000)
  --seed N        Unsigned deterministic seed (default: 1)
  --timeout-ms N  Timeout for each Bash and shell process (default: 2000)
  --shell PATH    Existing native shell-engine binary
  --output PATH   Write the same JSON report printed to stdout
  --record PATH  Record Bash 5.3.15 output and require a clean native run
  --replay PATH  Replay a recorded fixture without invoking Bash (repeatable)
  --help          Show this help

If --shell is omitted, shell-engine is built in a temporary target directory through
/work/tmp/wave-heavy/run.sh and removed when this command exits.`);
}

function parseArgs(argv) {
  const options = {
    count: 3000,
    seed: 1,
    timeoutMs: 2000,
    shell: process.env.FUZZ_SHELL_BIN,
    replays: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--queue-active") continue;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    const [name, inline] = arg.split("=", 2);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--count") options.count = Number.parseInt(value, 10);
    else if (name === "--seed") options.seed = Number(value) >>> 0;
    else if (name === "--timeout-ms") options.timeoutMs = Number.parseInt(value, 10);
    else if (name === "--shell") options.shell = resolve(value);
    else if (name === "--output") options.output = resolve(value);
    else if (name === "--record") options.record = resolve(value);
    else if (name === "--replay") options.replays.push(resolve(value));
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isSafeInteger(options.count) || options.count < 0)
    throw new Error("--count must be a non-negative integer");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error("--timeout-ms must be a positive integer");
  return options;
}

function rng(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    },
    pick(items) {
      return items[this.next() % items.length];
    },
    chance(numerator, denominator = 2) {
      return this.next() % denominator < numerator;
    },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const atomPool = [
  { source: "x", tags: ["literal"] },
  { source: "following", tags: ["literal", "following-word"] },
  { source: "'single'", tags: ["single-quoted"] },
  { source: '"double"', tags: ["double-quoted"] },
  { source: '"don\'t"', tags: ["double-quoted", "apostrophe"] },
  { source: "'$('", tags: ["single-quoted", "raw-dollar-paren"] },
  { source: "'${'", tags: ["single-quoted", "raw-dollar-brace"] },
  { source: "'`'", tags: ["single-quoted", "raw-backtick"] },
  { source: "\\ ", tags: ["backslash", "space"] },
  { source: "\\{", tags: ["backslash", "brace"] },
  { source: "\\}", tags: ["backslash", "brace"] },
  { source: "'{'", tags: ["single-quoted", "brace"] },
  { source: "'}'", tags: ["single-quoted", "brace"] },
  { source: "'/'", tags: ["single-quoted", "slash"] },
  { source: "'*'", tags: ["single-quoted", "star"] },
  { source: "'?'", tags: ["single-quoted", "question"] },
  { source: "'[a-z]'", tags: ["single-quoted", "bracket"] },
  { source: "''", tags: ["single-quoted", "empty"] },
  { source: '""', tags: ["double-quoted", "empty"] },
  { source: "'a b'", tags: ["single-quoted", "space"] },
  { source: '"a b"', tags: ["double-quoted", "space"] },
  { source: "a", tags: ["literal"] },
  { source: "b", tags: ["literal"] },
];
const patternPool = atomPool.filter(
  ({ tags }) => !tags.includes("space") || tags.includes("single-quoted"),
);
const states = ["unset", "empty", "value"];
const values = ["b", "abc", "a b", "don't", "'", "${", "$(", "a/b", "a*?", "foo"];

function combineTags(...parts) {
  return Array.from(new Set(parts.flatMap((part) => part.tags ?? part))).toSorted();
}

function buildOperand(random, depth) {
  if (depth > 0 && random.chance(2, 5)) {
    const nestedTarget = random.chance(1, 2) ? "u" : "v";
    const nested = expressionFor(random.pick(operators), random, depth - 1, nestedTarget);
    const quoted = !nested.source.includes('"') && random.chance(1, 3);
    return {
      source: quoted ? `"${nested.source}"` : nested.source,
      tags: combineTags(nested, ["nested-" + depth].concat(quoted ? ["nested-double-quoted"] : [])),
    };
  }
  const atom = random.pick(atomPool);
  return { source: atom.source, tags: atom.tags };
}

function buildPattern(random, depth) {
  if (depth > 0 && random.chance(1, 5)) return buildOperand(random, depth);
  return random.pick(patternPool);
}

function expressionFor(operator, random, depth, target = "v") {
  if (operator === "!") return { source: "${!pointer}", tags: ["indirection"] };
  if (operator === "#name") return { source: `\${#${target}}`, tags: ["length"] };
  if (operator === "^" || operator === "^^" || operator === "," || operator === ",,") {
    const pattern = random.chance(1, 2)
      ? buildPattern(random, depth)
      : { source: "", tags: ["empty"] };
    return {
      source: `\${${target}${operator}${pattern.source}}`,
      tags: combineTags(pattern, ["case"]),
    };
  }
  if (operator === "/" || operator === "//" || operator === "/#" || operator === "/%") {
    const pattern = buildPattern(random, depth);
    const replacement = buildOperand(random, depth);
    return {
      source: `\${${target}${operator}${pattern.source}/${replacement.source}}`,
      tags: combineTags(pattern, replacement, ["replacement"]),
    };
  }
  const operand = buildOperand(random, depth);
  return {
    source: `\${${target}${operator}${operand.source}}`,
    tags: combineTags(operand, [operatorGroups.get(operator)]),
  };
}

function stateAssignment(name, state, value) {
  if (state === "unset") return `unset ${name}`;
  if (state === "empty") return `${name}=''`;
  return `${name}=${shellQuote(value)}`;
}

function renderCase(testCase) {
  if (testCase.fixedScript) return testCase.fixedScript;
  const assignments = [
    "unset v u pointer",
    stateAssignment("v", testCase.valueState, testCase.value),
    stateAssignment("u", testCase.operandState, testCase.operandValue),
    "pointer=v",
  ];
  const printed =
    testCase.quote === "double" ? `"${testCase.expression.source}"` : testCase.expression.source;
  // Repeating %s consumes every post-expansion field, preserving boundaries.
  return `${assignments.join("; ")}; printf '<%s>\\n' ${printed} following`;
}

function generatedCase(random, index, requestedQuote) {
  const operator = operators[index % operators.length];
  const expression = expressionFor(operator, random, random.next() % 4);
  const valueState = random.pick(states);
  const operandState = random.pick(states);
  const quote = requestedQuote ?? (random.chance(1, 2) ? "double" : "top-level");
  return {
    id: `generated-${index}-${quote}`,
    operator,
    quote,
    valueState,
    operandState,
    value: random.pick(values),
    operandValue: random.pick(values),
    expression,
    featureTags: combineTags(expression, [operator, quote, testCaseQuoteTag(expression)]),
  };
}

function testCaseQuoteTag(expression) {
  return expression.tags?.includes("double-quoted") ? "inner-double-quote" : "word";
}

function fixedCases() {
  const expressions = [
    {
      label: "nested-default-dont",
      operator: "/",
      source: '${v/b/${u:-"don\'t"}}',
      tags: ["replacement", "nested-1", "double-quoted", "apostrophe"],
    },
    {
      label: "nested-default-single-quote",
      operator: "/",
      source: '${v/b/${u:-"\'"}}',
      tags: ["replacement", "nested-1", "double-quoted", "single-quote-content"],
    },
    {
      label: "raw-single-dollar-paren",
      operator: "/",
      source: "${v/b/'$('}",
      tags: ["replacement", "single-quoted", "raw-dollar-paren"],
    },
    {
      label: "raw-single-dollar-brace",
      operator: "/",
      source: "${v/b/'${'}",
      tags: ["replacement", "single-quoted", "raw-dollar-brace"],
    },
    {
      label: "bare-left-brace",
      operator: "/",
      source: "${v/b/{}",
      tags: ["replacement", "brace"],
    },
    {
      label: "bare-right-brace",
      operator: "/",
      source: "${v/b/}}",
      tags: ["replacement", "brace"],
    },
    {
      label: "double-apostrophe-following",
      operator: "/",
      source: '${v/b/"don\'t"following}',
      tags: ["replacement", "double-quoted", "apostrophe", "following-word"],
    },
  ];
  return expressions.flatMap((entry) =>
    ["top-level", "double"].map((quote) => ({
      id: `fixed-${entry.label}-${quote}`,
      label: entry.label,
      operator: entry.operator,
      quote,
      valueState: entry.valueState ?? "value",
      operandState: "empty",
      expectedUnsupported: entry.expectedUnsupported ?? false,
      expression: { source: entry.source, tags: entry.tags },
      featureTags: combineTags(entry.tags, [quote]),
      fixedScript: `unset v u pointer; ${entry.valueState === "unset" ? "unset v" : "v='abc'"}; u=''; pointer=v; printf '<%s>\\n' ${quote === "double" ? `"${entry.source}"` : entry.source} following`,
    })),
  );
}

function generateCases(seed, count) {
  const random = rng(seed);
  const cases = fixedCases();
  let generated = 0;
  for (let template = 0; generated < count; template++) {
    const topLevel = generatedCase(random, template, "top-level");
    cases.push(topLevel);
    generated++;
    if (generated < count) {
      cases.push({
        ...topLevel,
        id: `generated-${template}-double`,
        quote: "double",
        featureTags: combineTags(topLevel.expression, [
          topLevel.operator,
          "double",
          testCaseQuoteTag(topLevel.expression),
        ]),
      });
      generated++;
    }
  }
  return cases;
}

function sourceHash() {
  return createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");
}

function caseIdentity(testCase) {
  return {
    id: testCase.id,
    label: testCase.label,
    operator: testCase.operator,
    quote: testCase.quote,
    valueState: testCase.valueState,
    operandState: testCase.operandState,
    value: testCase.value,
    operandValue: testCase.operandValue,
    expectedUnsupported: testCase.expectedUnsupported ?? false,
    expression: testCase.expression,
    featureTags: testCase.featureTags,
    fixedScript: testCase.fixedScript,
  };
}

function coverage(cases) {
  return {
    operators: cases
      .map((testCase) => testCase.operator)
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted(),
    quotes: cases
      .map((testCase) => testCase.quote)
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted(),
  };
}

function encodeResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut || undefined,
    stdoutBase64: result.stdout.toString("base64"),
    stderrBase64: result.stderr.toString("base64"),
  };
}

function decodeResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: Buffer.from(result.stdoutBase64 ?? "", "base64"),
    stderr: Buffer.from(result.stderrBase64 ?? "", "base64"),
  };
}

function validateFixture(fixturePath, fixture, expectedCases, expectedSeed, expectedCount) {
  if (fixture.schema !== 1) throw new Error("unsupported shell-word fixture schema");
  if (fixture.sourceHash !== sourceHash())
    throw new Error("fixture source hash does not match this fuzzer");
  if (fixture.seed !== expectedSeed || fixture.count !== expectedCount)
    throw new Error("fixture seed/count does not match requested coverage");
  if (!Number.isSafeInteger(fixture.timeoutMs) || fixture.timeoutMs < 1)
    throw new Error("fixture timeout is invalid");
  const filenameSeed = /seed-(\d+)\.json$/.exec(fixturePath);
  if (filenameSeed && Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed does not match fixture seed");
  if (fixture.operators?.join("\u0000") !== operators.join("\u0000"))
    throw new Error("fixture operator list does not match this fuzzer");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== expectedCases.length)
    throw new Error("fixture case count does not match generated coverage");
  const expectedCoverage = coverage(expectedCases);
  if (JSON.stringify(fixture.coverage) !== JSON.stringify(expectedCoverage))
    throw new Error("fixture operator/quote coverage is incomplete or stale");
  for (let index = 0; index < expectedCases.length; index++) {
    const actual = fixture.cases[index];
    const expected = expectedCases[index];
    if (actual.script !== renderCase(expected))
      throw new Error(`fixture script differs at case ${expected.id}`);
    if (JSON.stringify(actual.case) !== JSON.stringify(caseIdentity(expected)))
      throw new Error(`fixture case identity differs at case ${expected.id}`);
    if (!actual.bash?.stdoutBase64 && actual.bash?.stdoutBase64 !== "")
      throw new Error(`fixture Bash result is missing at case ${expected.id}`);
  }
}

function runProcess(command, args, script, timeoutMs) {
  const env = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(command, args, {
    input: undefined,
    encoding: null,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  if (result.error) {
    return {
      status: result.error.code === "ETIMEDOUT" ? null : 1,
      timedOut: result.error.code === "ETIMEDOUT",
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? String(result.error.message)),
    };
  }
  return {
    status: result.status,
    signal: result.signal ?? undefined,
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
  };
}

function equalBytes(left, right) {
  return left.equals(right);
}

function isAllowedUnsupported(testCase, ours, bash) {
  if (bash.status !== 0 || ours.status !== 2) return false;
  if (!/unsupported|parse|syntax/i.test(ours.stderr.toString())) return false;
  return testCase.expectedUnsupported === true || knownUnsupportedOperators.has(testCase.operator);
}

function classify(testCase, bash, ours) {
  if (bash.timedOut || ours.timedOut) return "MISMATCH";
  if (isAllowedUnsupported(testCase, ours, bash)) return "UNSUPPORTED";
  if (bash.status !== ours.status || !equalBytes(bash.stdout, ours.stdout)) return "MISMATCH";
  return "MATCH";
}

function resultView(result) {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut || undefined,
    stdout: result.stdout.toString("utf8"),
    stdoutBase64: result.stdout.toString("base64"),
    stderr: result.stderr.toString("utf8").slice(0, 2000),
  };
}

function execute(testCase, bashBin, shellBin, timeoutMs) {
  const script = renderCase(testCase);
  const bash = runProcess(
    bashBin,
    ["--noprofile", "--norc", "-c", `set -f\n${script}`],
    script,
    timeoutMs,
  );
  const ours = runProcess(shellBin, ["-c", script], script, timeoutMs);
  return { script, bash, ours, classification: classify(testCase, bash, ours) };
}

function recordFixture(path, options, cases, bashBin, shellBin) {
  const bash = bashVersion(bashBin);
  if (!bash.startsWith("GNU bash, version 5.3.15"))
    throw new Error(`recording requires GNU Bash 5.3.15, got ${bash}`);
  const recorded = [];
  let mismatch = null;
  for (const testCase of cases) {
    const result = execute(testCase, bashBin, shellBin, options.timeoutMs);
    if (result.classification !== "MATCH" && !mismatch) mismatch = { testCase, result };
    recorded.push({
      case: caseIdentity(testCase),
      script: result.script,
      bash: encodeResult(result.bash),
    });
  }
  if (mismatch)
    throw new Error(
      `cannot record a dirty fixture at ${mismatch.testCase.id}: ${JSON.stringify(resultView(mismatch.result.ours))}`,
    );
  const fixture = {
    schema: 1,
    sourceHash: sourceHash(),
    seed: options.seed,
    count: options.count,
    timeoutMs: options.timeoutMs,
    bash,
    operators,
    coverage: coverage(cases),
    cases: recorded,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  return fixture;
}

function replayFixture(path, shellBin, expectedCount) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (fixture.count !== expectedCount)
    throw new Error(
      `fixture count ${fixture.count} does not match requested count ${expectedCount}`,
    );
  const cases = generateCases(fixture.seed, fixture.count);
  validateFixture(path, fixture, cases, fixture.seed, expectedCount);
  const counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
  const mismatches = [];
  for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index];
    const expected = decodeResult(fixture.cases[index].bash);
    const ours = runProcess(
      shellBin,
      ["-c", fixture.cases[index].script],
      fixture.cases[index].script,
      fixture.timeoutMs,
    );
    const classification = classify(testCase, expected, ours);
    counts[classification]++;
    if (classification === "MISMATCH" && mismatches.length < 50) {
      mismatches.push({
        id: testCase.id,
        operator: testCase.operator,
        quote: testCase.quote,
        featureTags: testCase.featureTags,
        script: fixture.cases[index].script,
        bash: resultView(expected),
        ours: resultView(ours),
      });
    }
  }
  return { path, seed: fixture.seed, total: cases.length, counts, mismatches };
}

function shrinkCase(testCase, bashBin, shellBin, timeoutMs, original) {
  if (testCase.fixedScript) return original;
  const candidates = [];
  const simplify = (patch) => candidates.push({ ...testCase, ...patch });
  simplify({ quote: "top-level" });
  simplify({ valueState: "empty" });
  simplify({ operandState: "empty" });
  simplify({
    expression: {
      ...testCase.expression,
      source: `\${v${testCase.operator}${testCase.operator.includes("/") ? "x/x" : "x"}}`,
      tags: [testCase.operator],
    },
  });
  for (const candidate of candidates) {
    const run = execute(candidate, bashBin, shellBin, timeoutMs);
    if (run.classification === "MISMATCH") {
      testCase = candidate;
      original = { ...run, case: candidate };
    }
  }
  return original;
}

function incrementCount(map, key, classification) {
  const bucket = (map[key] ??= { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 });
  bucket[classification]++;
}

function bashVersion(bashBin) {
  return execFileSync(bashBin, ["--version"], { encoding: "utf8" }).split("\n", 1)[0];
}

function ensureQueued() {
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const result = spawnSync(
    "bash",
    [queue, "--class", "light", "brush-web-fuzz", "--", process.execPath, process.argv[1]].concat(
      process.argv.slice(2),
      "--queue-active",
    ),
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function buildShell(options, scratch) {
  if (options.shell) return options.shell;
  const target = resolve(scratch, "target");
  execFileSync(
    "/work/cache/cargo/bin/cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      "shell/Cargo.toml",
      "-p",
      "shell-engine",
      "-j2",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CARGO_HOME: "/work/cache/cargo",
        RUSTUP_HOME: "/work/cache/rustup",
        CARGO_TARGET_DIR: target,
        PATH: `/work/cache/cargo/bin:${process.env.PATH}`,
      },
      stdio: "inherit",
    },
  );
  return resolve(target, "release/shell-engine");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureQueued();
  const scratch = options.shell ? null : mkdtempSync("/work/tmp/brush-web-fuzz-");
  try {
    const shellBin = buildShell(options, scratch);
    if (options.replays.length) {
      const reports = options.replays.map((path) => replayFixture(path, shellBin, options.count));
      const replayReport = { mode: "replay", reports };
      const text = JSON.stringify(replayReport, null, 2) + "\n";
      if (options.output) writeFileSync(options.output, text);
      for (const report of reports)
        console.log(
          `replay ${report.path}: MATCH=${report.counts.MATCH} UNSUPPORTED=${report.counts.UNSUPPORTED} MISMATCH=${report.counts.MISMATCH}`,
        );
      process.stdout.write(text);
      if (reports.some((report) => report.counts.MISMATCH > 0 || report.counts.UNSUPPORTED > 0))
        process.exitCode = 1;
      return;
    }
    const bashBin = process.env.BASH_BIN ?? "bash";
    const cases = generateCases(options.seed, options.count);
    if (options.record) {
      const fixture = recordFixture(options.record, options, cases, bashBin, shellBin);
      console.log(`recorded clean fixture: ${options.record}`);
      console.log(`seed=${fixture.seed} cases=${fixture.cases.length} bash=${fixture.bash}`);
      return;
    }
    const counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
    const byOperator = {};
    const byFeature = {};
    const mismatches = [];
    let mismatchTotal = 0;
    for (const testCase of cases) {
      const result = execute(testCase, bashBin, shellBin, options.timeoutMs);
      counts[result.classification]++;
      incrementCount(byOperator, testCase.operator, result.classification);
      for (const feature of testCase.featureTags ?? [])
        incrementCount(byFeature, feature, result.classification);
      if (result.classification === "MISMATCH") {
        mismatchTotal++;
        if (mismatches.length >= 50) continue;
        const minimized = shrinkCase(testCase, bashBin, shellBin, options.timeoutMs, {
          ...result,
          case: testCase,
        });
        mismatches.push({
          id: minimized.case.id,
          operator: minimized.case.operator,
          quote: minimized.case.quote,
          featureTags: minimized.case.featureTags,
          script: minimized.script,
          bash: resultView(minimized.bash),
          ours: resultView(minimized.ours),
        });
      }
    }
    const report = {
      version: 1,
      seed: options.seed,
      generated: options.count,
      total: cases.length,
      timeoutMs: options.timeoutMs,
      bash: bashVersion(bashBin),
      shell: shellBin,
      counts,
      byOperator,
      byFeature,
      mismatchTotal,
      mismatches,
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) writeFileSync(options.output, text);
    console.log(`shell word differential fuzz: seed=${options.seed} cases=${cases.length}`);
    console.log(
      `MATCH=${counts.MATCH} UNSUPPORTED=${counts.UNSUPPORTED} MISMATCH=${counts.MISMATCH}`,
    );
    if (options.output) console.log(`report=${options.output}`);
    if (mismatches.length) {
      console.log(`\nMinimized mismatches (first ${mismatches.length} of ${mismatchTotal}):`);
      for (const mismatch of mismatches) {
        console.log(`\n[${mismatch.id}] ${mismatch.operator} ${mismatch.quote}`);
        console.log(`script: ${mismatch.script}`);
        console.log(`bash(${mismatch.bash.status}): ${JSON.stringify(mismatch.bash.stdout)}`);
        console.log(`ours(${mismatch.ours.status}): ${JSON.stringify(mismatch.ours.stdout)}`);
      }
    }
    console.log("\nFull report:");
    process.stdout.write(text);
    if (mismatches.length) process.exitCode = 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

main();
