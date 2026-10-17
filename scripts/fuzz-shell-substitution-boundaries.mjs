#!/usr/bin/env node
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
const outputLimit = 4 * 1024 * 1024;

export const boundaryContexts = [
  "plain",
  "double",
  "default-set",
  "default-unset",
  "arithmetic",
  "command",
  "process",
];
export const boundaryOpeners = [
  "command",
  "command-subshell",
  "arithmetic",
  "process",
  "process-subshell",
  "backtick",
];
export const boundarySpellings = ["fused", "spaced"];
export const boundaryClosings = [1, 2, 3];

const openerText = {
  command: { fused: "$(", spaced: "$( " },
  "command-subshell": { fused: "$((", spaced: "$( (" },
  arithmetic: { fused: "$((", spaced: "$(( " },
  process: { fused: "<(", spaced: "<( " },
  "process-subshell": { fused: "<((", spaced: "<(( " },
  backtick: { fused: "\`", spaced: "\`" },
};

const heredocBodies = [
  ["heredoc-plain", ": <<EOF\nplain\nEOF"],
  ["heredoc-quoted", ": <<'EOF'\n$(ignored) \"quoted\" \${v} \`tick\`\nEOF"],
  ["heredoc-escaped", ": <<\\EOF\n$(ignored) \${v} \`tick\`\nEOF"],
  ["heredoc-dash", ": <<-EOF\n\tindented\n\tEOF"],
  ["heredoc-delim-command", ": <<'D$(q)'\nbody\nD$(q)"],
  ["heredoc-delim-quote", ": <<'D\"q'\nbody\nD\"q"],
  ["heredoc-delim-escape", ": <<'D\\\\q'\nbody\nD\\\\q"],
  ["heredoc-delim-param", ": <<'D\${q}'\nbody\nD\${q}"],
  ["heredoc-delim-backtick", ": <<'D\`q\`'\nbody\nD\`q\`"],
  ["heredoc-continuation", ": <<EO\\\nF\nbody\nEOF"],
  ["heredoc-close-same", ": <<EOF\nbody\nEOF)"],
  ["heredoc-close-next", ": <<EOF\nbody\nEOF\n)"],
  ["heredoc-missing", ": <<EOF\nbody"],
  ["heredoc-multiple", ": <<A <<'B'\none\nA\ntwo\nB"],
];

const caseBodies = [
  ["case-valid", "case x in x) :;; esac"],
  ["case-pattern", "case x in x|y) :;; (z) :;; esac"],
  ["case-paren-close", "case x in x) :;;)"],
  ["case-missing-esac", "case x in x) :;;"],
  ["case-early-esac", "case x in esac"],
];

const closedBodies = [
  ["closed-list", ":; printf closed"],
  ["closed-subshell", "( : )"],
  ["closed-word-error", ": ) word"],
  ["closed-stray-close", ": )"],
  ["closed-fi", "fi"],
  ["closed-valid-function", "f() { :; }; f"],
];

const unterminatedTokens = [
  ["unterminated-redirect-less", ": <"],
  ["unterminated-redirect-more", ": >"],
  ["unterminated-redirect-heredoc", ": <<"],
  ["unterminated-redirect-append", ": >>"],
  ["unterminated-redirect-input", ": <&"],
  ["unterminated-redirect-both", ": &>"],
  ["unterminated-keyword-case", "case"],
  ["unterminated-keyword-for", "for"],
  ["unterminated-keyword-select", "select"],
  ["unterminated-keyword-function", "function"],
  ["unterminated-wait-if", "if"],
  ["unterminated-wait-while", "while"],
  ["unterminated-wait-until", "until"],
  ["unterminated-wait-then", "then"],
  ["unterminated-wait-do", "do"],
  ["unterminated-case-word", "case x"],
  ["unterminated-case-in", "case x in"],
  ["unterminated-pipe", "|"],
  ["unterminated-and", "&&"],
  ["unterminated-or", "||"],
  ["unterminated-semi", ";"],
  ["unterminated-single-quote", "'open"],
  ["unterminated-double-quote", '"open'],
  ["unterminated-continuation", "\\\n"],
  ["unterminated-comment", "# comment"],
  ["unterminated-command", "$(printf x"],
  ["unterminated-arithmetic", "$((0 + 1"],
];

export const boundaryBodies = heredocBodies.concat(caseBodies, closedBodies, unterminatedTokens);

const signalControls = [
  ["default-term", "kill %1", "wait"],
  ["named-term", "kill -s TERM %1", "wait"],
  ["numeric-term", "kill -15 %1", "wait"],
  ["named-int", "kill -s INT %1", "kill"],
  ["numeric-int", "kill -2 %1", "kill"],
  ["invalid-signal", "kill -s INVALID %1", "kill"],
];

// Keep the owned job alive independently of interpreter throughput. The
// million-iteration arithmetic loop is measured separately in plan 004; it
// must not be an incidental prerequisite for this signal semantic control.
const finiteSignalJob = "sleep 1 &";

function signalSource(kill, observation) {
  const value = observation === "kill" ? "kill_status" : "wait_status";
  const print = observation === "kill" ? "kill" : "wait";
  const observed =
    observation === "kill" ? `${kill}; ${value}=$?; wait %1` : `${kill}; wait %1; ${value}=$?`;
  return `${finiteSignalJob} ${observed}; printf '${print}=%s\\n' \"$${value}\"`;
}

const fixedSources = [
  ["fixed-command-valid", "$(printf '%s' ok)"],
  ["fixed-command-nested", "$(printf '%s' $(printf '%s' ok))"],
  ["fixed-process-valid", "<(printf '%s' ok)"],
  ["fixed-process-arithmetic", "<((printf '%s' ok))"],
  ["fixed-backtick-valid", "\`printf '%s' ok\`"],
  ["fixed-heredoc-parse", "$( : <<EOF\nbody\nEOF\n)"],
  ["fixed-heredoc-parse-only", "$(false; : <<EOF\n$(bad)\nEOF\n)"],
  ["fixed-case-parse", "$(case x in (x) :;; esac)"],
  ["fixed-case-missing", "$(case x in (x) :;;)"],
  ["fixed-comment-close", "$(# comment\n:)"],
  ["fixed-open-quote", "$(printf '%s' 'unterminated)"],
  ["fixed-open-nested", "$(printf '%s' $((0 + $(printf x)))"],
  ["fixed-open-arithmetic", "$((0 + $(printf x))"],
  ["fixed-list-error", "$( : ) word)"],
  ["fixed-stray-fi", "$(fi)"],
  ["fixed-redirect", "$( : <<-EOF\n\tbody\n\tEOF\n)"],
];

const fingerprint = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");

export function optionsFor(args) {
  const options = { count: 600, seed: 1, timeoutMs: 2000, replays: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--queue-active") continue;
    if (arg === "--self-control") {
      options.selfControl = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npm run fuzz:shell-substitutions -- [options]\n" +
          "  --count N       Seeded cases (default: 600), plus the fixed boundary matrix\n" +
          "  --seed N        Unsigned 32-bit seed (default: 1; also run seed 42)\n" +
          "  --timeout-ms N  Per-process timeout (default: 2000)\n" +
          "  --shell PATH    Existing native shell-engine; never builds a binary\n" +
          "  --self-control  Compare two fresh Bash processes; cannot record fixtures\n" +
          "  --output PATH   Save JSON diagnostics\n" +
          "  --record PATH   Record Bash 5.3.15 only when MISMATCH is zero\n" +
          "  --replay PATH   Strict recorded replay without Bash (repeatable)\n" +
          "  --help          Show this help\n\n" +
          "The oracle is /usr/bin/bash 5.3.15 invoked with bash -c SCRIPT. Matching uses\n" +
          "stdout bytes and exit status; stderr is diagnostic only. UNSUPPORTED is reserved\n" +
          "for a successful Bash run where the candidate exits 2 with empty stdout and an\n" +
          "explicit unsupported-feature diagnostic. Parse rejections and\n" +
          "status 127 remain MISMATCH. The run queues through the host light queue and\n" +
          "cleans its private scratch directory.",
      );
      process.exit(0);
    }
    const separator = arg.indexOf("=");
    const name = separator < 0 ? arg : arg.slice(0, separator);
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(name + " needs a value");
    if (name === "--count") options.count = Number(value);
    else if (name === "--seed") {
      options.seed = Number(value);
      options.explicitSeed = true;
    } else if (name === "--timeout-ms") options.timeoutMs = Number(value);
    else if (name === "--shell") options.shell = resolve(value);
    else if (name === "--output") options.output = resolve(value);
    else if (name === "--record") options.record = resolve(value);
    else if (name === "--replay") options.replays.push(resolve(value));
    else throw new Error("unknown option " + name);
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

function bodyNode(id, text) {
  return { kind: "body", id, text };
}

function boundaryNode(opener, spacing, closings, body) {
  return { kind: "boundary", opener, spacing, closings, body };
}

function contextNode(context, child) {
  return { kind: "context", context, child };
}

export function spelling(node) {
  if (node.kind === "raw" || node.kind === "body") return node.text;
  if (node.kind === "boundary") {
    const prefix = openerText[node.opener][node.spacing];
    const suffix = node.opener === "backtick" ? "\`" : ")".repeat(node.closings);
    return prefix + spelling(node.body) + suffix;
  }
  if (node.kind === "guard") return "\${present:-" + spelling(node.child) + "}";
  if (node.kind === "context") return spelling(node.child);
  throw new Error("unknown substitution node " + node.kind);
}

function tagsFor(node) {
  if (node.kind === "raw") return ["fixed", node.id ?? "raw"];
  if (node.kind === "body") return ["body-" + node.id];
  if (node.kind === "boundary")
    return [
      "boundary",
      "opener-" + node.opener,
      "spacing-" + node.spacing,
      "closings-" + node.closings,
    ].concat(tagsFor(node.body));
  if (node.kind === "guard") return ["guarded"].concat(tagsFor(node.child));
  if (node.kind === "context") return ["context-" + node.context].concat(tagsFor(node.child));
  return [];
}

function renderContext(context, raw) {
  const setup = "v=present; unset u; present=guard";
  let expression = raw;
  if (context === "double") expression = '"' + raw + '"';
  if (context === "default-set") expression = '"\${v:-' + raw + '}"';
  if (context === "default-unset") expression = '"\${v:-' + raw + '}"';
  if (context === "arithmetic") expression = '"$((0 + ' + raw + '))"';
  if (context === "command") expression = "\"\${present:-$(printf '%s' " + raw + ')}"';
  if (context === "process") expression = "\"\${present:-<(printf '%s' " + raw + ')}"';
  const unset = context === "default-unset" ? "unset v; " : "";
  return (
    setup +
    "; " +
    unset +
    "printf '<%s>\\n' " +
    expression +
    '; status=$?; printf \'status=%s\\n\' "$status"; exit "$status"'
  );
}

function makeCase(id, node, context, tags = []) {
  const raw = spelling(node);
  const caseNode = contextNode(context, node);
  return {
    id,
    context,
    opener: node.kind === "boundary" ? node.opener : "fixed",
    spacing: node.kind === "boundary" ? node.spacing : "fixed",
    closings: node.kind === "boundary" ? node.closings : null,
    tags: Array.from(new Set(tagsFor(caseNode).concat(tags))).sort(),
    node: caseNode,
    script: renderContext(context, raw),
  };
}

export function fixedCases() {
  const sources = fixedSources.concat(
    signalControls.map(([id, kill, observation]) => [
      "fixed-job-signal-" + id,
      signalSource(kill, observation),
    ]),
  );
  return sources.map(([id, text]) => ({
    id,
    context: "fixed",
    opener: "fixed",
    spacing: "fixed",
    closings: null,
    tags: ["fixed", id],
    node: { kind: "raw", id, text },
    script: text + '; status=$?; printf \'status=%s\\n\' "$status"; exit "$status"',
  }));
}

function bodyEntries() {
  return boundaryBodies.map(([id, text]) => bodyNode(id, text));
}

export function boundaryCases(seed) {
  const random = randomFor(seed ^ 0x6173b4c9);
  const bodies = bodyEntries();
  const cases = [];
  for (const [bodyIndex, body] of bodies.entries()) {
    for (const [openerIndex, opener] of boundaryOpeners.entries()) {
      for (const [contextIndex, context] of boundaryContexts.entries()) {
        const spacing =
          boundarySpellings[(bodyIndex + openerIndex + contextIndex + random.next()) % 2];
        const closings = boundaryClosings[(bodyIndex + openerIndex + contextIndex) % 3];
        const node = boundaryNode(opener, spacing, closings, body);
        const id =
          "boundary-" + body.id + "-" + opener + "-" + spacing + "-" + closings + "-" + context;
        cases.push(makeCase(id, node, context));
      }
    }
  }
  const variants = new Set([
    "heredoc-close-next",
    "case-valid",
    "closed-list",
    "closed-valid-function",
  ]);
  for (const body of bodies.filter((entry) => variants.has(entry.id)))
    for (const opener of boundaryOpeners)
      for (const context of boundaryContexts)
        for (const closings of boundaryClosings.filter((value) => value !== 2)) {
          const spacing = boundarySpellings[(closings + body.id.length) % 2];
          const node = boundaryNode(opener, spacing, closings, body);
          cases.push(
            makeCase(
              "boundary-extra-" +
                body.id +
                "-" +
                opener +
                "-" +
                spacing +
                "-" +
                closings +
                "-" +
                context,
              node,
              context,
            ),
          );
        }
  return cases;
}

function generatedNode(random) {
  const [id, text] = random.pick(boundaryBodies);
  return boundaryNode(
    random.pick(boundaryOpeners),
    random.pick(boundarySpellings),
    random.pick(boundaryClosings),
    bodyNode(id, text),
  );
}

export function generateCases(seed, count) {
  const random = randomFor(seed);
  const cases = fixedCases();
  for (let index = 0; index < count; index++) {
    const node = generatedNode(random);
    const context = random.pick(boundaryContexts);
    cases.push(makeCase("generated-" + index, node, context, ["generated"]));
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

export function classify(bash, candidate, selfControl = false) {
  if (matches(bash, candidate)) return "MATCH";
  if (
    !selfControl &&
    bash.status === 0 &&
    candidate.status === 2 &&
    candidate.stdout.length === 0 &&
    /^(?:shell-engine: )?(?:unsupported (?:feature|syntax|command substitution|process substitution)\b|(?:command|process) substitution (?:is )?not supported\b)/im.test(
      candidate.stderr.toString(),
    ) &&
    bash.signal === null &&
    candidate.signal === null &&
    !bash.timedOut &&
    !candidate.timedOut &&
    !bash.error &&
    !candidate.error
  )
    return "UNSUPPORTED";
  return "MISMATCH";
}

function run(bin, script, options) {
  const result = spawnSync(bin, ["-c", script], {
    cwd: options.cwd,
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

export function coverage(cases) {
  return {
    contexts: Array.from(new Set(cases.map((item) => item.context))).sort(),
    openers: Array.from(new Set(cases.map((item) => item.opener))).sort(),
    spellings: Array.from(new Set(cases.map((item) => item.spacing))).sort(),
    closings: Array.from(
      new Set(cases.flatMap((item) => (item.closings === null ? [] : [item.closings]))),
    ).sort((a, b) => a - b),
    bodies: Array.from(
      new Set(cases.flatMap((item) => item.tags.filter((tag) => tag.startsWith("body-")))),
    ).sort(),
    tags: Array.from(new Set(cases.flatMap((item) => item.tags))).sort(),
  };
}

export function validateFixture(path, fixture, options) {
  if (fixture.schema !== 1 || fixture.sourceHash !== fingerprint())
    throw new Error("stale substitution fixture hash/schema");
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
      throw new Error("fixture case differs at " + index);
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
      throw new Error("invalid fixture process result at " + index);
    for (const key of ["stdoutBase64", "stderrBase64"])
      if (
        typeof result[key] !== "string" ||
        Buffer.from(result[key], "base64").toString("base64") !== result[key] ||
        Buffer.from(result[key], "base64").length > outputLimit
      )
        throw new Error("invalid fixture bytes at " + index);
  }
  return cases;
}

function mismatchSignature(bash, candidate, classification) {
  return JSON.stringify([
    classification,
    bash.status,
    candidate.status,
    bash.signal,
    candidate.signal,
    bash.timedOut,
    candidate.timedOut,
    bash.error,
    candidate.error,
    bash.stdout.toString("base64"),
    candidate.stdout.toString("base64"),
  ]);
}

export function reductions(node) {
  if (node.kind === "raw") return node.text ? [{ ...node, text: "" }] : [];
  if (node.kind === "body") {
    const candidates = [];
    if (node.text !== ":") candidates.push({ ...node, text: ":" });
    const firstLine = node.text.split("\n", 1)[0];
    if (firstLine && firstLine !== node.text) candidates.push({ ...node, text: firstLine });
    return candidates;
  }
  if (node.kind === "boundary") {
    const candidates = [];
    if (node.closings > 1) candidates.push({ ...node, closings: 1 });
    if (node.spacing === "spaced" && node.opener !== "backtick")
      candidates.push({ ...node, spacing: "fused" });
    for (const body of reductions(node.body)) candidates.push({ ...node, body });
    return candidates;
  }
  if (node.kind === "context") return reductions(node.child).map((child) => ({ ...node, child }));
  if (node.kind === "guard") return reductions(node.child).map((child) => ({ ...node, child }));
  return [];
}

function shrink(test, original, options, bashBin, shell, selfControl) {
  const originalClass = classify(original.bash, original.candidate, selfControl);
  const signature = mismatchSignature(original.bash, original.candidate, originalClass);
  let best = { test, ...original };
  let attempts = 0;
  for (;;) {
    let improved = false;
    for (const node of reductions(best.test.node)) {
      if (spelling(node).length >= spelling(best.test.node).length) continue;
      if (++attempts > 32) return { ...best, attempts: attempts - 1 };
      const reduced = node.kind === "context" ? node.child : node;
      const candidate = makeCase(test.id, reduced, test.context);
      const bash = run(bashBin, candidate.script, options);
      const ours = run(shell, candidate.script, options);
      const classification = classify(bash, ours, selfControl);
      if (
        classification !== "MATCH" &&
        mismatchSignature(bash, ours, classification) === signature
      ) {
        best = { test: candidate, bash, candidate: ours };
        improved = true;
        break;
      }
    }
    if (!improved) return { ...best, attempts };
  }
}

function shapeFrom(test, bash, candidate) {
  return {
    script: test.script,
    bash: { status: bash.status, stdoutBase64: bash.stdout.toString("base64") },
    candidate: { status: candidate.status, stdoutBase64: candidate.stdout.toString("base64") },
    tags: test.tags,
  };
}

function execute(cases, options, shell, bashBin, oracle) {
  const counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
  const byContext = {};
  const byOpener = {};
  const mismatchRecords = [];
  const results = [];
  for (const [index, test] of cases.entries()) {
    const bash = oracle ? decode(oracle[index]) : run(bashBin, test.script, options);
    const candidate = run(shell, test.script, options);
    const classification = classify(bash, candidate, options.selfControl);
    counts[classification]++;
    const contextCounts = (byContext[test.context] ??= {
      MATCH: 0,
      UNSUPPORTED: 0,
      MISMATCH: 0,
    });
    contextCounts[classification]++;
    const openerCounts = (byOpener[test.opener] ??= {
      MATCH: 0,
      UNSUPPORTED: 0,
      MISMATCH: 0,
    });
    openerCounts[classification]++;
    if (classification === "MISMATCH") {
      const original = { test, bash, candidate };
      const minimized = oracle
        ? null
        : shrink(test, original, options, bashBin, shell, options.selfControl);
      const selected = minimized ?? original;
      mismatchRecords.push({
        ...shapeFrom(selected.test, selected.bash, selected.candidate),
        attempts: minimized?.attempts ?? 0,
      });
    }
    if (options.record) results.push({ case: test, bash: encode(bash) });
  }
  const deduped = [];
  const seen = new Set();
  for (const shape of mismatchRecords) {
    const key = JSON.stringify([shape.script, shape.bash, shape.candidate]);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(shape);
    }
  }
  return {
    total: cases.length,
    counts,
    coverage: coverage(cases),
    byContext,
    byOpener,
    mismatches: deduped,
    results,
  };
}

function ensureQueued() {
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const child = spawnSync(
    "bash",
    [queue, "--class", "light", "brush-web-subst-fuzz", "--", process.execPath, sourcePath].concat(
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
  const bashBin = "/usr/bin/bash";
  const shell = options.selfControl
    ? bashBin
    : (options.shell ??
      process.env.FUZZ_SHELL_BIN ??
      resolve(root, ".build/shell/release/shell-engine"));
  if (!existsSync(shell))
    throw new Error("Pass an existing native --shell PATH; no automatic builds: " + shell);
  if (options.record && realpathSync(shell) === realpathSync(bashBin))
    throw new Error("cannot record against Bash itself");
  const parent = process.env.FUZZ_SUBST_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "brush-web-subst-run-"));
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
      reports = options.replays.map((path) => {
        const fixture = JSON.parse(readFileSync(path, "utf8"));
        const cases = validateFixture(path, fixture, options);
        return {
          path,
          seed: fixture.seed,
          ...execute(
            cases,
            options,
            shell,
            null,
            fixture.cases.map((entry) => entry.bash),
          ),
        };
      });
    } else {
      const bash = execFileSync(bashBin, ["--version"], { encoding: "utf8" }).split("\n", 1)[0];
      if (!oracleVersion.test(bash)) throw new Error("Bash 5.3.15 required, got " + bash);
      const cases = generateCases(options.seed, options.count);
      const result = execute(cases, options, shell, bashBin);
      reports = [{ seed: options.seed, bash, ...result }];
      if (options.record) {
        if (result.counts.MISMATCH !== 0)
          throw new Error(
            "Refusing to record " + result.counts.MISMATCH + " substitution mismatches",
          );
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
    const mismatchShapes = reports.flatMap((report) => report.mismatches);
    // Minimized shapes go beside the run's scratch directory (or where
    // FUZZ_SUBST_MISMATCHES points), never into the repository.
    const mismatchOutputPath =
      process.env.FUZZ_SUBST_MISMATCHES ?? resolve(parent, "brush-web-subst-mismatches.json");
    mkdirSync(dirname(mismatchOutputPath), { recursive: true });
    writeFileSync(mismatchOutputPath, JSON.stringify(mismatchShapes, null, 2) + "\n");
    const report = {
      schema: 1,
      mode: options.replays.length ? "replay" : options.selfControl ? "bash-self-control" : "live",
      sourceHash: fingerprint(),
      originalGenerated: options.count,
      fixed: fixedCases().length,
      boundaryGenerated: boundaryCases(options.seed).length,
      timeoutMs: options.timeoutMs,
      shell,
      mismatchOutput: mismatchOutputPath,
      reports: reports.map(({ results, ...item }) => item),
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) {
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, text);
    }
    process.stdout.write(text);
    if (reports.some((item) => item.counts.MISMATCH)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
