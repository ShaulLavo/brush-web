// Runs the pinned Oils shell spec corpus through real GNU bash and each browser engine.
// Bash is the oracle: a case passes when stdout and exit status match bash exactly.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, constants } from "node:os";
import { basename, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { pythonHelpers } from "./bash-compat-helpers.mjs";
import { baseBranchBaseline } from "./shell-scoreboard-base.mjs";
import {
  bytesDigest,
  compactResult,
  digest,
  sealOracle,
  verifyOracle,
  summarize,
  compareScores,
  validateScore,
} from "./shell-scoreboard.mjs";

const root = resolve(import.meta.dirname, "..");
const pins = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
const mode = process.env.BASH_COMPAT_MODE ?? "live";
if (!["live", "capture", "frozen"].includes(mode))
  throw new Error(`Unknown compatibility mode: ${mode}`);
const timeoutMs = Number(process.env.BASH_COMPAT_TIMEOUT_MS ?? 10000);
const oracleFile = resolve(
  root,
  process.env.BASH_COMPAT_ORACLE ?? "docs/evidence/own-shell-oracle.json",
);
const baselineFile = resolve(
  root,
  process.env.BASH_COMPAT_BASELINE ?? "docs/evidence/own-shell-baseline.json",
);
const sourceFiles = {};
const brushCorpus = resolve(root, process.env.BASH_COMPAT_BRUSH_DIR ?? "vendor/brush");
const bashkitCorpus = resolve(root, process.env.BASH_COMPAT_BASHKIT_DIR ?? ".sources/bashkit");
const jobs = Number(
  process.env.BASH_COMPAT_JOBS ?? Math.min(4, Math.max(2, availableParallelism() >> 1)),
);
const onlyFiles = process.env.BASH_COMPAT_FILES?.split(",").filter(Boolean);
const corpusNames = (process.env.BASH_COMPAT_CORPORA ?? "oils,brush-suite,bashkit-suite").split(
  ",",
);
const output = resolve(
  root,
  process.env.BASH_COMPAT_OUT ?? "docs/evidence/bash-compatibility.json",
);
const bashPath = process.env.BASH_COMPAT_BASH ?? "/usr/bin/bash";
const virtualTmp = "/tmp/spec";
const virtualHome = "/home/user";

const engines = {
  "own-shell": {
    modulePath: resolve(
      root,
      process.env.BASH_COMPAT_SHELL_WASM ?? ".build/shell/wasm32-wasip1/release/shell-engine.wasm",
    ),
  },
  brush: { modulePath: resolve(root, ".build/rust/wasm32-wasip1/release/brush-compat.wasm") },
  "bashkit-source": { modulePath: resolve(root, ".sources/bashkit/pkg") },
  "bashkit-published": { modulePath: resolve(root, "node_modules/@everruns/bashkit-wasm") },
  "just-bash": {},
  // Reference only: the same pinned Brush source built natively, with host processes.
  "brush-native": { binary: resolve(root, ".build/brush-native/release/brush") },
};
const engineNames =
  process.env.BASH_COMPAT_ENGINES?.split(",") ??
  (mode === "live" ? Object.keys(engines) : ["own-shell"]);
if (!engineNames.length || engineNames.some((name) => !(name in engines)))
  throw new Error(`Unknown compatibility engines: ${engineNames.join(",")}`);
if (
  !Number.isInteger(jobs) ||
  jobs < 1 ||
  jobs > 32 ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1
)
  throw new Error("Set BASH_COMPAT_JOBS to 1..32 and BASH_COMPAT_TIMEOUT_MS to a positive integer");
if (
  mode !== "live" &&
  (onlyFiles || process.env.BASH_COMPAT_CORPORA || engineNames.join(",") !== "own-shell")
)
  throw new Error("Fixed scoreboard requires own-shell and the complete fixed case set");

// Every non-YSH Oils spec file that compares against bash, grouped by subject.
const categories = {
  "Quoting and word splitting": [
    "quote",
    "word-split",
    "word-eval",
    "whitespace",
    "comments",
    "var-sub-quote",
    "tilde",
    "unicode",
    "nul-bytes",
  ],
  "Parameter expansion": [
    "var-op-bash",
    "var-op-len",
    "var-op-patsub",
    "var-op-slice",
    "var-op-strip",
    "var-op-test",
    "var-sub",
    "var-num",
    "var-ref",
    "nameref",
  ],
  "Brace expansion": ["brace-expansion"],
  Arithmetic: ["arith", "arith-context", "arith-dynamic", "dparen", "let", "for-expr"],
  "Arrays and assoc arrays": [
    "array",
    "array-assign",
    "array-assoc",
    "array-basic",
    "array-compat",
    "array-literal",
    "array-sparse",
    "append",
    "type-compat",
  ],
  "Assignment, scope and special vars": [
    "assign",
    "assign-deferred",
    "assign-dialects",
    "assign-extended",
    "temp-binding",
    "vars-special",
    "vars-bash",
    "builtin-vars",
  ],
  "Command substitution and subshells": ["command-sub", "subshell", "process-sub"],
  "Globbing and extglob": [
    "glob",
    "glob-bash",
    "globignore",
    "globstar",
    "extglob-files",
    "extglob-match",
    "nocasematch-match",
  ],
  "Conditionals, test, [[ ]] and case": [
    "dbracket",
    "builtin-bracket",
    "bool-parse",
    "regex",
    "if_",
    "case_",
  ],
  "Grammar, functions and control flow": [
    "loop",
    "sh-func",
    "func-parsing",
    "empty-bodies",
    "command_",
    "command-parsing",
    "shell-grammar",
    "paren-ambiguity",
    "explore-parsing",
    "parse-errors",
    "posix",
    "smoke",
    "exit-status",
    "fatal-errors",
    "toysh",
    "toysh-posix",
  ],
  "Here-docs and redirects": ["here-doc", "redirect", "redirect-command", "redirect-multi"],
  Pipelines: ["pipeline"],
  "errexit, options and traps": [
    "errexit",
    "errexit-osh",
    "strict-options",
    "sh-options",
    "sh-options-bash",
    "builtin-set",
    "builtin-trap",
    "builtin-trap-bash",
    "builtin-trap-err",
  ],
  "echo, printf, read, mapfile, getopts": [
    "builtin-echo",
    "builtin-printf",
    "builtin-read",
    "builtin-bash",
    "builtin-getopts",
  ],
  "Other builtins (cd, eval, source, type, alias...)": [
    "builtin-cd",
    "builtin-dirs",
    "builtin-eval-source",
    "builtin-meta",
    "builtin-meta-assign",
    "builtin-misc",
    "builtin-special",
    "builtin-type",
    "builtin-type-bash",
    "alias",
    "introspect",
    "serialize",
    "print-source-code",
    "arg-parse",
  ],
  "Real-world idioms": [
    "ble-features",
    "ble-idioms",
    "ble-unset",
    "blog1",
    "blog2",
    "blog-other1",
    "bugs",
    "nix-idioms",
    "divergence",
    "known-differences",
    "shell-bugs",
    "zsh-idioms",
  ],
};
const excludedFiles = {
  "Interactive editing, history, completion and prompts; not a script feature": [
    "builtin-completion",
    "builtin-bind",
    "builtin-fc",
    "builtin-history",
    "history-expand",
    "interactive",
    "interactive-parse",
    "prompt",
  ],
  "Job control, signals between processes, ulimit/umask/times": [
    "background",
    "builtin-kill",
    "builtin-process",
    "builtin-times",
    "builtin-umask",
  ],
  "Shell executable flags (`$SH -n`, `-i`, `-o` ...), no in-process equivalent": ["sh-usage"],
  "xtrace output goes only to stderr, which is not scored": ["xtrace"],
  "No bash in the file's compare_shells (zsh, mksh or OSH only)": [
    "zsh-assoc",
    "command-sub-ksh",
    "redir-order",
    "osh-bugs",
    "spec-harness-bug",
  ],
};

const commonCommands = [
  "cat",
  "ls",
  "mkdir",
  "rm",
  "rmdir",
  "cp",
  "mv",
  "touch",
  "ln",
  "chmod",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "paste",
  "tee",
  "grep",
  "sed",
  "awk",
  "find",
  "xargs",
  "date",
  "seq",
  "env",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "diff",
  "od",
  "hexdump",
  "base64",
  "md5sum",
  "sha256sum",
  "expr",
  "jq",
  "tac",
  "rev",
  "nl",
  "fold",
  "printf",
  "echo",
  "test",
  "true",
  "false",
  "sleep",
  "which",
  "file",
  "du",
  "df",
  "tar",
  "gzip",
  "curl",
  "python3",
  "bash",
  "sh",
];

const spotChecks = [
  ["grep -E alternation", "grep -E 'ap|an' fruits"],
  ["grep -o -n -i", "grep -o -n -i 'AN' fruits"],
  ["grep -c -v -w", "grep -c -v -w apple fruits"],
  ["grep -r with --include", "grep -r --include='*.txt' -l fig ."],
  ["sed s///g with -E groups", "sed -E 's/(a)(n)/\\2\\1/g' fruits"],
  ["sed -n range print", "sed -n '2,3p' fruits"],
  ["sed delete and insert", "sed -e '/fig/d' -e '1i head' fruits"],
  ["sed -i in place", "sed -i 's/apple/APPLE/' fruits; cat fruits"],
  ["awk fields and sum", "awk -F, '{s+=$2} END {print s, NR}' prices"],
  [
    "awk printf and arrays",
    "awk -F, '{c[$1]++} END {for (k in c) printf \"%s=%d\\n\", k, c[k]}' prices | sort",
  ],
  ["awk regex and substr", "awk '/an/ {print toupper(substr($0, 1, 3))}' fruits"],
  ["sort -n -r", "printf '10\\n9\\n100\\n' | sort -n -r"],
  ["sort -t -k -u", "sort -t, -k2,2n -u prices"],
  ["uniq -c", "sort fruits fruits | uniq -c"],
  ["cut and tr", "cut -d, -f1 prices | tr a-z A-Z"],
  ["head and tail", "head -n 2 fruits; tail -n 1 fruits"],
  ["wc -l -w", "wc -l -w < fruits"],
  ["find -name -type", "find . -name '*.txt' -type f | sort"],
  ["find -maxdepth", "find . -maxdepth 1 -type d | sort"],
  ["xargs -n", "printf 'a b c d\\n' | xargs -n 2 echo"],
  ["jq field", "printf '{\"a\":{\"b\":[1,2,3]}}' | jq '.a.b[1]'"],
  [
    "jq -r map select",
    'printf \'[{"n":"x","v":1},{"n":"y","v":2}]\' | jq -r \'.[] | select(.v > 1) | .n\'',
  ],
  ["jq -c transform", "printf '[1,2,3]' | jq -c 'map(. * 2) | {sum: add}'"],
];
const spotSetup =
  "printf 'apple\\nbanana\\ncherry\\nfig\\n' > fruits; printf 'apple,3\\nfig,2\\napple,5\\n' > prices; " +
  "mkdir -p d/e; printf 'fig\\n' > d/a.txt; printf 'fig\\n' > d/e/b.txt; printf 'x\\n' > d/c.md; ";

const scratchRoot = process.env.BASH_COMPAT_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp";
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, "brush-web-compat-"));
const pools = [];
const activeChildren = new Map();
let finished = false;
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("exit", () => {
  for (const kill of activeChildren.keys()) kill();
  if (!finished) execFileSync("rm", ["-rf", scratch]);
});

async function main() {
  if (mode === "frozen") return runFrozen();
  const corpus = corpusNames.includes("oils") ? await prepareCorpus() : undefined;
  if (mode === "live") prepareEngines();
  const helperDirectory = resolve(scratch, "helpers");
  await mkdir(helperDirectory);
  for (const [name, source] of Object.entries(pythonHelpers)) {
    await writeFile(resolve(helperDirectory, name), source);
    await chmod(resolve(helperDirectory, name), 0o755);
  }
  const bashVersion = execFileSync(bashPath, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const cases = (await loadOilsCases(corpus)).concat(
    await loadBrushCases(),
    await loadBashkitCases(),
  );
  if (mode === "capture") return captureOracle(cases, helperDirectory, bashVersion);
  for (const name of corpusNames)
    log(`${name}: ${cases.filter((item) => item.corpus === name).length} cases`);

  const fullPath = `${helperDirectory}:/usr/local/bin:/usr/bin:/bin`;
  await mapLimit(cases, jobs * 2, async (item) => {
    if (item.excluded) return;
    const first = await runShell(bashPath, item.code, fullPath);
    const second = await runShell(bashPath, item.code, fullPath);
    const builtinsOnly = await runShell(bashPath, item.code, helperDirectory);
    item.bash = first;
    if (first.timeout) item.excluded = "bash timed out";
    else if (!same(first, second)) item.excluded = "bash output is not deterministic";
    else if (!same(first, builtinsOnly)) {
      item.kind = "needs-commands";
      item.needs = Array.from(
        new Set(
          Array.from(
            builtinsOnly.stderr.toString("latin1").matchAll(/: ([^\s:]+): command not found/g),
            (match) => match[1],
          ),
        ),
      ).sort();
    } else item.kind = "builtins-only";
  });
  log("bash oracle done");

  const spots = spotChecks.map(([name, code]) => ({ name, code: spotSetup + code }));
  await mapLimit(spots, jobs, async (spot) => {
    spot.bash = await runShell(bashPath, spot.code, fullPath);
  });

  const inventoryNames = Array.from(
    new Set(commonCommands.concat(cases.flatMap((item) => item.needs ?? []))),
  ).sort();
  const inventoryScript = `for n in ${inventoryNames.map(shellQuote).join(" ")}; do command -v "$n" >/dev/null 2>&1 && echo "$n"; done`;

  const inventories = {};
  for (const engine of engineNames) {
    const native = engines[engine].binary;
    const pool = native
      ? { run: (code) => runShell(native, code, fullPath), close: async () => {} }
      : new Pool(engine, jobs);
    pools.push(pool);
    const inventory = await pool.run(inventoryScript);
    inventories[engine] = inventory.stdout.toString("utf8").split("\n").filter(Boolean);
    const available = new Set(inventories[engine]);
    let done = 0;
    await mapLimit(cases, jobs, async (item) => {
      if (item.excluded) return;
      const actual = await pool.run(item.code);
      item.results ??= {};
      item.results[engine] = judge(item, actual, available);
      if (++done % 250 === 0) log(`${engine}: ${done}`);
    });
    await mapLimit(spots, jobs, async (spot) => {
      const actual = await pool.run(spot.code);
      spot.results ??= {};
      spot.results[engine] = same(spot.bash, normalizeResult(actual))
        ? "pass"
        : actual.timeout
          ? "timeout"
          : "fail";
    });
    await pool.close();
    log(`${engine} done`);
  }

  const evidence = buildEvidence({ bashVersion, cases, spots, inventories, inventoryNames });
  evidence.mapfile = await probeMapfile(fullPath);
  // One line per case keeps the evidence file reviewable in diffs.
  const rows = evidence.cases.map((item) => JSON.stringify(item)).join(",\n");
  await writeFile(
    output,
    JSON.stringify({ ...evidence, cases: "CASES" }, null, 1).replace(
      '"CASES"',
      () => `[\n${rows}\n]`,
    ) + "\n",
  );
  console.log(renderSummary(evidence));
  log(`wrote ${output}`);
}

async function prepareCorpus() {
  const pin = pins.oils;
  const destination = resolve(root, ".sources/oils");
  const marker = resolve(destination, ".revision");
  const current = await readFile(marker, "utf8").catch(() => "");
  if (current.trim() !== pin.revision) {
    log(`downloading Oils ${pin.revision}`);
    const response = await fetch(
      `https://codeload.github.com/oils-for-unix/oils/tar.gz/${pin.revision}`,
    );
    if (!response.ok) throw new Error(`Oils source download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== pin.archiveSha256)
      throw new Error("Oils source archive checksum mismatch");
    const archive = resolve(scratch, "oils.tar.gz");
    await writeFile(archive, bytes);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      archive,
      "--strip-components=1",
      "-C",
      destination,
      "--wildcards",
      `oils-${pin.revision}/spec/*.test.sh`,
      `oils-${pin.revision}/LICENSE.txt`,
    ]);
    await writeFile(marker, pin.revision);
  }
  return destination;
}

function prepareEngines() {
  if (engineNames.includes("own-shell") && process.env.BASH_COMPAT_SKIP_BUILD !== "1") {
    execFileSync(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--target",
        "wasm32-wasip1",
        "--manifest-path",
        "shell/Cargo.toml",
        "-p",
        "shell-engine",
        "-j2",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, CARGO_TARGET_DIR: resolve(root, ".build/shell") },
      },
    );
  }
  if (engineNames.includes("brush")) {
    log("building the Brush compatibility driver");
    execFileSync("node", [resolve(root, "scripts/build-wasm.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
  }
  if (engineNames.includes("brush-native"))
    execFileSync(
      "cargo",
      // Same compiler as the browser build, not the submodule's own toolchain file.
      [
        `+${rustChannel()}`,
        "build",
        "--locked",
        "--release",
        "-p",
        "brush-shell",
        "--bin",
        "brush",
      ],
      {
        cwd: resolve(root, "vendor/brush"),
        env: { ...process.env, CARGO_TARGET_DIR: resolve(root, ".build/brush-native") },
        stdio: "inherit",
      },
    );
  if (engineNames.includes("bashkit-source"))
    execFileSync("node", [resolve(root, "scripts/build-bashkit.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
}

// Bashkit triage: repeated mapfile into one array. Checks whether maxMemory matters and
// whether the effect outlives the execute() call that caused it.
async function probeMapfile(fullPath) {
  const script =
    'seq 50000 > /tmp/s; for i in 1 2 3; do mapfile -t a < /tmp/s; echo "mapfile=$? n=${#a[@]}"; done; ' +
    'b=(x y z); echo "b=${#b[@]}"; unset a; c=(x y z); echo "c=${#c[@]}"';
  const lines = (text) => text.trim().split("\n");
  const result = {
    script,
    bash: lines((await runShell(bashPath, script, fullPath)).stdout.toString()),
  };
  for (const engine of ["bashkit-source", "bashkit-published"]) {
    if (!engineNames.includes(engine)) continue;
    const { modulePath } = engines[engine];
    const { initBashkit, Bash } = await import(resolve(modulePath, "index.js"));
    await initBashkit(readFileSync(resolve(modulePath, "bashkit_wasm_bg.wasm")));
    const runs = {};
    for (const maxMemory of [undefined, 32 * 1024 * 1024, 256 * 1024 * 1024]) {
      const output = await new Bash(maxMemory ? { maxMemory } : {}).execute(script);
      runs[maxMemory ? `maxMemory ${maxMemory}` : "default options"] = {
        stdout: lines(output.stdout),
        stderr: output.stderr,
        exitCode: output.exitCode,
      };
    }
    const session = new Bash({});
    await session.execute("seq 50000 > /tmp/s");
    for (let index = 0; index < 3; index++) await session.execute("mapfile -t a < /tmp/s");
    runs["later execute() in the same session"] = lines(
      (await session.execute('b=(x y z); echo "b=${#b[@]}"')).stdout,
    );
    runs["new Bash instance"] = lines(
      (await new Bash({}).execute('b=(x y z); echo "b=${#b[@]}"')).stdout,
    );
    result[engine] = runs;
  }
  return result;
}

function rustChannel() {
  const toolchain = readFileSync(resolve(root, "rust-toolchain.toml"), "utf8");
  return /channel = "([^"]+)"/.exec(toolchain)[1];
}

async function loadOilsCases(corpus) {
  if (!corpusNames.includes("oils")) return [];
  const listed = new Map(
    Object.entries(categories).flatMap(([category, files]) =>
      files.map((file) => [file, category]),
    ),
  );
  const available = (await readdir(resolve(corpus, "spec")))
    .filter((name) => name.endsWith(".test.sh"))
    .map((name) => basename(name, ".test.sh"));
  const known = new Set(Array.from(listed.keys()).concat(Object.values(excludedFiles).flat()));
  for (const name of available) {
    const text = await readFile(resolve(corpus, "spec", `${name}.test.sh`), "utf8");
    const compare = /^## compare_shells:(.*)$/m.exec(text)?.[1] ?? "";
    const isOils = name.startsWith("ysh-") || name.startsWith("hay");
    if (!isOils && /\bbash\b/.test(compare) && !known.has(name))
      throw new Error(`Unclassified bash spec file: ${name}`);
  }
  const cases = [];
  for (const [file, category] of listed) {
    if (onlyFiles && !onlyFiles.includes(file)) continue;
    const text = await corpusText(
      "oils",
      `spec/${file}.test.sh`,
      resolve(corpus, "spec", `${file}.test.sh`),
    );
    for (const parsed of parseSpecFile(text))
      cases.push({
        corpus: "oils",
        file,
        category,
        ...parsed,
        excluded: parsed.code.includes("REPO_ROOT") ? "reads Oils repository test data" : undefined,
      });
  }
  return cases;
}

// Secondary signal: Brush's own bash-comparison cases. Only cases defined by a script alone
// are used; cases with arguments, files, environment, terminals or skips are left out.
async function loadBrushCases() {
  if (!corpusNames.includes("brush-suite")) return [];
  const directory = resolve(brushCorpus, "brush-shell/tests/cases/compat");
  const plain = new Set([
    "name",
    "stdin",
    "ignore_stderr",
    "known_failure",
    "min_oracle_version",
    "timeout_in_seconds",
  ]);
  const cases = [];
  const files = (await readdir(directory, { recursive: true }))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const { parse } = await import("yaml");
  for (const file of files) {
    const suite = parse(await corpusText("brush-suite", file, resolve(directory, file)));
    for (const [index, entry] of (suite.cases ?? []).entries()) {
      const extra = Object.keys(entry).filter((key) => !plain.has(key));
      cases.push({
        corpus: "brush-suite",
        file: file.replace(/\.yaml$/, ""),
        line: index + 1,
        name: entry.name ?? `case ${index + 1}`,
        code: entry.stdin ?? "",
        excluded:
          !entry.stdin || suite.common_test_files || extra.length
            ? "needs Brush harness arguments, files, environment, terminal or a skip marker"
            : undefined,
      });
    }
  }
  return cases;
}

// Secondary signal: Bashkit's own bash spec cases, parsed like its spec_runner.rs.
// Files ported from Oils or just-bash are left out: they duplicate other corpora.
async function loadBashkitCases() {
  if (!corpusNames.includes("bashkit-suite")) return [];
  const directory = resolve(bashkitCorpus, "crates/bashkit/tests/spec_cases/bash");
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".test.sh"))
    .filter((name) => !name.startsWith("oils-") && !name.includes("just-bash"))
    .sort();
  const cases = [];
  for (const file of files) {
    const lines = (await corpusText("bashkit-suite", file, resolve(directory, file))).split("\n");
    let current;
    for (const [index, line] of lines.entries()) {
      if (line.startsWith("### ")) {
        const directive = line.slice(4).trim();
        if (directive === "expect" || directive === "end") current = undefined;
        else if (!/^(exit_code|skip|bash_diff|paused_time)\b/.test(directive)) {
          current = {
            corpus: "bashkit-suite",
            file: basename(file, ".test.sh"),
            line: index + 1,
            name: directive,
            code: "",
          };
          cases.push(current);
        }
        continue;
      }
      if (!current) continue;
      if (line.startsWith("# ") && !current.code && !current.described) {
        current.described = true;
        continue;
      }
      current.code += line + "\n";
    }
  }
  for (const item of cases) delete item.described;
  return cases.filter((item) => item.code.trim());
}

// Port of the tokenizer in Oils test/sh_spec.py: comment lines are dropped from code,
// blank lines are kept once code has started, and `## key: value` lines end the code.
function parseSpecFile(text) {
  const keyValue = /^##\s+(?:(?:OK(?:-\d)?|BUG(?:-\d)?|N-I)\s+[\w+/]+\s+)?([\w-]+):\s*(.*)$/;
  const lines = text.split(/(?<=\n)/);
  const cases = [];
  let current;
  let state = "header";
  let resume = "after-code";
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("####")) {
      current = { name: line.slice(4).trim(), line: index + 1, code: "" };
      cases.push(current);
      state = "before-code";
      continue;
    }
    if (state === "header") continue;
    if (state === "multiline") {
      if (/^##\s+END/.test(line)) state = resume;
      continue;
    }
    const metadata = keyValue.exec(line);
    if (metadata) {
      // Metadata may precede the code; metadata after code ends it.
      resume = state === "before-code" && metadata[1] !== "code" ? "before-code" : "after-code";
      if (metadata[1] === "code") current.code = metadata[2] + "\n";
      state = metadata[1] === "STDOUT" || metadata[1] === "STDERR" ? "multiline" : resume;
      continue;
    }
    if (/^##\s+END/.test(line) || line.trimStart().startsWith("#")) continue;
    if (state === "before-code" && !line.trim()) continue;
    if (state === "after-code") continue;
    state = "code";
    current.code += line.endsWith("\n") ? line : line + "\n";
  }
  return cases.filter((item) => item.code);
}

async function runShell(shell, code, path, sandbox = false) {
  const directory = await mkdtemp(resolve(scratch, "bash-"));
  const tmp = resolve(directory, "tmp");
  const home = resolve(directory, "home");
  let kill = () => {};
  try {
    await mkdir(tmp);
    await mkdir(home);
    const sandboxArgs = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      directory,
      directory,
      "--ro-bind",
      resolve(scratch, "helpers"),
      resolve(scratch, "helpers"),
      "--ro-bind",
      shell,
      shell,
      "--chdir",
      tmp,
      "--",
      shell,
      "-c",
      code,
    ];
    const child = spawn(sandbox ? "bwrap" : shell, sandbox ? sandboxArgs : ["-c", code], {
      cwd: tmp,
      env: { PATH: path, HOME: home, TMP: tmp, SH: "bash", LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const running = collectShell(child, kill, tmp, home);
    activeChildren.set(kill, running);
    return await running;
  } finally {
    kill();
    activeChildren.delete(kill);
    await rm(directory, { recursive: true, force: true });
  }
}
function collectShell(child, kill, tmp, home) {
  return new Promise((done, fail) => {
    const stdout = [];
    const stderr = [];
    let timeout = false;
    let outputLimit = false;
    let bytes = 0;
    const timer = setTimeout(() => {
      timeout = true;
      kill();
    }, timeoutMs);
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) return chunks.push(chunk);
      outputLimit = true;
      kill();
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", kill);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      done(
        normalize(
          {
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            status: status ?? 128 + (constants.signals[signal] ?? 0),
            timeout,
            outputLimit,
          },
          [
            [tmp, "$TMP"],
            [home, "$HOME"],
          ],
        ),
      );
    });
  });
}

function normalize(result, paths) {
  const replace = (bytes) => {
    let text = bytes.toString("latin1");
    for (const [from, to] of paths) text = text.split(from).join(to);
    return Buffer.from(text, "latin1");
  };
  return { ...result, stdout: replace(result.stdout), stderr: replace(result.stderr) };
}

function normalizeResult(actual) {
  return normalize(actual, [
    [virtualTmp, "$TMP"],
    [virtualHome, "$HOME"],
  ]);
}

function same(expected, actual) {
  return expected.status === actual.status && expected.stdout.equals(actual.stdout);
}

function judge(item, raw, available) {
  const actual = normalizeResult(raw);
  if (!actual.timeout && !actual.crash && same(item.bash, actual))
    return {
      outcome: "pass",
      stderrAgrees: !item.bash.stderr.length === !actual.stderr.length,
    };
  const missing = (item.needs ?? []).filter((name) => !available.has(name));
  const outcome = actual.timeout
    ? "timeout"
    : actual.crash
      ? "crash"
      : missing.length
        ? "missing-command"
        : "fail";
  return {
    outcome,
    missing: missing.length ? missing : undefined,
    status: actual.status,
    stdout: clip(actual.stdout),
    stderr: clip(actual.stderr),
    crash: actual.crash,
  };
}

function clip(bytes, limit = 240) {
  const text = bytes.toString("utf8");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class Pool {
  constructor(engine, size) {
    this.engine = engine;
    this.idle = [];
    this.waiting = [];
    this.workers = new Set();
    this.size = size;
    this.sequence = 0;
  }

  async spawn() {
    const worker = new Worker(resolve(import.meta.dirname, "bash-compat-worker.mjs"), {
      workerData: {
        engine: this.engine.startsWith("bashkit") ? "bashkit" : this.engine,
        modulePath: engines[this.engine].modulePath,
        scratch,
        tmp: virtualTmp,
        home: virtualHome,
        env: { HOME: virtualHome, TMP: virtualTmp, SH: "bash", LC_ALL: "C.UTF-8" },
      },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    this.workers.add(worker);
    await new Promise((ready, fail) => {
      worker.once("message", ready);
      worker.once("error", fail);
    });
    return worker;
  }

  async acquire() {
    if (this.idle.length) return this.idle.pop();
    if (this.workers.size < this.size) return this.spawn();
    return new Promise((resume) => this.waiting.push(resume));
  }

  release(worker) {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  async replace(worker) {
    this.workers.delete(worker);
    await worker.terminate();
    const next = this.waiting.shift();
    if (next) next(await this.spawn());
  }

  async run(code) {
    const worker = await this.acquire();
    const id = ++this.sequence;
    const result = await new Promise((done) => {
      const finish = (value) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        done(value);
      };
      const empty = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const onMessage = (message) => {
        if (message.id === id)
          finish({
            ...message,
            stdout: Buffer.from(message.stdout),
            stderr: Buffer.from(message.stderr),
          });
      };
      const onError = (error) => finish({ ...empty, crash: String(error), dead: true });
      const onExit = (code) => finish({ ...empty, crash: `worker exited ${code}`, dead: true });
      const timer = setTimeout(() => finish({ ...empty, timeout: true, dead: true }), timeoutMs);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage({ id, code });
    });
    if (result.dead) await this.replace(worker);
    else this.release(worker);
    return result;
  }

  async close() {
    const workers = Array.from(this.workers);
    this.workers.clear();
    this.idle = [];
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function mapLimit(items, limit, task) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index], index);
    }
  });
  await Promise.all(lanes);
}

function rate(passed, total) {
  return total ? Math.round((1000 * passed) / total) / 10 : null;
}

function buildEvidence({ bashVersion, cases, spots, inventories, inventoryNames }) {
  const scored = cases.filter((item) => !item.excluded);
  const builtins = scored.filter((item) => item.kind === "builtins-only");
  const summarize = (items) =>
    Object.fromEntries(
      engineNames.map((engine) => {
        const outcomes = {};
        for (const item of items) {
          const outcome = item.results[engine].outcome;
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        }
        return [
          engine,
          { cases: items.length, passRate: rate(outcomes.pass ?? 0, items.length), outcomes },
        ];
      }),
    );
  const count = (items, key) => {
    const counts = {};
    for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
    return counts;
  };
  const oils = builtins.filter((item) => item.corpus === "oils");
  const corpora = Object.fromEntries(
    corpusNames.map((name) => {
      const all = cases.filter((item) => item.corpus === name);
      const kept = scored.filter((item) => item.corpus === name);
      return [
        name,
        {
          cases: all.length,
          exclusions: count(
            all.filter((item) => item.excluded),
            "excluded",
          ),
          builtinsOnly: summarize(builtins.filter((item) => item.corpus === name)),
          needsCommands: summarize(kept.filter((item) => item.kind === "needs-commands")),
        },
      ];
    }),
  );
  return {
    question: "How closely does each browser shell interpreter match GNU bash?",
    method: [
      "Each case runs once per engine in a fresh shell with empty stdin and a per-case timeout.",
      "bash -c runs each case twice with the full PATH and once with only the two test helpers on PATH.",
      "A case is builtins-only when bash gives identical stdout and status in both PATH modes. Only those cases form the interpreter score.",
      "Other cases need external commands (or spawn $SH). A failure there is missing-command when the engine lacks a command bash needed.",
      "Pass means identical stdout bytes and exit status after replacing each engine's $TMP and $HOME paths. stderr is recorded but not scored.",
    ],
    oracle: bashVersion,
    node: process.version,
    timeoutMs,
    sources: {
      oils: { repository: pins.oils.repository, revision: pins.oils.revision },
      "brush-suite": `vendor/brush ${pins.brush.revision} brush-shell/tests/cases/compat`,
      "bashkit-suite": `Bashkit ${pins.bashkitTerminal.revision} crates/bashkit/tests/spec_cases/bash, without oils-* and just-bash ports`,
    },
    oilsFiles: categories,
    oilsExcludedFiles: excludedFiles,
    engines: {
      "own-shell":
        "Original shell-engine CLI, wasm32-wasip1, in-process fixture ProcessHost on node:wasi; no browser integration",
      brush: `Brush ${pins.brush.revision} with patches/brush-browser.patch, wasm32-wasip1 brush-compat driver (same brush-core, builtins and browser utilities as brush-browser.wasm) on node:wasi`,
      "bashkit-source": `Bashkit ${pins.bashkitTerminal.revision} source build (the bashkit-terminal engine's WASM), Bash.execute`,
      "bashkit-published": `@everruns/bashkit-wasm ${pins.bashkit.version}, Bash.execute`,
      "just-bash": `just-bash ${pins.justBash.version}, Bash.exec with rawScript and workbench limits`,
      "brush-native": `Reference only: Brush ${pins.brush.revision} brush-shell built natively (brush -c), with host processes and the full PATH`,
    },
    corpora,
    oilsByCategory: Object.fromEntries(
      Object.keys(categories).map((category) => [
        category,
        summarize(oils.filter((item) => item.category === category)),
      ]),
    ),
    oilsPassesByFile: Object.fromEntries(
      Array.from(new Set(oils.map((item) => item.file)), (file) => {
        const items = oils.filter((item) => item.file === file);
        return [
          file,
          Object.fromEntries(
            [["cases", items.length]].concat(
              engineNames.map((engine) => [
                engine,
                items.filter((item) => item.results[engine].outcome === "pass").length,
              ]),
            ),
          ),
        ];
      }),
    ),
    stderrAgreementOnOilsPasses: Object.fromEntries(
      engineNames.map((engine) => {
        const passes = oils.filter((item) => item.results[engine].outcome === "pass");
        return [
          engine,
          rate(passes.filter((item) => item.results[engine].stderrAgrees).length, passes.length),
        ];
      }),
    ),
    commandInventory: Object.fromEntries(
      engineNames.map((engine) => [engine, inventories[engine]]),
    ),
    inventoryProbe: inventoryNames,
    spotChecks: spots.map((spot) => ({ name: spot.name, code: spot.code, results: spot.results })),
    // Oils cases keep clipped output for every failure. Secondary corpora keep outcomes only.
    cases: cases.map((item) => {
      const detailed = item.corpus === "oils";
      return {
        corpus: item.corpus,
        file: item.file,
        line: item.line,
        name: item.name,
        kind: item.excluded ? undefined : item.kind,
        excluded: item.excluded,
        needs: item.needs?.length ? item.needs : undefined,
        bash:
          detailed &&
          item.results &&
          Object.values(item.results).some((value) => value.outcome !== "pass")
            ? { status: item.bash.status, stdout: clip(item.bash.stdout) }
            : undefined,
        results: item.results
          ? Object.fromEntries(
              Object.entries(item.results).map(([engine, value]) => [
                engine,
                value.outcome === "pass"
                  ? "pass"
                  : detailed
                    ? value
                    : value.crash
                      ? { outcome: value.outcome, crash: value.crash }
                      : value.outcome,
              ]),
            )
          : undefined,
      };
    }),
  };
}

function renderSummary(evidence) {
  const header = `| Category | Cases | ${engineNames.join(" | ")} |`;
  const divider = `| --- | ---: | ${engineNames.map(() => "---:").join(" | ")} |`;
  const row = (label, summary) => {
    const first = summary[engineNames[0]];
    return `| ${label} | ${first.cases} | ${engineNames
      .map((engine) => (summary[engine].passRate === null ? "-" : `${summary[engine].passRate}%`))
      .join(" | ")} |`;
  };
  const rows = Object.entries(evidence.oilsByCategory).map(([category, summary]) =>
    row(category, summary),
  );
  const corpusRows = Object.entries(evidence.corpora).flatMap(([name, corpus]) => [
    row(`**${name}: builtins-only**`, corpus.builtinsOnly),
    row(`${name}: needs external commands`, corpus.needsCommands),
  ]);
  return [header, divider].concat(rows, corpusRows).join("\n");
}

function log(message) {
  console.error(`[bash-compat] ${message}`);
}

async function corpusText(corpus, file, path) {
  const bytes = await readFile(path);
  (sourceFiles[corpus] ??= {})[file] = bytesDigest(bytes);
  return bytes.toString("utf8");
}
function caseId(item) {
  return `${item.corpus}:${item.file}:${item.line}`;
}
const packResult = (result) => ({
  status: result.status,
  stdout: result.stdout.toString("base64"),
  stderr: result.stderr.toString("base64"),
  ...(result.timeout ? { timeout: true } : {}),
  ...(result.outputLimit ? { outputLimit: true } : {}),
  ...(result.crash ? { crash: result.crash } : {}),
});
function runtimeEnvironment() {
  return {
    target: "wasm32-wasip1",
    runner: "node:wasi",
    nodeVersion: "v26.7.0",
    env: { HOME: virtualHome, TMP: virtualTmp, PWD: virtualTmp, SH: "bash", LC_ALL: "C.UTF-8" },
    stdin: "empty",
    filesystem: "fresh MemoryFs, 16 MiB; no host preopens",
    processHost: "InProcessHost, argv.py and printenv.py fixtures only",
    timeoutMs,
    outputLimitBytes: 4 * 1024 * 1024,
    normalization: [
      [virtualTmp, "$TMP"],
      [virtualHome, "$HOME"],
    ],
    scoring: "stdout bytes and exit status; stderr retained separately, not scored",
  };
}
async function captureOracle(cases, helperDirectory, bashVersion) {
  if (process.version !== runtimeEnvironment().nodeVersion)
    throw new Error(`Capture requires ${runtimeEnvironment().nodeVersion}, got ${process.version}`);
  if (!bashVersion.startsWith("GNU bash, version 5.3.15(1)-release"))
    throw new Error(`Expected GNU bash 5.3.15(1)-release, got ${bashVersion}`);
  const previous = JSON.parse(
    await readFile(resolve(root, "docs/evidence/bash-compatibility.json"), "utf8"),
  );
  const classified = new Map(previous.cases.map((item) => [caseId(item), item]));
  if (classified.size !== cases.length)
    throw new Error("Pinned corpus case count differs from published classification");
  let done = 0;
  const records = await Promise.all(
    cases.map(async (item) => {
      const old = classified.get(caseId(item));
      if (
        !old ||
        old.name !== item.name ||
        Boolean(old.excluded?.startsWith("needs Brush")) !==
          Boolean(item.excluded?.startsWith("needs Brush"))
      )
        throw new Error(`Pinned corpus case differs: ${caseId(item)}`);
      return {
        id: caseId(item),
        corpus: item.corpus,
        file: item.file,
        line: item.line,
        name: item.name,
        category: item.category ?? item.file,
        code: item.code,
        ...(old.kind ? { kind: old.kind } : {}),
        ...(old.excluded ? { excluded: old.excluded } : {}),
        ...(old.needs ? { needs: old.needs } : {}),
      };
    }),
  );
  const path = `${helperDirectory}:/usr/local/bin:/usr/bin:/bin`;
  const preflight = await runShell(bashPath, "printf compat-oracle-ready", path, true);
  if (preflight.status !== 0 || preflight.stdout.toString() !== "compat-oracle-ready")
    throw new Error(`Oracle sandbox preflight failed: ${preflight.stderr.toString()}`);
  await mapLimit(records, jobs, async (item) => {
    if (item.excluded || item.kind !== "builtins-only") return;
    const first = await runShell(bashPath, item.code, path, true);
    const second = await runShell(bashPath, item.code, path, true);
    item.bash = packResult(first);
    if (first.outputLimit || second.outputLimit)
      item.excluded = "fresh bash oracle exceeded 4 MiB output limit";
    else if (first.timeout || second.timeout) item.excluded = "fresh bash oracle timed out";
    else if (!same(first, second)) item.excluded = "fresh bash oracle output is not deterministic";
    if (++done % 250 === 0) log(`fresh bash oracle: ${done}`);
  });
  const oracle = sealOracle({
    schema: 1,
    oracle: {
      version: bashVersion,
      executableSha256: bytesDigest(await readFile(bashPath)),
      captureNode: process.version,
      capturePlatform: process.platform,
      captureArch: process.arch,
      sandbox:
        "bubblewrap unshare-all; /usr read-only; private case home/tmp; no network or owner files",
      classification:
        "Published docs/evidence/bash-compatibility.json builtins-only membership, fresh observations; external and excluded cases retained as skips",
      classificationSha256: bytesDigest(
        await readFile(resolve(root, "docs/evidence/bash-compatibility.json")),
      ),
      helpersSha256: bytesDigest(await readFile(resolve(root, "scripts/bash-compat-helpers.mjs"))),
    },
    environment: runtimeEnvironment(),
    sources: {
      oils: { ...pins.oils, files: sourceFiles.oils },
      "brush-suite": { revision: pins.brush.revision, files: sourceFiles["brush-suite"] },
      "bashkit-suite": {
        revision: pins.bashkitTerminal.revision,
        files: sourceFiles["bashkit-suite"],
      },
    },
    cases: records,
  });
  verifyOracle(oracle);
  await writeRows(oracleFile, oracle);
  log(`wrote fresh oracle ${oracleFile}`);
  console.log(
    JSON.stringify(
      summarize({
        cases: records.map((item) => ({
          ...item,
          outcome: item.excluded || item.kind !== "builtins-only" ? "skip" : "fail",
        })),
      }),
      null,
      2,
    ),
  );
}
async function writeRows(path, value) {
  const rows = value.cases.map((item) => JSON.stringify(item)).join(",\n");
  await writeFile(
    path,
    JSON.stringify({ ...value, cases: "CASES" }, null, 2).replace(
      '"CASES"',
      () => `[\n${rows}\n]`,
    ) + "\n",
  );
}
async function runFrozen() {
  const oracle = JSON.parse(await readFile(oracleFile, "utf8"));
  verifyOracle(oracle);
  if (pins.shellScoreboard?.oracleSha256 !== bytesDigest(await readFile(oracleFile)))
    throw new Error("Fixed oracle checksum differs from sources.lock.json");
  if (
    oracle.sources.oils.revision !== pins.oils.revision ||
    oracle.sources["brush-suite"].revision !== pins.brush.revision ||
    oracle.sources["bashkit-suite"].revision !== pins.bashkitTerminal.revision
  )
    throw new Error("Fixed oracle source pins changed; recapture base and candidate together");
  if (
    digest(oracle.environment) !== digest(runtimeEnvironment()) ||
    process.version !== oracle.environment.nodeVersion
  )
    throw new Error("incomparable runtime environment");
  const baselines = [];
  if (process.env.BASH_COMPAT_RECORD !== "1") {
    const committed = JSON.parse(await readFile(baselineFile, "utf8"));
    baselines.push({ label: "committed baseline", score: committed, requireMembership: true });
    const target = baseBranchBaseline(root, process.env.BASH_COMPAT_BASE_REF);
    if (target) baselines.push({ label: "target branch baseline", score: target });
    for (const baseline of baselines) validateScore(oracle, baseline.score);
  }
  prepareEngines();
  const pool = new Pool("own-shell", jobs);
  pools.push(pool);
  const cases = oracle.cases.map((item) => ({
    id: item.id,
    corpus: item.corpus,
    category: item.category,
    kind: item.kind,
    outcome: "skip",
    ...(item.excluded ? { excluded: item.excluded } : {}),
  }));
  let done = 0;
  await mapLimit(oracle.cases, jobs, async (item, index) => {
    if (item.excluded || item.kind !== "builtins-only") return;
    const actual = normalizeResult(await pool.run(item.code));
    const expected = { status: item.bash.status, stdout: Buffer.from(item.bash.stdout, "base64") };
    const outcome = actual.timeout
      ? "timeout"
      : actual.crash
        ? "crash"
        : same(expected, actual)
          ? "pass"
          : "fail";
    cases[index] = {
      ...cases[index],
      outcome,
      ...(outcome === "pass" ? {} : { actual: compactResult(actual) }),
    };
    if (++done % 250 === 0) log(`own-shell: ${done}`);
  });
  await pool.close();
  const score = {
    identity: oracle.identity,
    engine: "own-shell",
    counts: summarize({ cases }),
    cases,
  };
  validateScore(oracle, score);
  console.log(JSON.stringify({ identity: score.identity, counts: summarize(score) }, null, 2));
  if (process.env.BASH_COMPAT_OUT) await writeRows(output, score);
  let passed = true;
  for (const baseline of baselines) {
    const delta = compareScores(baseline.score, score);
    console.log(JSON.stringify({ baseline: baseline.label, ...delta }, null, 2));
    passed &&= delta.ok;
    if (baseline.requireMembership)
      compareScores(baseline.score, score, { requireMembership: true });
  }
  if (!passed)
    throw new Error("own-shell corpus regression; see gained/lost/newlyFailing cases above");
}

try {
  await main();
} finally {
  for (const kill of activeChildren.keys()) kill();
  await Promise.allSettled(activeChildren.values());
  for (const pool of pools) await pool.close();
  await rm(scratch, { recursive: true, force: true });
  finished = true;
}
