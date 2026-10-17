#!/usr/bin/env node
// Original bounded brace grammar and runner, following fuzz-shell-words.mjs and
// fuzz-shell-arithmetic.mjs. No upstream brace implementation is copied here.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const queue = "/work/tmp/wave-heavy/run.sh";
const sourcePath = fileURLToPath(import.meta.url);
const oracleVersion = /^GNU bash, version 5\.3\.15(?:\(|\s)/;
const fieldLimit = 128;
const outputLimit = 4 * 1024 * 1024;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const fingerprint = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
const modes = ["unquoted", "double"];

function optionsFor(args) {
  const options = { count: 3000, seed: 1, timeoutMs: 2000, replays: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--queue-active") continue;
    if (arg === "--self-control") {
      options.selfControl = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run fuzz:shell-braces -- [options]
  --count N       Original generated cases (default: 3000), plus boundary matrix
  --seed N        Unsigned 32-bit seed (default: 1; also run seed 42)
  --timeout-ms N  Per-process timeout (default: 2000)
  --shell PATH    Existing native shell-engine; never builds a binary
  --self-control  Compare two fresh Bash runs; cannot record fixtures
  --output PATH   Save JSON diagnostics
  --record PATH   Record Bash 5.3.15 only after ALL candidate cases match
  --replay PATH   Strict recorded replay without Bash (repeatable)
  --help          Show this help

Self-queues through the host light queue when available. Ranges and Cartesian
products are bounded by construction; engine resource-limit tests are separate.
No unsupported exemptions: baseline arithmetic failures are MISMATCH too.`);
      process.exit(0);
    }
    const separator = arg.indexOf("=");
    const name = separator < 0 ? arg : arg.slice(0, separator);
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
    if (name === "--count") options.count = Number(value);
    else if (name === "--seed") {
      options.seed = Number(value);
      options.explicitSeed = true;
    } else if (name === "--timeout-ms") options.timeoutMs = Number(value);
    else if (name === "--shell") options.shell = resolve(value);
    else if (name === "--output") options.output = resolve(value);
    else if (name === "--record") options.record = resolve(value);
    else if (name === "--replay") options.replays.push(resolve(value));
    else throw new Error(`unknown option ${name}`);
  }
  if (!Number.isSafeInteger(options.count) || options.count < 0) throw new Error("invalid count");
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
    throw new Error("invalid uint32 seed");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error("invalid timeout");
  if (options.record && (options.replays.length || options.selfControl))
    throw new Error("record cannot be combined with replay or Bash self-control");
  if (options.selfControl && options.shell) throw new Error("self-control cannot select a shell");
  return options;
}

function randomFor(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>>= 0);
    },
    pick(items) {
      return items[this.next() % items.length];
    },
  };
}

// These productions describe scanner boundaries, not arbitrary pre-rendered atoms.
// Every exercise runs twice: behind a set `va` guard (scanned, never expanded)
// and selected, so command substitutions in each context also execute.
export const boundaryContexts = [
  "word",
  "braces",
  "default",
  "arithmetic",
  "command",
  "quoted-command",
];
export const boundaryProtections = ["escaped", "single", "double"];
export const boundaryOpeners = ["brace", "command", "arithmetic"];
export const boundaryBodies = [
  "case",
  "subshell",
  "case-subshell",
  "comment-open",
  "comment-close",
];
export const boundarySpellings = ["fused", "spaced"];
export const boundaryClosings = [1, 2, 3];
const boundarySuffixes = { brace: "{x,y}", command: "(x)", arithmetic: "((1+2))" };
const boundaryCommands = {
  case: "case x in x) :;; esac",
  subshell: "(printf x)",
  "case-subshell": "case x in x) (printf x);; esac",
  "comment-open": "# (\nprintf x",
  "comment-close": "# )\nprintf x",
};

export function spelling(node) {
  if (node.kind === "list") return `{${node.children.map(spelling).join(",")}}`;
  if (node.kind === "concat") return node.children.map(spelling).join("");
  if (node.kind === "boundary") {
    if (node.form === "ambiguity")
      return `${node.opener === "fused" ? "$((" : "$( ("}${boundaryCommands[node.body]}${Array.from({ length: node.closings }, () => ")").join(" ")}`;
    if (node.form === "arithmetic") return `$(((1+2) << ${node.shift}))`;
    const dollar = { escaped: "\\$", single: "'$'", double: '"$"' }[node.protection];
    const suffix = node.open ? "{x" : boundarySuffixes[node.opener];
    return dollar + (node.literal && node.opener !== "brace" ? quote(suffix) : suffix);
  }
  if (node.kind === "boundary-nest") return `\${u:-${spelling(node.child)}}`;
  if (node.kind === "boundary-guard") return `\${va:-${spelling(node.child)}}`;
  if (node.kind === "boundary-context") {
    const child = spelling(node.child);
    if (node.context === "braces") return `{left,${child},right}`;
    if (node.context === "default") return `\${u:-${child}}`;
    if (node.context === "arithmetic") return `$((0 + ${child}))`;
    if (node.context === "command") return `$(printf '%s' ${child})`;
    if (node.context === "quoted-command") return `$(printf '%s' "${child}")`;
    return child;
  }
  return node.text;
}

export function bound(node) {
  if (node.kind === "list") return node.children.reduce((sum, child) => sum + bound(child), 0);
  if (node.kind === "concat")
    return node.children.reduce((product, child) => product * bound(child), 1);
  // Open protected braces can expose a suffix after the parameter closes, so
  // retain the child's conservative field bound even for an inactive operand.
  if (node.kind === "boundary-guard") return bound(node.child);
  if (node.kind === "boundary-nest") return bound(node.child);
  if (node.kind === "boundary-context")
    return node.context === "braces" ? 2 + bound(node.child) : bound(node.child);
  if (node.kind === "boundary") return node.opener === "brace" ? 2 : 1;
  return node.fields ?? 1;
}

function atom(text, tag = "literal", fields = 1) {
  return { kind: "atom", text, tag, fields };
}

function tagsFor(node) {
  if (node.kind === "boundary")
    return ["boundary", `boundary-${node.form}`, `boundary-opener-${node.opener}`].concat(
      node.protection ? [`boundary-protection-${node.protection}`] : [],
      node.body ? [`boundary-body-${node.body}`, `boundary-closings-${node.closings}`] : [],
      node.literal ? ["boundary-selected-literal"] : [],
      node.form === "protected" && node.opener === "brace"
        ? [`boundary-brace-${node.open ? "open" : "closed"}`]
        : [],
    );
  if (node.child) {
    let depth = 0;
    for (let child = node.child; child.kind === "boundary-nest"; child = child.child) depth++;
    return [node.kind].concat(
      node.context ? [`boundary-context-${node.context}`, `boundary-depth-${depth}`] : [],
      tagsFor(node.child),
    );
  }
  return node.children ? [node.kind].concat(node.children.flatMap(tagsFor)) : [node.tag];
}

function range(random) {
  const numeric = random.next() % 2 === 0;
  const start = (random.next() % 13) - 6;
  const end = (random.next() % 13) - 6;
  const pad = random.next() % 3 === 0;
  const signed = random.next() % 4 === 0;
  const number = (n) =>
    `${n < 0 ? "-" : signed ? "+" : ""}${String(Math.abs(n)).padStart(pad ? 3 : 1, "0")}`;
  const letters = random.pick(["abcde", "VWXYZ"]);
  const left = numeric ? number(start) : random.pick(letters);
  const right = numeric ? number(end) : random.pick(letters);
  const step = random.pick(["", "..0", "..1", "..2", "..-2", "..3", "..-4", "..02"]);
  // Keep generated letter ranges in one case. Crossing Z..a can generate a
  // backtick that Bash reinterprets beside $v, entering command-substitution
  // parsing outside this grammar. An isolated fixed Z..a control remains below.
  return atom(
    `{${left}..${right}${step}}`,
    numeric ? "numeric-range" : "ascii-range",
    numeric ? 13 : 5,
  );
}

const atoms = [
  atom("x"),
  atom(""),
  atom("tail"),
  atom("'a b'", "quoted-space"),
  atom("''", "quoted-empty"),
  atom("\\{", "escaped-open"),
  atom("\\}", "escaped-close"),
  atom("\\,", "escaped-comma"),
  atom("'{a,b}'", "quoted-braces"),
  atom("'{'", "quoted-open"),
  atom("'}'", "quoted-close"),
  atom("','", "quoted-comma"),
  atom("${v}", "opaque-parameter"),
  atom("$v", "generated-braces"),
  atom("$((n++))", "arithmetic-side-effect"),
  atom("${empty}", "zero-field"),
];

function tree(random, depth) {
  if (depth === 0) return random.pick(atoms);
  const kind = random.next() % 5;
  if (kind === 0) return range(random);
  if (kind === 1) return random.pick(atoms);
  const children = Array.from({ length: kind === 2 ? 3 : 2 }, () => tree(random, depth - 1));
  const result = { kind: kind === 4 ? "concat" : "list", children };
  return bound(result) <= fieldLimit ? result : atom("{a,b}", "bounded-list", 2);
}

const setup = "n=0; v='{p,q}'; va=A; vb=B; v1=one; v2=two; empty=''; unset u";
const observe = (word) => `printf '<%s>\\n' 'fields' ${word}`;
const after = "printf 'state=<%s>\\n' status=$? n=$n v=\"$v\"";
function render(node, mode, context) {
  const raw = spelling(node);
  const word = mode === "double" ? `"${raw}"` : mode === "single" ? quote(raw) : raw;
  if (context === "assignment") return `${setup}; v=${word}; ${observe('"$v"')}; ${after}`;
  if (context === "parameter-operand")
    return `${setup}; ${observe(mode === "double" ? `"\${u:-${raw}}"` : `\${u:-${raw}}`)}; ${after}`;
  return `${setup}; ${observe(word)}; ${after}`;
}

function makeCase(id, node, mode = "unquoted", context = "word", extraTags = []) {
  return {
    id,
    context,
    mode,
    node,
    tags: Array.from(new Set(tagsFor(node).concat([context, mode], extraTags))).sort(),
    script: render(node, mode, context),
  };
}

export function fixedCases() {
  const words = [
    ["{a,b}", "comma-list"],
    ["$((1 << 2\n)){a,b}", "arithmetic-shift-boundary"],
    ["$((case == in)){a,b}", "arithmetic-keyword-boundary"],
    ["${va:-$((1 << 2\n))}{a,b}", "inactive-arithmetic-boundary"],
    ["$(((1+2) << 1)){a,b}", "arithmetic-parenthesis-boundary"],
    ["${va:-$((case x in x) :;; esac) )}{a,b}", "inactive-subshell-case-boundary"],
    ['${va:-$(echo "${u:-\\${x}")}{a,b}', "inactive-escaped-dollar-boundary"],
    ["${va:-$(# ) }\necho {a,b}\n)}", "inactive-command-comment"],
    [`${"${va:-"}${"${u:-".repeat(20)}x${"}".repeat(21)}`, "inactive-deep-parameter"],
    [`{a,b}${"${va:-"}${"${u:-".repeat(20)}x${"}".repeat(21)}`, "generated-deep-parameter"],
    ["{1..\\\n3}", "source-continuation"],
    ["{1.\\\n.3}", "source-continuation"],
    ["$\\\n{u:-{a,b}}", "continued-opaque-parameter"],
    ["$\\\n'\\''{a,b}", "continued-ansi-boundary"],
    [String.raw`$'\''{a,b}`, "ansi-quote-boundary"],
    [String.raw`$'\'{a,b}'{1,2}`, "ansi-quote-boundary"],
    [String.raw`{a,b}$'\''`, "ansi-quote-boundary"],
    [String.raw`$'\c\'{a,b}`, "ansi-control-boundary"],
    [`{${"x".repeat(4100)},tail}`, "long-source-storage"],
    ["p{a,b}s", "affixes"],
    ["{b,a,b}", "order-duplicates"],
    ["{,a}", "empty-first"],
    ["{a,}", "empty-last"],
    ["{,}", "zero-field"],
    ["{,,}", "zero-field"],
    ["p{,a}s", "empty-affixed"],
    ["{,}'x'", "empty-affixed"],
    ["{a,{b,c},d}", "nested"],
    ["{{a,b},{c,d}}", "nested"],
    ["{a,b}{1,2}", "adjacent"],
    ["{a,{b,c}}{1,2}", "cartesian-order"],
    ["{{a,b}}", "lookahead"],
    ["{{1..2}..3}", "invalid-enclosing-range"],
    ["{{a,b}..c}", "invalid-enclosing-range"],
    ["{a..{b,c}}", "invalid-enclosing-range"],
    ["{x}{a,b}", "lookahead"],
    ["{{a,b}", "unmatched-open"],
    ["{a,b}}", "unmatched-close"],
    ["}{a,b}", "unmatched-close"],
    ["{a", "unmatched-open"],
    ["a}", "unmatched-close"],
    ["{x}", "singleton-literal"],
    ["{a..a}", "singleton-range"],
    ["{3..3}", "singleton-range"],
    ["{1..4}", "ascending"],
    ["{4..1}", "descending"],
    ["{-3..2}", "signed-range"],
    ["{+1..+3}", "plus-sign"],
    ["{01..4}", "zero-padding"],
    ["{-02..02}", "signed-zero-padding"],
    ["{03..-2}", "signed-zero-padding"],
    ["{-00..00}", "signed-zero"],
    ["{1..5..0}", "step-zero"],
    ["{5..1..0}", "step-zero"],
    ["{1..5..-2}", "negative-step"],
    ["{5..1..2}", "descending-step"],
    ["{1..4..02}", "padded-step"],
    ["{a..e}", "ascii-range"],
    ["{e..a..-2}", "ascii-range"],
    ["{Z..a}", "ascii-punctuation"],
    ["{a..c..0}", "step-zero"],
    ["{1..x}", "invalid-range"],
    ["{1..3..x}", "invalid-step"],
    ["{1...3}", "invalid-range"],
    ["{1..3..1..2}", "invalid-range"],
    ["{a\\,b,c}", "escaped-comma"],
    ["\\{a,b}", "escaped-open"],
    ["{a,b\\}", "escaped-close"],
    ["{'a,b',c}", "quoted-comma"],
    ["'{'a,b'}'", "quoted-delimiters"],
    ["{a,'b c'}", "quoted-space"],
    ["{a,''}", "quoted-empty"],
    ["{a,'}'}", "quoted-close"],
    ["{${v},x}", "opaque-parameter"],
    ["${v}{a,b}", "opaque-parameter"],
    ["$v", "generated-braces"],
    ["$v{a,b}", "variable-name-boundary"],
    ["$v{1..2}", "variable-name-boundary"],
    ["${v}{1..2}", "explicit-variable-boundary"],
    ["$v{a,b}_suffix", "variable-name-boundary"],
    ["{1..${v}}", "opaque-range-end"],
    ["{${empty},a}", "zero-field"],
    ["$((n++))", "arithmetic-control"],
    ["{a,b}$((n++))", "arithmetic-once-per-word"],
    ["$((n++)){a,b}$((n++))", "arithmetic-order"],
    ["{x$((n++)),y$((n++))}", "arithmetic-selected-alternative"],
    ["{a,b}{c,d}$((n++))", "arithmetic-cartesian"],
    ["{$((n++)),}$((n++))", "arithmetic-empty-alternative"],
    ["{a,b}$((1/0))", "arithmetic-error"],
  ];
  const cases = words.flatMap(([word, tag], index) =>
    modes
      .concat(["single"])
      .map((mode) => makeCase(`fixed-${index}-${mode}`, atom(word, tag), mode)),
  );
  for (const context of ["assignment", "parameter-operand"])
    for (const [index, word] of ["{a,b}", "{1..3}", "{,}", "{a,b}$((n++))", "{${v},x}"].entries())
      for (const mode of modes)
        cases.push(
          makeCase(
            `negative-${context}-${index}-${mode}`,
            atom(word, "no-brace-expansion"),
            mode,
            context,
          ),
        );
  return cases;
}

export function boundaryCases(seed) {
  const random = randomFor(seed);
  const features = boundarySpellings
    .flatMap((opener) =>
      boundaryBodies.map((body) => ({
        kind: "boundary",
        form: "ambiguity",
        opener,
        body,
        closings: 2,
      })),
    )
    .concat(
      boundaryProtections.flatMap((protection) =>
        boundaryOpeners.flatMap((opener) =>
          (opener === "brace" ? [false, true] : [false]).map((open) => ({
            kind: "boundary",
            form: "protected",
            protection,
            opener,
            open,
          })),
        ),
      ),
      // Append new closing variants after the existing feature order, retaining
      // the seeded affix placement of every original protected-dollar exercise.
      boundaryClosings
        .filter((closings) => closings !== 2)
        .flatMap((closings) =>
          boundarySpellings.flatMap((opener) =>
            boundaryBodies.map((body) => ({
              kind: "boundary",
              form: "ambiguity",
              opener,
              body,
              closings,
            })),
          ),
        ),
    );
  const cases = [];
  const selected = [];
  // Complete cross product, independent of random sampling and --count. Keep
  // this separate from the original seeded stream so no old case is displaced.
  for (const feature of features)
    for (const context of boundaryContexts)
      for (let depth = 0; depth <= 3; depth++) {
        let child = feature;
        for (let level = 0; level < depth; level++) child = { kind: "boundary-nest", child };
        child = { kind: "boundary-context", context, child };
        const guarded = { kind: "boundary-guard", child };
        const children = [guarded, { kind: "list", children: [atom("a"), atom("b")] }];
        const reversed = random.next() % 2;
        if (reversed) children.reverse();
        const node = { kind: "concat", children };
        const closingId =
          feature.closings && feature.closings !== 2 ? `-closings-${feature.closings}` : "";
        const id = `boundary-${feature.form}-${feature.protection ?? feature.body}-${feature.opener}-${feature.open ? "open" : "closed"}-${context}-${depth}${closingId}`;
        for (const mode of modes) cases.push(makeCase(`${id}-${mode}`, node, mode));
        selected.push({ id, child, reversed });
      }
  // The same exercises without the guard, after every guarded case so the
  // original stream keeps its order: command bodies now run in each context.
  for (const { id, child, reversed } of selected) {
    const children = [child, { kind: "list", children: [atom("a"), atom("b")] }];
    if (reversed) children.reverse();
    const node = { kind: "concat", children };
    for (const mode of modes) cases.push(makeCase(`${id}-selected-${mode}`, node, mode));
  }
  // Selected controls distinguish literal dollars and real arithmetic from the
  // inactive scanner exercises. Parentheses remain protected shell-word text.
  for (const protection of boundaryProtections)
    for (const opener of boundaryOpeners) {
      const node = {
        kind: "concat",
        children: [
          { kind: "boundary", form: "protected", protection, opener, literal: true },
          { kind: "list", children: [atom("a"), atom("b")] },
        ],
      };
      cases.push(makeCase(`boundary-selected-${protection}-${opener}`, node));
    }
  for (const shift of [0, 1, 2])
    for (const mode of modes)
      cases.push(
        makeCase(
          `boundary-selected-arithmetic-${shift}-${mode}`,
          {
            kind: "concat",
            children: [
              { kind: "boundary", form: "arithmetic", opener: "arithmetic", shift },
              { kind: "list", children: [atom("a"), atom("b")] },
            ],
          },
          mode,
        ),
      );
  return cases;
}

export function generateCases(seed, count) {
  const random = randomFor(seed);
  const cases = fixedCases();
  for (let index = 0; index < count; index += 2) {
    let node = tree(random, 1 + (random.next() % 3));
    // An empty source is a missing argument, not an invalid shell command.
    if (!spelling(node)) node = atom("${empty}", "zero-field");
    const context = random.pick(["word", "word", "word", "assignment", "parameter-operand"]);
    for (const [offset, mode] of modes.entries()) {
      if (index + offset >= count) break;
      cases.push(makeCase(`generated-${index / 2}-${mode}`, node, mode, context));
    }
  }
  return cases.concat(boundaryCases(seed));
}

const encode = (result) => ({
  status: result.status,
  signal: result.signal,
  timedOut: result.timedOut,
  error: result.error,
  stdoutBase64: result.stdout.toString("base64"),
  stderrBase64: result.stderr.toString("base64"),
});
const decode = (result) => ({
  ...result,
  stdout: Buffer.from(result.stdoutBase64, "base64"),
  stderr: Buffer.from(result.stderrBase64, "base64"),
});
export function matches(a, b) {
  return (
    !a.timedOut &&
    !b.timedOut &&
    !a.error &&
    !b.error &&
    Number.isInteger(a.status) &&
    a.status === b.status &&
    a.signal === null &&
    b.signal === null &&
    a.stdout.equals(b.stdout)
  );
}

function run(bin, script, options) {
  const result = spawnSync(bin, ["-c", `set -f\n${script}`], {
    cwd: options.cwd,
    // No inherited startup hooks, shell options, owner HOME or open stdin.
    env: {
      PATH: "/usr/bin:/bin",
      HOME: options.cwd,
      TMPDIR: options.cwd,
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
    },
    input: Buffer.alloc(0),
    encoding: null,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: outputLimit,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error?.code ?? null,
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? result.error?.message ?? ""),
  };
}

function coverage(cases) {
  return {
    contexts: Array.from(new Set(cases.map((test) => test.context))).sort(),
    modes: Array.from(new Set(cases.map((test) => test.mode))).sort(),
    tags: Array.from(new Set(cases.flatMap((test) => test.tags))).sort(),
  };
}

export function validateFixture(path, fixture, options) {
  if (fixture.schema !== 1 || fixture.sourceHash !== fingerprint())
    throw new Error("stale brace fixture hash/schema");
  if (!oracleVersion.test(fixture.bash ?? "")) throw new Error("fixture Bash version differs");
  if (fixture.count !== options.count || fixture.timeoutMs !== options.timeoutMs)
    throw new Error("fixture count/timeout differs");
  if (
    !Number.isInteger(fixture.seed) ||
    fixture.seed < 0 ||
    fixture.seed > 0xffffffff ||
    (options.explicitSeed && fixture.seed !== options.seed)
  )
    throw new Error("fixture seed differs");
  const filenameSeed = /seed-(\d+)\.json$/.exec(path);
  if (filenameSeed && Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed differs");
  const cases = generateCases(fixture.seed, fixture.count);
  if (JSON.stringify(fixture.coverage) !== JSON.stringify(coverage(cases)))
    throw new Error("fixture coverage differs");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== cases.length)
    throw new Error("fixture length differs");
  for (const [index, test] of cases.entries()) {
    const entry = fixture.cases[index];
    if (JSON.stringify(test) !== JSON.stringify(entry?.case))
      throw new Error(`fixture case differs at ${index}`);
    const result = entry.bash;
    if (
      !result ||
      !Number.isInteger(result.status) ||
      result.status < 0 ||
      result.status > 255 ||
      result.signal !== null ||
      result.timedOut !== false ||
      result.error !== null
    )
      throw new Error(`invalid fixture process result at ${index}`);
    for (const key of ["stdoutBase64", "stderrBase64"])
      if (
        typeof result[key] !== "string" ||
        Buffer.from(result[key], "base64").toString("base64") !== result[key] ||
        Buffer.from(result[key], "base64").length > outputLimit
      )
        throw new Error(`invalid fixture bytes at ${index}`);
  }
  return cases;
}

function mismatchSignature(bash, ours) {
  return JSON.stringify([
    bash.status,
    ours.status,
    bash.signal,
    ours.signal,
    bash.timedOut,
    ours.timedOut,
    bash.error,
    ours.error,
    bash.stdout.equals(ours.stdout),
  ]);
}

function containsBoundary(node) {
  if (node.kind === "boundary") return true;
  if (node.child) return containsBoundary(node.child);
  return node.children?.some(containsBoundary) ?? false;
}

export function reductions(node) {
  if (node.kind === "boundary") {
    if (node.form === "ambiguity" && node.body === "case-subshell")
      return [
        { ...node, body: "case" },
        { ...node, body: "subshell" },
      ];
    if (node.form === "arithmetic" && node.shift) return [{ ...node, shift: 0 }];
    return [];
  }
  if (node.child) {
    const candidates = reductions(node.child).map((child) => ({ ...node, child }));
    // A nesting wrapper can disappear, but not a guard or context wrapper:
    // shrinking must never turn inactive command syntax into selected execution.
    return node.kind === "boundary-nest" ? [node.child].concat(candidates) : candidates;
  }
  if (!node.children) return node.text === "x" ? [] : [atom("x")];
  const candidates = containsBoundary(node)
    ? node.children.filter(containsBoundary)
    : node.children.slice();
  if (node.children.length > 2) candidates.push({ ...node, children: node.children.slice(0, 2) });
  for (const [index, child] of node.children.entries()) {
    for (const replacement of reductions(child)) {
      const children = node.children.slice();
      children[index] = replacement;
      candidates.push({ ...node, children });
    }
  }
  return candidates;
}

function shrink(test, original, options, bashBin, shell) {
  // Keep context, quoting AND exact process-failure signature. A stdout mismatch
  // must not shrink into a syntax error, timeout, spawn failure or status mismatch.
  const signature = mismatchSignature(original.bash, original.ours);
  let best = { test, ...original };
  let attempts = 0;
  for (;;) {
    let improved = false;
    for (const node of reductions(best.test.node)) {
      if (spelling(node).length >= spelling(best.test.node).length) continue;
      if (++attempts > 24) return { ...best, attempts: attempts - 1 };
      const candidate = makeCase(test.id, node, test.mode, test.context);
      const bash = run(bashBin, candidate.script, options);
      const ours = run(shell, candidate.script, options);
      if (!matches(bash, ours) && mismatchSignature(bash, ours) === signature) {
        best = { test: candidate, bash, ours };
        improved = true;
        break;
      }
    }
    if (!improved) return { ...best, attempts };
  }
}

function execute(cases, options, shell, bashBin, oracle) {
  const counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
  const byContext = {};
  const byFeature = {};
  const oracleStatuses = {};
  const candidateStatuses = {};
  const mismatches = [];
  const results = [];
  for (const [index, test] of cases.entries()) {
    const bash = oracle ? decode(oracle[index].bash) : run(bashBin, test.script, options);
    const ours = run(shell, test.script, options);
    const classification = matches(bash, ours) ? "MATCH" : "MISMATCH";
    counts[classification]++;
    for (const [map, result] of [
      [oracleStatuses, bash],
      [candidateStatuses, ours],
    ]) {
      const key = JSON.stringify([result.status, result.signal, result.error]);
      map[key] = (map[key] ?? 0) + 1;
    }
    for (const [map, keys] of [
      [byContext, [test.context]],
      [byFeature, test.tags],
    ])
      for (const key of keys) (map[key] ??= { MATCH: 0, MISMATCH: 0 })[classification]++;
    if (classification === "MISMATCH" && mismatches.length < 40) {
      const original = { case: test, bash: encode(bash), ours: encode(ours) };
      // Recorded replay never invokes Bash, including during shrinking.
      const minimal =
        !oracle && mismatches.length < 10
          ? shrink(test, { bash, ours }, options, bashBin, shell)
          : null;
      mismatches.push({
        ...original,
        minimized: minimal
          ? {
              case: minimal.test,
              bash: encode(minimal.bash),
              ours: encode(minimal.ours),
              attempts: minimal.attempts,
            }
          : undefined,
      });
    }
    if (options.record) results.push({ case: test, bash: encode(bash) });
  }
  return {
    total: cases.length,
    counts,
    coverage: coverage(cases),
    byContext,
    byFeature,
    oracleStatuses,
    candidateStatuses,
    mismatches,
    results,
  };
}

function ensureQueued() {
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const child = spawnSync(
    "bash",
    [queue, "--class", "light", "brush-web-brace-fuzz", "--", process.execPath, sourcePath].concat(
      process.argv.slice(2),
      ["--queue-active"],
    ),
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

function main() {
  const options = optionsFor(process.argv.slice(2));
  ensureQueued();
  const bashBin = process.env.BASH_BIN ?? "/usr/bin/bash";
  const shell = options.selfControl
    ? bashBin
    : (options.shell ??
      process.env.FUZZ_SHELL_BIN ??
      resolve(root, ".build/shell/release/shell-engine"));
  if (!existsSync(shell))
    throw new Error(`Pass an existing native --shell PATH; no automatic builds: ${shell}`);
  if (options.record && realpathSync(shell) === realpathSync(bashBin))
    throw new Error("cannot record against Bash itself");
  // Own only this per-run directory. Never touch other lanes' binaries/scratch.
  const parent = process.env.FUZZ_BRACES_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "brush-web-braces-run-"));
  options.cwd = scratch;
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const interrupted = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    let reports;
    if (options.replays.length) {
      // Validate every fixture before running any candidate case.
      const fixtures = options.replays.map((path) => {
        const fixture = JSON.parse(readFileSync(path, "utf8"));
        return { path, fixture, cases: validateFixture(path, fixture, options) };
      });
      reports = fixtures.map(({ path, fixture, cases }) => ({
        path,
        seed: fixture.seed,
        ...execute(cases, options, shell, null, fixture.cases),
      }));
    } else {
      const bash = execFileSync(bashBin, ["--version"], { encoding: "utf8" }).split("\n", 1)[0];
      if (!oracleVersion.test(bash)) throw new Error(`Bash 5.3.15 required, got ${bash}`);
      const cases = generateCases(options.seed, options.count);
      const result = execute(cases, options, shell, bashBin);
      reports = [{ seed: options.seed, bash, ...result }];
      // Always retain diagnostics on a dirty --record run, but never a fixture.
      if (options.record && result.counts.MISMATCH === 0) {
        const fixture = {
          schema: 1,
          sourceHash: fingerprint(),
          seed: options.seed,
          count: options.count,
          timeoutMs: options.timeoutMs,
          bash,
          coverage: coverage(cases),
          cases: result.results,
        };
        validateFixture(options.record, fixture, options);
        mkdirSync(dirname(options.record), { recursive: true });
        writeFileSync(options.record, JSON.stringify(fixture, null, 2) + "\n");
      }
    }
    const report = {
      schema: 1,
      mode: options.replays.length ? "replay" : options.selfControl ? "bash-self-control" : "live",
      sourceHash: fingerprint(),
      generated: options.count + boundaryCases(options.seed).length,
      originalGenerated: options.count,
      boundaryGenerated: boundaryCases(options.seed).length,
      fixed: fixedCases().length,
      timeoutMs: options.timeoutMs,
      shell,
      recordPending: Boolean(options.record && reports.some((item) => item.counts.MISMATCH)),
      reports: reports.map(({ results, ...item }) => item),
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) writeFileSync(options.output, text);
    process.stdout.write(text);
    if (report.recordPending)
      console.error("Refusing to record brace fixtures while candidate mismatches remain.");
    if (reports.some((item) => item.counts.MISMATCH)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
