#!/usr/bin/env node
// Differential readonly declaration and scalar mutation checks. Bash observations
// are recorded once and replayed in CI without relying on the runner's Bash.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const queue = "/work/tmp/wave-heavy/run.sh";

function optionsFor(args) {
  const options = { count: 256, seed: 17, timeout: 2000, replays: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--queue-active") continue;
    if (arg === "--help") {
      console.log(
        "Usage: npm run fuzz:shell-readonly -- [--count 256] [--seed 17] [--shell PATH] [--record PATH] [--replay PATH ...] [--output PATH]",
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

const fingerprint = () => createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const values = ["", "1", "2", "7"];
const names = ["x", "counter42", "_item", "result"];

function fixedCases() {
  const scripts = [
    "f() { readonly y; local x=1 y=$(( x )); echo y=$y; }; f; echo y=$y",
    "readonly x=1; ((x=2)); printf '<%s>\\n' status=$? x=$x",
    "readonly x; x=2; printf '<%s>\\n' status=$? x=$x",
    "f() { local x=1; readonly x; ((x=2)); printf '<%s>\\n' status=$? x=$x; }; f; printf '<%s>\\n' x=$x",
    "f() { local x=1; readonly x; g() { local x=2; ((x=3)); printf '<%s>\\n' status=$? x=$x; }; g; printf '<%s>\\n' x=$x; }; f",
    "readonly x=1; export x; printf '<%s>\\n' x=$x",
    "readonly x=1; ((x+=2)); printf '<%s>\\n' status=$? x=$x",
    "f() { readonly y; local x=3 y=$((x+2)); printf '<%s>\\n' status=$? y=$y; }; f",
    'readonly x=1; echo "$((x=2))"; echo skipped\nprintf "%s\\n" after=$? x=$x',
    'readonly x=1; x=2; echo skipped\nprintf "%s\\n" after=$? x=$x',
    'readonly x; echo "${x:=2}"; echo skipped\nprintf "%s\\n" after=$? "${x-unset}"',
  ];
  return scripts.map((script, index) => ({ id: `fixed-${index}`, script }));
}

function generatedCase(random, index) {
  const name = random.pick(names);
  const value = random.pick(values);
  const expression = `${1 + (random.next() % 8)}+${random.next() % 5}`;
  const observe = `printf '<%s>\\n' "status=$?" "value=$${name}" "set=\${${name}+yes}"`;
  const kind = index % 6;
  if (kind === 0) {
    return `f() { readonly ${name}=${quote(value)}; local before=1 ${name}=$(( ${expression} )) after=2; ${observe}; printf '<%s>\\n' "$before" "$after"; }; f; ${observe}`;
  }
  if (kind === 1) {
    return `f() { local ${name}=${quote(value)}; readonly ${name}; (( ${name}=${expression} )); ${observe}; }; f; ${observe}`;
  }
  if (kind === 2) {
    const mutation = random.pick([
      `${name}=${expression}`,
      `${name}+=2`,
      `${name}++`,
      `++${name}`,
      `0&&(${name}=2)`,
      `1||(${name}=2)`,
      `${name}=(saved=3)`,
    ]);
    const command = random.pick([
      `(( ${mutation} ))`,
      `let ${quote(mutation)}`,
      `printf '<%s>\\n' "$(( ${mutation} ))"`,
      `v=abcdef; printf '<%s>\\n' "\${v:(${mutation}):1}"`,
    ]);
    return `readonly ${name}=${quote(value)}; ${command}; ${observe}; printf '<%s>\\n' "$saved"`;
  }
  if (kind === 3) {
    return `f() { local ${name}=1; readonly ${name}; g() { local ${name}=2; (( ${name}=${expression} )); ${observe}; }; g; (( ${name}=4 )); ${observe}; }; f; ${name}=5; ${observe}`;
  }
  if (kind === 4) {
    return `readonly ${name}; printf '<%s>\\n' "\${${name}:=\${saved:=kept}}"; ${observe}`;
  }
  return `text='a b'; readonly ${name}=$text; readonly ${name}=changed other=$text; ${observe}; export ${name}=changed final=$text; ${observe}; printf '<%s>\\n' "$other" "$final"`;
}

function generate(seed, count) {
  const random = randomFor(seed);
  const cases = fixedCases();
  for (let index = 0; index < count; index++) {
    cases.push({ id: `generated-${index}`, script: generatedCase(random, index) });
  }
  return cases;
}

function run(bin, script, timeout, bash = false) {
  const env = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "BASH_COMPAT", "POSIXLY_CORRECT"])
    delete env[name];
  const args = bash ? ["--noprofile", "--norc", "-c", `set -f\n${script}`] : ["-c", script];
  const result = spawnSync(bin, args, {
    env,
    encoding: null,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
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
const equal = (left, right) =>
  !left.timedOut &&
  !right.timedOut &&
  Number.isInteger(left.status) &&
  left.status === right.status &&
  left.signal === null &&
  right.signal === null &&
  left.stdout.equals(right.stdout);

function replay(path, options, shell) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (fixture.schema !== 1 || fixture.sourceHash !== fingerprint())
    throw new Error("stale readonly fixture");
  if (fixture.count !== options.count || fixture.timeoutMs !== options.timeout)
    throw new Error("fixture options differ");
  if (!fixture.bash?.startsWith("GNU bash, version 5.3.15"))
    throw new Error("fixture oracle differs");
  if (fixture.seed !== options.seed) throw new Error("fixture seed differs");
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
  for (const [index, test] of cases.entries()) {
    const bash =
      oracle?.[index] ?? run(process.env.BASH_BIN ?? "bash", test.script, options.timeout, true);
    const ours = run(shell, test.script, options.timeout);
    if (!equal(bash, ours)) {
      mismatchCount++;
      if (mismatches.length < 40)
        mismatches.push({ ...test, bash: encode(bash), ours: encode(ours) });
    }
    if (options.record) results.push({ case: test, bash: encode(bash) });
  }
  return {
    total: cases.length,
    counts: { MATCH: cases.length - mismatchCount, UNSUPPORTED: 0, MISMATCH: mismatchCount },
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
        "brush-web-readonly-fuzz",
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
  if (!existsSync(shell)) throw new Error(`missing shell-engine: ${shell}`);
  let reports;
  if (options.replays.length) {
    reports = options.replays.map((path) => ({ path, ...replay(path, options, shell) }));
  } else {
    const bash = execFileSync(process.env.BASH_BIN ?? "bash", ["--version"], {
      encoding: "utf8",
    }).split("\n", 1)[0];
    if (!bash.startsWith("GNU bash, version 5.3.15"))
      throw new Error(`Bash 5.3.15 required, got ${bash}`);
    const result = execute(generate(options.seed, options.count), options, shell);
    reports = [{ seed: options.seed, bash, ...result }];
    if (options.record) {
      if (result.counts.MISMATCH)
        throw new Error(`cannot record ${result.counts.MISMATCH} readonly mismatches`);
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
