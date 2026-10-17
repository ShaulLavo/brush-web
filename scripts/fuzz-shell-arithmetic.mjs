#!/usr/bin/env node
// Differential arithmetic and scalar-slice checks. Recorded Bash observations
// are replayed in CI without relying on the runner's installed Bash version.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const queue = "/work/tmp/wave-heavy/run.sh";
const contexts = ["expansion", "command", "let", "substring"];
const binary = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<<",
  ">>",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "&",
  "^",
  "|",
  "&&",
  "||",
  ",",
];
const assignments = ["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="];
const numbers = [
  "0",
  "1",
  "2",
  "3",
  "7",
  "63",
  "64",
  "0xff",
  "077",
  "2#101",
  "16#ff",
  "36#Z",
  "64#_",
  "64#@",
  "9223372036854775807",
  "9223372036854775808",
  "18446744073709551615",
  "18446744073709551616",
];
const values = ["", "abcdef", "a b:c", "héllo", "日本語", "a\tb\nc", "don't", "${x}"];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const fingerprint = () => createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");

function optionsFor(args) {
  const options = { count: 3000, seed: 7, timeout: 2000, replays: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--queue-active") continue;
    if (arg === "--help") {
      console.log(
        "Usage: npm run fuzz:shell-arithmetic -- [--count 3000] [--seed 7] [--shell PATH] [--record PATH] [--replay PATH ...] [--output PATH]",
      );
      process.exit(0);
    }
    const [name, inline] = arg.split("=", 2);
    const value = inline ?? args[++index];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--count") options.count = Number(value);
    else if (name === "--seed") options.seed = Number(value) >>> 0;
    else if (name === "--timeout-ms") options.timeout = Number(value);
    else if (name === "--shell") options.shell = resolve(value);
    else if (name === "--output") options.output = resolve(value);
    else if (name === "--record") options.record = resolve(value);
    else if (name === "--replay") options.replays.push(resolve(value));
    else throw new Error(`unknown option ${name}`);
  }
  if (!Number.isSafeInteger(options.count) || options.count < 0) throw new Error("invalid count");
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1)
    throw new Error("invalid timeout");
  if (options.record && options.replays.length) throw new Error("record and replay are exclusive");
  return options;
}

function randomFor(seed) {
  let state = seed >>> 0 || 1;
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

function expression(random, depth) {
  if (depth === 0) return random.pick(numbers.concat(["x", "y", "z", "missing"]));
  const kind = random.next() % 8;
  if (kind === 0) return random.pick(["+", "-", "!", "~"]) + `(${expression(random, depth - 1)})`;
  if (kind === 1) return random.pick(["++x", "y++", "--y", "x--"]);
  if (kind === 2)
    return `(${random.pick(["x", "y", "z"])}${random.pick(assignments)}(${expression(random, depth - 1)}))`;
  if (kind === 3)
    return `(${expression(random, depth - 1)})?(${expression(random, depth - 1)}):(${expression(random, depth - 1)})`;
  const op = random.pick(binary);
  // Keep exponentiation bounded by construction, without hiding negative-exponent
  // behavior: fixed regressions below cover that arithmetic error explicitly.
  const right = op === "**" ? String(random.next() % 8) : expression(random, depth - 1);
  return `(${expression(random, depth - 1)})${op}(${right})`;
}

const after = "printf '<%s>\\n' status=$? x=$x y=$y z=$z following";
function wrapped(
  context,
  expr,
  setup = "x=7; y=3; z=0; unset missing",
  value = "abcdef",
  length = "3",
  quoted = true,
) {
  if (context === "expansion") return `${setup}; printf '<%s>\\n' "$(( ${expr} ))"; ${after}`;
  if (context === "command") return `${setup}; (( ${expr} )); ${after}`;
  if (context === "let") return `${setup}; let ${quote(expr)}; ${after}`;
  const slice = length === null ? `\${v:(${expr})}` : `\${v:(${expr}):(${length})}`;
  return `${setup}; v=${quote(value)}; printf '<%s>\\n' ${quoted ? `"${slice}"` : slice} following; ${after}`;
}

function fixedCases() {
  const cases = [];
  const add = (id, context, expr, setup) =>
    cases.push({ id, context, script: wrapped(context, expr, setup) });
  const expressions = [
    "1+2*3",
    "2**3**2",
    "-2**2",
    "1<<2+1",
    "1|2&4",
    "1||0&&0",
    "x=y=9",
    "x+=y*=2",
    "x++ + x",
    "++x + x++",
    "x=(x=9)+1",
    "x+=x=4",
    "x*=x=4",
    "x<<=x=2",
    "x++**2",
    "++x**2",
    "1?x=2:y=3",
    "0?x=2:y=3",
    "1?2:0?3:4",
    "0?2:1?3:4",
    "1?2,3:4",
    "0?2:3,4",
    "1==2<3",
    "1&2==2",
    "1^3|4",
    "2**3*4+1",
    "0 && (x=99)",
    "1 || (x=99)",
    "1 ? x++ : y++",
    "0 ? x++ : y++",
    "0 && 1/0",
    "1 || 1/0",
    "1 ? 3 : 1/0",
    "0 ? 1/0 : 3",
    "x=4, y=x+2, y",
    "-9223372036854775808/-1",
    "-9223372036854775808%-1",
    "2**63",
    "1<<-1",
    "-8>>65",
    "64#_",
    "64#@",
    "08",
    "0x",
    "2#2",
    "1#0",
    "65#1",
    "10#",
    "1A#1",
    "1_#1",
    "é",
    "x.y",
    "1/0",
    "1%0",
    "2**-1",
    "(1+)",
    "1=2",
    "++1",
    "x+",
    "1 2",
    "0 && 09",
    "1 || 09",
    "1 ? 2 : 09",
    "",
    "()",
    "x=5,1/0",
  ];
  for (const context of contexts.slice(0, 3)) {
    for (const [index, expr] of expressions.entries())
      add(`fixed-${context}-${index}`, context, expr);
    for (const [index, setup] of [
      "x='y+2'; y=3; z=0",
      "x='y++'; y=3; z=0",
      "x=x; y=3; z=0",
      "x=y; y=x; z=0",
      "x='(x=1)+x'; y=3; z=0",
      "x='(y-=1)>0?x:1'; y=3; z=0",
    ].entries())
      add(`recursive-${context}-${index}`, context, "x+x", setup);
  }
  for (const [index, expr] of [
    "$x+1",
    "${x}+1",
    "${missing:-2}+1",
    "$((x+1))+2",
    '"$x"+1',
    "x\\\n+1",
    "x=2,$x",
    "x=2,${x}",
    "x=2,$((x+1))",
    "0 && ${missing:=4}",
    "$(echo 2)+1",
    "`echo 2`+1",
    "$(printf '%s' \"$x\")*2",
    "x=$(echo 4),x",
    "$(exit 3)1",
    "0 && $(echo 5)",
    "$(echo 1 +) 2",
    "$(x=9; echo $x)+x",
    "$((0 + $(echo 3)))",
  ].entries()) {
    for (const context of ["expansion", "command"])
      add(`textual-${context}-${index}`, context, expr);
  }
  for (const [index, entry] of [
    ["0", "-1", "abc"],
    ["1", "-1", "abc"],
    ["2", "-2", "abc"],
    ["99", "1/0", "abc"],
    [" -99", "-99", "abc"],
    [" -2", "2", "héllo"],
    ["1+1", "1+1", "日本語"],
    ["(x=1)", "(y=2)", "abc"],
    ["(x=99)", "(y=99)", "abc"],
    ["0", "-1", ""],
    ["1/0", "1", ""],
    ["0", "08", "abc"],
    ["0", null, "abc"],
    [" -1", null, "héllo"],
    ["1/0", null, "abc"],
    ["(x=1)", null, "日本語"],
  ].entries()) {
    for (const quoted of [false, true])
      cases.push({
        id: `slice-${index}-${quoted}`,
        context: "substring",
        script: wrapped("substring", entry[0], undefined, entry[2], entry[1], quoted),
      });
  }
  for (const [index, script] of [
    'unset v x y; printf \'<%s>\\n\' "${v:++x:1/0}" "${x-unset}" following',
    'v=abc; x=1; printf \'<%s>\\n\' "${v:99:(x=8)}" "$x" following',
    "v=abc; printf '<%s>\\n' \"${v:}\" following; echo after",
    "v=abc; printf '<%s>\\n' \"${#v:1:2}\" following; echo after",
    "v=abc; printf '<%s>\\n' \"${v:0:-99}\" following; echo after",
    "unset u; v=abc; printf '<%s>\\n' \"${u:-${v:1+1:1}}\" following",
    "unset u; printf '<%s>\\n' \"${u:-$((1+2*3))}\" following",
    "let 'x=1' 'x+=2'; printf '<%s>\\n' status=$? x=$x",
    "let; printf '<%s>\\n' status=$? following",
    'v=abcdef; printf \'<%s>\\n\' "${v:(v=3):1}" "$v" following',
    'v=abcdef; printf \'<%s>\\n\' "${v:1:(v=2)}" "$v" following',
    'x=1; printf \'<%s>\\n\' "$((x=2,$x))" "$x" following',
    'x=1; printf \'<%s>\\n\' "$((x=2,${x}))" "$x" following',
    'x=1; printf \'<%s>\\n\' "$((x=2,$((x+1))))" "$x" following',
    'unset x; printf \'<%s>\\n\' "$((0 && ${x:=4}))" "$x" following',
    "x=1; let 'x=2,$x'; printf '<%s>\\n' status=$? x=$x following",
    "IFS=1; printf '<%s>\\n' $((11)) following",
    "IFS=-; printf '<%s>\\n' $((-2)) following",
    "IFS=,; v=a1b; printf '<%s>\\n' pre$v$((IFS=1))",
    "IFS=,; v=a1b; s=xyz; printf '<%s>\\n' pre$v${s:(IFS=1):1}",
    "v=abc; (( ${v:1/0} )); echo after",
    "v=abc; (( ${v:0:1/0} )); echo after",
    "v=abc; (( ${v:0:-99} )); echo after",
    "unset u; x=1; printf '%s\\n' \"${u:-$((1 + ${x:-')'}))}\"",
    "unset u; x=1; printf '%s\\n' \"${u:-$((1 + ${x:-'('}))}\"",
    "unset unused; f() { printf '%s\\n' \"${unused:-${1:1:1}}\"; }; f abc",
    "unset unused; f() { printf '%s\\n' \"${unused:-${#:0:1}}\"; }; f abc def",
    "unset unused; false; printf '%s\\n' \"${unused:-${?:0:1}}\"",
  ].entries())
    cases.push({ id: `boundary-${index}`, context: "boundary", script });
  for (const [index, setup] of ["u=2", "unset u"].entries()) {
    cases.push({
      id: `quoted-unused-boundary-${index}`,
      context: "boundary",
      script: `v=abcdef; ${setup}; printf '<%s>\\n' "\${v:0:\${u:-'<(bad'}}"; echo after`,
    });
  }
  for (const [index, command] of [
    'printf "%s\\n" "$((1/0))"',
    "result=$((1/0))",
    'printf "%s\\n" "$((echo unexpected [))"',
    'v=abc; printf "%s\\n" "${v:1/0}"',
    'v=abcdef; printf "%s\\n" "${v:1>>(+(2))}"',
    'present=ok; printf "%s\\n" "${present:-${v:1>>(+(2))}}"',
    '{ printf "%s\\n" "$((1/0))"; echo inner; }',
    'f() { printf "%s\\n" "$((1/0))"; echo inner; }; f',
    'printf "%s\\n" "$((1/0))" && echo inner',
    'printf "%s\\n" "$((1/0))" || echo inner',
  ].entries()) {
    for (const separator of [";", "\n"]) {
      cases.push({
        id: `read-unit-${index}-${separator === ";" ? "same" : "next"}`,
        context: "boundary",
        script: `${command}; echo skipped${separator}printf '<%s>\\n' after=$?`,
      });
    }
  }
  for (const offset of ["0", "1", "2", "4", "5", " -1", " -4", " -5", "x++", "1/0"]) {
    for (const length of [null, "0", "2", "-1", "1/0"]) {
      positionalSliceCases(cases, offset, length);
    }
  }
  return cases;
}

function positionalSliceCases(cases, offset, length) {
  for (const quoted of [true, false]) {
    const token = `\${@:${offset}${length === null ? "" : `:${length}`}}`;
    cases.push({
      id: `positional-slice-${offset}-${length}-${quoted}`,
      context: "substring",
      script: `x=1; f() { printf '<%s>\\n' ${quoted ? `"${token}"` : token} tail; echo x=$x; }; f 'a b' '' c`,
    });
  }
}

// A separate stream exercises shell grammar boundaries without depending on
// the arithmetic expression generator's variable names or parenthesis shape.
function boundaryCases(seed, count = 256) {
  const random = randomFor(seed ^ 0xa7614b2d);
  const cases = [];
  for (let index = 0; index < count; index++) {
    const name = random.pick(["alpha", "_item", "counter42", "result"]);
    const other = random.pick(["beta", "_rhs", "n17"]);
    const n = String(1 + (random.next() % 5));
    const m = String(1 + (random.next() % 5));
    const space = random.pick(["", " ", "  ", "\t"]);
    const grammar = random.pick([
      n,
      `(${n})`,
      `((${n}))`,
      `+(${n})`,
      `-(${n})`,
      `~(${n})`,
      `!(${n})`,
      `(${name}+=(${other}))`,
      `(${name}=(${other}))`,
      `(${name}|=(${n}))`,
      `(${name}^=(${n}))`,
      `(${name}&=(${n}))`,
      `(${n})+(${m})`,
      `(${n})**(${m})`,
      `(${n})>>(${m})`,
      `(${n})&&(${m})`,
      `(${name})?(${n}):(${m})`,
      `"${n}"`,
      `'${n}'`,
      `(${space}${name}+=(${other})${space})`,
    ]);
    const body = random.next() % 2 ? grammar : space + grammar;
    const op = random.pick(["<", ">", "<<", ">>"]);
    const expr = `(${n})${space}${op}${space}(${body})`;
    const field = random.next() % 2 === 0;
    const slice = field ? `\${${name}:(${expr}):1}` : `\${${name}:0:(${expr})}`;
    const value = random.pick(values);
    const setup = `${random.next() % 5 ? `${name}=${quote(value)}` : `unset ${name}`}; ${other}=${m}`;
    const operand = random.next() % 2 ? `"${slice}"` : slice;
    const context = random.pick([
      "word",
      "assignment",
      "arithmetic",
      "arithmetic-expansion",
      "default",
      "unused-default",
      "inactive",
      "function",
      "unused-function",
      "earlier-line",
    ]);
    let script;
    if (context === "earlier-line")
      script = `${setup}; printf '<%s>\\n' before\n printf '<%s>\\n' ${operand}; echo after`;
    if (context === "assignment")
      script = `${setup}; saved=${operand}; printf '<%s>\\n' "$saved"; echo after`;
    if (context === "arithmetic-expansion")
      script = `${setup}; printf '<%s>\\n' "$(( ${slice} ))"; echo after`;
    if (context === "unused-default")
      script = `${setup}; present=ok; printf '<%s>\\n' "\${present:-${slice}}"; echo after`;
    if (context === "inactive")
      script = `${setup}; false && printf '<%s>\\n' ${operand}; echo after`;
    if (context === "unused-function")
      script = `${setup}; f() { printf '<%s>\\n' ${operand}; }; echo after`;
    if (context === "arithmetic")
      script = `${setup}; (( ${slice} )); printf '<%s>\\n' status=$?; echo after`;
    if (context === "default")
      script = `${setup}; unset absent; printf '<%s>\\n' "\${absent:-${slice}}"; echo after`;
    if (context === "function")
      script = `${setup}; f() { printf '<%s>\\n' ${operand}; }; f; echo after`;
    if (context === "word") script = `${setup}; printf '<%s>\\n' ${operand}; echo after`;
    cases.push({ id: `grammar-${index}`, context: `boundary-${context}`, script });
  }
  return cases;
}

function generate(seed, count) {
  const random = randomFor(seed);
  const cases = fixedCases();
  for (let index = 0; index < count; index++) {
    const context = contexts[index % contexts.length];
    const expr = expression(random, 1 + (random.next() % 3));
    const length = random.pick(["0", "1", "3", "-1", "-9", "y", "x++", "1/0", null]);
    cases.push({
      id: `generated-${index}`,
      context,
      script: wrapped(
        context,
        expr,
        undefined,
        random.pick(values),
        length,
        random.next() % 2 === 0,
      ),
    });
  }
  return cases.concat(boundaryCases(seed));
}

function run(bin, args, timeout) {
  const env = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "BASH_COMPAT", "POSIXLY_CORRECT"])
    delete env[name];
  const result = spawnSync(bin, args, { env, encoding: null, timeout, maxBuffer: 4 * 1024 * 1024 });
  return {
    status: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? result.error?.message ?? ""),
  };
}
const encode = (result) => ({
  status: result.status,
  signal: result.signal,
  timedOut: result.timedOut,
  stdoutBase64: result.stdout.toString("base64"),
  stderrBase64: result.stderr.toString("base64"),
});
const decode = (result) => ({
  ...result,
  stdout: Buffer.from(result.stdoutBase64, "base64"),
  stderr: Buffer.from(result.stderrBase64, "base64"),
});
const equal = (a, b) =>
  !a.timedOut &&
  !b.timedOut &&
  Number.isInteger(a.status) &&
  a.status === b.status &&
  a.signal === null &&
  b.signal === null &&
  a.stdout.equals(b.stdout);

function replay(path, options, shell) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (fixture.schema !== 1 || fixture.sourceHash !== fingerprint())
    throw new Error("stale arithmetic fixture");
  if (fixture.count !== options.count) throw new Error("fixture count differs");
  if (
    fixture.timeoutMs !== options.timeout ||
    !fixture.bash?.startsWith("GNU bash, version 5.3.15")
  )
    throw new Error("fixture oracle/timeout differs");
  const filenameSeed = /seed-(\d+)\.json$/.exec(path);
  if (filenameSeed && Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed differs");
  const cases = generate(fixture.seed, fixture.count);
  if (fixture.cases.length !== cases.length) throw new Error("fixture length differs");
  for (const [index, test] of cases.entries()) {
    if (JSON.stringify(test) !== JSON.stringify(fixture.cases[index].case))
      throw new Error(`fixture case differs at ${index}`);
  }
  return execute(
    cases,
    options,
    shell,
    fixture.cases.map((entry) => decode(entry.bash)),
  );
}

function execute(cases, options, shell, oracle) {
  const results = [];
  const mismatches = [];
  let mismatchCount = 0;
  const byContext = {};
  for (const [index, test] of cases.entries()) {
    const bash =
      oracle?.[index] ??
      run(
        process.env.BASH_BIN ?? "bash",
        ["--noprofile", "--norc", "-c", `set -f\n${test.script}`],
        options.timeout,
      );
    const ours = run(shell, ["-c", test.script], options.timeout);
    const matched = equal(bash, ours);
    const counts = (byContext[test.context] ??= { MATCH: 0, MISMATCH: 0 });
    counts[matched ? "MATCH" : "MISMATCH"]++;
    if (!matched) {
      mismatchCount++;
      if (mismatches.length < 40)
        mismatches.push({ ...test, bash: encode(bash), ours: encode(ours) });
    }
    if (options.record) results.push({ case: test, bash: encode(bash) });
  }
  return {
    total: cases.length,
    counts: { MATCH: cases.length - mismatchCount, UNSUPPORTED: 0, MISMATCH: mismatchCount },
    byContext,
    mismatches,
    results,
  };
}

function main() {
  const options = optionsFor(process.argv.slice(2));
  if (!process.argv.includes("--queue-active") && existsSync(queue)) {
    const child = spawnSync(
      "bash",
      [
        queue,
        "--class",
        "light",
        "brush-web-arithmetic-fuzz",
        "--",
        process.execPath,
        process.argv[1],
      ].concat(process.argv.slice(2), ["--queue-active"]),
      { cwd: root, stdio: "inherit", env: process.env },
    );
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const shell =
    options.shell ??
    process.env.FUZZ_SHELL_BIN ??
    resolve(root, ".build/shell/release/shell-engine");
  if (!existsSync(shell))
    throw new Error(`Build a native shell-engine first, or pass --shell PATH: ${shell}`);
  let reports;
  if (options.replays.length)
    reports = options.replays.map((path) => ({ path, ...replay(path, options, shell) }));
  else {
    const bash = execFileSync(process.env.BASH_BIN ?? "bash", ["--version"], {
      encoding: "utf8",
    }).split("\n", 1)[0];
    if (!bash.startsWith("GNU bash, version 5.3.15"))
      throw new Error(`Bash 5.3.15 required, got ${bash}`);
    const result = execute(generate(options.seed, options.count), options, shell);
    reports = [{ seed: options.seed, bash, ...result }];
    if (options.record) {
      if (result.counts.MISMATCH)
        throw new Error(`cannot record ${result.counts.MISMATCH} arithmetic mismatches`);
      mkdirSync(dirname(options.record), { recursive: true });
      writeFileSync(
        options.record,
        JSON.stringify(
          {
            schema: 1,
            sourceHash: fingerprint(),
            seed: options.seed,
            count: options.count,
            timeoutMs: options.timeout,
            bash,
            cases: result.results,
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
  const text =
    JSON.stringify(
      reports.map(({ results, ...report }) => report),
      null,
      2,
    ) + "\n";
  if (options.output) writeFileSync(options.output, text);
  process.stdout.write(text);
  if (reports.some((report) => report.counts.MISMATCH)) process.exitCode = 1;
}
main();
