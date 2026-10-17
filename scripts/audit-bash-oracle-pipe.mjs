// Read-only audit: keep membership/source identity, observe every eligible frozen script.
// Run through the host's heavy-job runner. No engine builds or oracle writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pythonHelpers } from "./bash-compat-helpers.mjs";
import {
  bashStderrTransport,
  bashStdoutTransport,
  createShellRunner,
} from "./bash-compat-runner.mjs";
import { bytesDigest, digest, verifyOracle } from "./shell-scoreboard.mjs";

const root = resolve(import.meta.dirname, "..");
const oraclePath = resolve(
  root,
  process.env.BASH_COMPAT_ORACLE ?? "docs/evidence/own-shell-oracle.json",
);
const destination = resolve(
  process.env.BASH_ORACLE_AUDIT_OUT ?? "/work/tmp/brush-web-climb-subst/oracle-pipe-audit.json",
);
const scratchRoot =
  process.env.BASH_COMPAT_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp/brush-web-climb-subst";
const shell = process.env.BASH_COMPAT_BASH ?? "/usr/bin/bash";
const jobs = Number(process.env.BASH_COMPAT_JOBS ?? 4);
assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= 32, "jobs must be 1..32");
const inputStat = await stat(oraclePath);
const outputStat = await stat(destination).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
assert.ok(
  !outputStat || outputStat.dev !== inputStat.dev || outputStat.ino !== inputStat.ino,
  "Audit output must not alias its frozen oracle input",
);
const originalBytes = await readFile(oraclePath);
const oracle = JSON.parse(originalBytes);
verifyOracle(oracle);
const eligible = oracle.cases.filter((item) => !item.excluded && item.kind === "builtins-only");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, "audit-"));
const activeChildren = new Map();
let cancelled = false;
const killAll = () => {
  for (const kill of activeChildren.keys()) kill();
};
// Signals enter awaited teardown; scratch is never removed ahead of its consumers.
const stop = (status) => {
  cancelled = true;
  process.exitCode = status;
  killAll();
};
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("exit", killAll);
const pack = (value) => ({
  status: value.status,
  stdout: value.stdout.toString("base64"),
  stderr: value.stderr.toString("base64"),
  ...(value.timeout ? { timeout: true } : {}),
  ...(value.outputLimit ? { outputLimit: true } : {}),
});
const same = (first, second) => first.status === second.status && first.stdout === second.stdout;
const sameAll = (first, second) =>
  same(first, second) &&
  first.stderr === second.stderr &&
  Boolean(first.timeout) === Boolean(second.timeout) &&
  Boolean(first.outputLimit) === Boolean(second.outputLimit);
const observed = new Array(eligible.length);
let workers = [];
try {
  const helpers = resolve(scratch, "helpers");
  await mkdir(helpers);
  for (const [name, source] of Object.entries(pythonHelpers)) {
    await writeFile(resolve(helpers, name), source);
    await chmod(resolve(helpers, name), 0o755);
  }
  const runShell = createShellRunner({
    scratch,
    timeoutMs: oracle.environment.timeoutMs,
    activeChildren,
  });
  const path = `${helpers}:/usr/local/bin:/usr/bin:/bin`;
  assert.ok(!cancelled, "audit interrupted");
  const preflight = await runShell(
    shell,
    "printf compat-oracle-ready >/dev/stdout; exit 37",
    path,
    true,
  );
  assert.equal(
    preflight.status,
    37,
    `real-pipe preflight must retain Bash's exit status; stderr: ${preflight.stderr.toString()}`,
  );
  assert.equal(preflight.stdout.toString(), "compat-oracle-ready");
  const version = execFileSync(shell, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const executableSha256 = bytesDigest(await readFile(shell));
  console.error(
    `[oracle-pipe-audit] ${eligible.length} eligible; ${version}; sha256=${executableSha256}`,
  );
  let next = 0;
  let done = 0;
  workers = Array.from({ length: jobs }, async () => {
    while (!cancelled && next < eligible.length) {
      const index = next++;
      const item = eligible[index];
      const pipe = pack(await runShell(shell, item.code, path, true));
      if (cancelled) return;
      const repeat = pack(await runShell(shell, item.code, path, true));
      if (cancelled) return;
      const socket = pack(await runShell(shell, item.code, path, true, "socket"));
      if (cancelled) return;
      observed[index] = {
        id: item.id,
        pipe,
        // Only store duplicate captures when they differ; otherwise their full digest proves identity.
        repeatSha256: digest(repeat),
        ...(sameAll(pipe, repeat) ? {} : { repeat }),
        socket,
        stdoutStatusChanged: !same(item.bash, pipe),
        stderrChanged: item.bash.stderr !== pipe.stderr,
        transportChanged: !same(socket, pipe),
        socketMatchesFrozen: same(socket, item.bash),
        deterministic: same(pipe, repeat),
        stderrDeterministic: pipe.stderr === repeat.stderr,
      };
      if (++done % 250 === 0) console.error(`[oracle-pipe-audit] ${done}/${eligible.length}`);
    }
  });
  await Promise.all(workers);
  assert.ok(!cancelled, "audit interrupted");
  assert.equal(
    bytesDigest(await readFile(oraclePath)),
    bytesDigest(originalBytes),
    "audit changed its frozen input",
  );
  const changed = observed.filter((item) => item.stdoutStatusChanged).map((item) => item.id);
  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    originalOracleSha256: bytesDigest(originalBytes),
    originalIdentity: oracle.identity,
    originalOracle: oracle.oracle,
    currentOracle: {
      version,
      executableSha256,
      executableMatchesFrozen: executableSha256 === oracle.oracle.executableSha256,
      captureNode: process.version,
      capturePlatform: process.platform,
      captureArch: process.arch,
      stdoutTransport: bashStdoutTransport,
      stderrTransport: bashStderrTransport,
      sandbox: oracle.oracle.sandbox,
      helpersSha256: bytesDigest(await readFile(resolve(root, "scripts/bash-compat-helpers.mjs"))),
    },
    environment: oracle.environment,
    sourceIdentity: oracle.identity.sources,
    membershipIdentity: oracle.identity.caseSet,
    normalization:
      "Exact bytes in base64 after per-case tmp/home replacement, identical to original capture; stderr separate and unscored",
    eligible: eligible.length,
    skipped: oracle.cases.length - eligible.length,
    changed,
    transportChanged: observed.filter((item) => item.transportChanged).map((item) => item.id),
    socketDiffersFromFrozen: observed
      .filter((item) => !item.socketMatchesFrozen)
      .map((item) => item.id),
    nondeterministic: observed.filter((item) => !item.deterministic).map((item) => item.id),
    stderrNondeterministic: observed
      .filter((item) => !item.stderrDeterministic)
      .map((item) => item.id),
    incomplete: observed
      .filter(
        (item) =>
          item.pipe.timeout ||
          item.pipe.outputLimit ||
          item.repeat?.timeout ||
          item.repeat?.outputLimit ||
          item.socket.timeout ||
          item.socket.outputLimit,
      )
      .map((item) => item.id),
    cases: observed,
  };
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        output: destination,
        eligible: report.eligible,
        changed,
        transportChanged: report.transportChanged,
        socketDiffersFromFrozen: report.socketDiffersFromFrozen,
        nondeterministic: report.nondeterministic,
        incomplete: report.incomplete,
      },
      null,
      2,
    ),
  );
  if (report.incomplete.length || report.nondeterministic.length) process.exitCode = 1;
} catch (error) {
  if (!cancelled) throw error;
  console.error("oracle audit interrupted");
} finally {
  cancelled = true;
  killAll();
  await Promise.allSettled(workers);
  await Promise.allSettled(activeChildren.values());
  assert.equal(activeChildren.size, 0, `audit consumers remain; scratch retained at ${scratch}`);
  await rm(scratch, { recursive: true, force: true });
}
