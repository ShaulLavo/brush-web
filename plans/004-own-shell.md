# 004: Our own WASM-first shell

Status: Approved (owner, 2026-10-16)

## Goal

The browser dev environment from plan 001 gets a bash-compatible shell we design ourselves, written for single-threaded `wasm32-wasip1` from the start. It runs real programs (`bun`, `grep`, `sed`) as child processes and streams their output live: `bun dev | grep error` shows each matching line as it happens. Correctness is measured against GNU bash, and the score only goes up.

Brush stays the working shell in this repository until step 6 replaces it.

## Decision

A shell has three parts:

- **Parser:** text to syntax tree. It starts from Bashkit's parser at `491c3281` and changes freely; the parser is ours.
- **Bash rules:** what the syntax means. Variables, quoting, word splitting, expansions, arithmetic, control flow, functions, `set -e`, traps and the state-changing builtins (`cd`, `read`, `declare`, `eval`).
- **Engine:** how commands run. Starting processes, moving bytes between pipeline stages, waiting, Ctrl+C and background jobs.

We write the engine and the interpreter structure ourselves, then port Bashkit's bash rules into that structure one area at a time. Each area is checked against real bash as it lands.

Why not keep Bashkit's interpreter and swap its engine: the spike's low-confidence estimates to reach Brush-level compatibility are 4–9k newly written or substantially changed shell lines for that route, against 8–16k for this plan, both excluding the shared runtime, utility ports and tests. But Bashkit is built as a sandbox for AI agents. Its README promises no process spawning by default, all 167 commands reimplemented in Rust in-process, and scripts that run to completion and return their output. That assumption runs through its interpreter (one `Interpreter` struct with 123 declared fields). The spike found four separate places where output or input is collected whole instead of streamed: the final pipeline stage, generic stdin collection, process substitution and the accumulated result output. Each missed spot would be a pipeline that silently stops streaming, which is Brush's problem again. Porting the rules into a structure built for real processes avoids that. The risk of porting, getting bash rules subtly wrong, is what the compatibility harness measures.

Evidence: `/work/reports/browser-shell-research/own-shell-spike.md` (execution-model proof, Bashkit audit with file:line references, estimates and risks), [docs/bash-compatibility.md](../docs/bash-compatibility.md) (scores), `/work/reports/browser-shell-research/handoff-shell.md` and `handoff-runtime.md`. No Unix fork and no WASIX: neither StackBlitz nor CodeSandbox does fork in the browser, and StackBlitz ships its own shell.

This supersedes plan 001's choice of Brush, its fallback of forking Bashkit, and its steps 1b, 3 and 4. Plan 001 step 2 (one WASI host, OPFS filesystem) continues as the shared runtime work this shell runs on.

## The score

The scoreboard is `npm run compat`: GNU bash 5.3 is the oracle, a case passes when stdout bytes and exit status match, and the interpreter score uses builtins-only cases. Targets to pass, in order:

| Builtins-only corpus | Cases | Brush (browser) | Bashkit source |
| -------------------- | ----: | --------------: | -------------: |
| Oils                 | 1,682 |           78.4% |          95.4% |
| Brush suite          | 1,889 |           70.8% |          84.1% |
| Bashkit suite        | 2,223 |           82.1% |          96.2% |

Brush's numbers after the `$$` fix are 78.5%, 71.2% and 82.3%. The held-out rows are the honest comparison: Bashkit was tuned against Oils and its own suite.

Rules for climbing:

- **Ratchet.** CI records exact pass counts per corpus and per category for the new shell, over an identified fixed case set with a pinned oracle and environment, not rounded percentages. A PR may not lower any corpus's pass count. A case that newly fails needs a named reason in the PR. Runs whose case set, oracle or environment differ are incomparable and rejected; a corpus or oracle change reruns base and candidate under identical inputs, and the baseline update is reviewed explicitly.
- **Every PR states its delta**: cases gained and lost per corpus, from the harness output.
- **Guardrails climb with the score.** A PR that breaks a guardrail is not merged for a score gain.
  - Size: the shell's release WASM, compressed with brotli-11, stays at or under Brush's 1.0 MB (Bashkit's is 2.4 MB).
  - Cold start: with the documented Fast 4G plus DevTools 4× CPU profile, fresh browser profiles, the Canvas renderer and ten cold trials, the median from navigation to painted prompt is at most 100 ms slower than Brush measured in the same run ([docs/cold-start.md](../docs/cold-start.md); Brush measured 2.32 s there).
  - Streaming: all sixteen acceptance tests across the seven scenarios from step 1 stay green.
- **Port, then diverge.** When porting an area, start from Bashkit's implementation and its tests, recording the source path and revision. Do not port its known bugs: the `mapfile` array-budget leak (`/work/reports/upstream-bugs/README.md` #20) and final-stage buffering (#25).

## Steps

0. **Skeleton.** A Rust workspace at `shell/` in this repository (it is extracted with history to `ShaulLavo/bash-web` under the approved sequence below, independently of the future product repository). Start from Bashkit's parser at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT): pin it in `sources.lock.json`, add it to `THIRD_PARTY_NOTICES.md`, and maintain it freely as our own parser. Record local changes alongside that base revision instead of requiring byte identity. Keep its upstream parser tests running in `npm run test:rust`; remove one only for a deliberate behavior change with the reason recorded in the parser change log. The spike's proof (`/work/tmp/own-shell-spike-tloM5o/proof`) is the starting reference, not code to extend blindly: its mock processes, polling reactor and toy commands are replaced.

1. **Engine on real browser workers.** This gate is mandatory before step 6 replaces Brush. Steps 2 and 3 may proceed with tested `ProcessHost` stand-ins, as approved by the owner on 2026-10-16. The interpreter runs on one async executor in one worker: every pipeline stage, subshell and background job is a task. Shell I/O never blocks; the executor parks only when no task can run, and wakes on I/O readiness, child exit or interrupt. File descriptors are a table of reference-counted endpoints: subshells and stages share open endpoints, never copies, so EOF and EPIPE follow the last close. Pipes are bounded (the proof used 32 KiB). Bounded pipes alone do not bound memory: define limits and backpressure, spilling or explicit failure at the terminal and worker queues, command captures, substitutions and accumulating utilities. Command dispatch, loops, expansions and in-process utilities run with bounded work budgets, explicit yields and interrupt checks, because a task that never waits on I/O would otherwise starve every other task. Child processes go through a process-host interface (spawn with argv, environment, cwd and descriptor bindings; wait; kill; nonblocking readiness and exit notifications), implemented on the shared runtime from plan 001 step 2. Until that lands it may use this repository's current process imports, but only after generalizing that host: today it tracks one active child and passes no arbitrary descriptor bindings, so it cannot run Bun-to-Bun pipelines or the inherited-descriptor test. Define the guest-visible broken-pipe contract with the runtime: a child killed by a closed pipe reports 141, but a guest that handles EPIPE keeps its own exit status.

Step 1 includes the minimum production semantics, fixture commands and session interface these tests need (simple functions, redirects, a few builtins). Later steps broaden that implementation; steps 2 and 3 can use the native/WASI stand-ins while this browser gate remains open. Acceptance, in the browser:

- commit `/work/reports/browser-shell-research/pipelines.acceptance.spec.ts` under `tests/`, change it to select the new engine explicitly and assert which engine is running (Brush is still the default), then pass all sixteen tests across its seven scenarios with real `bun` children: live ticker through `grep`, more than 1 MiB in all four builtin/external pairings, Ctrl+C, `pipefail` and `PIPESTATUS`, early reader exit, state inheritance, backpressure;
- Ctrl+C reaches the shell while WASM is running (a shared interrupt word, not a message), interrupts the foreground job and its descendants, confirms their exits, and leaves unrelated background jobs running; shell shutdown cleans up the whole session;
- an always-ready background loop (`while :; do :; done &`) does not stop foreground commands from responding;
- a guest that handles EPIPE and exits with its own status keeps that status;
- a slow terminal and an accumulating consumer stay within the defined memory bounds;
- a non-standard descriptor (`3>&1`, `exec 4<file`) is inherited by a child;
- `bun dev &` returns to the prompt, keeps streaming, and the next command can `kill %1` or `wait` for it.

2. **Scoreboard.** Add the new shell as an engine in `scripts/bash-compat.mjs`, run all three corpora, commit the fixed GNU bash observations and baseline, and wire the exact-count comparison into CI. Target-branch baseline comparison must prevent lowering the candidate baseline from concealing a regression. Expect a low first score; the point is the number. This step can use tested native/WASI process-host stand-ins. The first fixed baseline is 288/1,682 Oils, 295/1,888 Brush-suite and 445/2,222 Bashkit-suite; two fresh GNU bash nondeterminism exclusions reduce the secondary denominators. Exact category counts and case outcomes are committed in `docs/evidence/own-shell-baseline.json`. The historical Brush targets above use their earlier case sets and must be rescored under the same fixed identity before comparison. Candidate baselines must match current per-case pass membership, including gains, while target-branch comparison enforces corpus nonregression.

3. **Climb the bash rules,** in roughly this order, because later areas build on earlier ones. Each area is one or more PRs, each with its score delta:
   1. Words: quoting, parameter expansion, word splitting, pathname expansion, tilde and brace expansion. The fixed case/oracle/environment identity is unchanged across these slices, with no lost passing cases:
      - Quote-aware fields, IFS, empty/positional fields and scalar declaration contexts (#16): Oils 288→291, Brush-suite 295→304, Bashkit-suite 445→452.
      - Lazy scalar default/alternative operators and owned-parser quote fixes (#17): Oils 291→305, Brush-suite 304→322, Bashkit-suite 452→479.
      - Scalar assignment/error operators, durable side effects, fatal-error isolation, source-aware diagnostics and post-expansion IFS splitting (#18): Oils 305→314, Brush-suite 322→328, Bashkit-suite 479→492. Diagnostic descriptor ownership ends before dispatch so early consumer closes still deliver EPIPE. Clean startup sets nonexported IFS once; typed lexical metadata retains individual escaped-character protection through deferred splitting.
      - Scalar length for ordinary names, positive positions, status and positional count (#20): Oils 314→322, Brush-suite 328→332, Bashkit-suite 492→505. UTF-8 locales count Unicode scalar values; C/POSIX and unrecognized locales count bytes. Input snapshots, decimal output and counting share the existing bounds and cancellation budget.
      - Scalar prefix/suffix pattern removal with bounded cooperative matching (#21): Oils 322→340, Brush-suite 332→333, Bashkit-suite 505→528. Shortest/longest scalar trims preserve inner pattern quotes, outer result protection and final-IFS effects; matcher exhaustion fails explicitly without partial results or candidate-string allocation.
      - Scalar case modification with ordinary identifiers and `^`, `^^`, `,`, `,,` (#23): Oils 340→345, Brush-suite 333→334, Bashkit-suite 528→539. C/POSIX ASCII and C.UTF-8/C.utf8 Latin-1 input mappings reuse bounded single-character pattern matching; full Unicode and locale collation remain deferred. Matcher and mapping capacities are admitted before allocation, with shared work bounds and cancellation.
      - Scalar one-level indirection on ordinary names (`${!v}` and the eight scalar conditional operators) (#24): Oils 345→350, Brush-suite 334→335, Bashkit-suite 539→548. Pointer and target snapshots are bounded before copying; invalid pointers fail with fatal status 1, while valid unset targets remain distinct. Arrays, namerefs, special names and generic indirect suffixes remain deferred.
      - Scalar replacement on ordinary names (`${v/p/r}`, `${v//p/r}`, `${v/#p/r}`, `${v/%p/r}`) (#25): Oils 350→379, Brush-suite 335→338, Bashkit-suite 548→584. Leftmost-longest basic-pattern search, lazy operands, typed ampersand protection, final-IFS behavior and shared raw/storage/work/field bounds are preserved; arrays, namerefs, options, locale collation and unsupported pattern forms remain deferred.
      - Scalar arithmetic, positional/scalar slices, readonly writes and read-unit error recovery (#28): Oils 380→481, Brush-suite 340→384, Bashkit-suite 595→754, with no lost cases. Boxed arithmetic futures and explicit scalar depth bounds retain native/WASI stack safety; staged shell-boundary checks preserve Bash error status before lazy evaluation.
      - Brace lists and numeric/ASCII-letter ranges (#29): Oils 481→525, Brush-suite 384→394, Bashkit-suite 754→785, with no lost cases; brace generator seeds 1/42 match Bash on 5,318 cases each. Fused `$((`/`<((` spans end by raw parenthesis matching and are classified by `chk_arithsub`; other substitution bodies (also inside `${…}` operands and raw `$((` text) are parsed with the script and fail with status 127, strictly separated. Nested parses run after each word's scan loop (debug stack per nesting level ~21 KB→~7 KB). Brace temporaries are charged by peak storage; the default argument count is 65,536. Follow-ups owned by later units: running `UnparsedCommandSubstitution` (a non-arithmetic `$((` whose text fails to parse) at expansion with status 2 belongs to command substitution; prefix assignments on function calls (`TEMP=x f`) remain unsupported and belong to functions/locals.
      - Remaining parameter operators, pathname, tilde and brace expansion follow before command substitution. After scalar arithmetic, the next focused word unit is bounded brace lists and numeric/ASCII-letter ranges, preserving quoted punctuation and opaque expansion parts; tilde stays separate. The pinned reference is Bashkit's `crates/bashkit/src/interpreter/brace_expansion.rs`, but resource exhaustion must fail explicitly rather than silently return a literal or partial result.
   2. Command substitution and arithmetic. Scalar arithmetic is the next foundation rather than a constant-only substring implementation: offsets and lengths are arithmetic expressions, so the same bounded evaluator serves `$((...))`, `((...))`, `let` and scalar slices. Command substitution follows separately and must use bounded captures without changing streaming command execution.
   3. Control flow: `if`, `for`, `while`, `until`, `case`, `[[ ]]`, `test`, `&&`/`||`, `!`, `set -e` and its exceptions.
   4. Functions, `local`, positional parameters, `return`, `shift`, `set --`. Ordinary function calls share the caller's state. Asynchronous lists and subshell environments get an isolated copy, and so do pipeline stages, except the last stage under bash's `lastpipe` rules. Local, positional and trap frames unwind correctly when a task is cancelled. (The spike caught a wrong copy once.)
   5. Redirects and here-docs, including `exec` descriptor changes.
   6. State-changing builtins: `cd`, `pwd`, `export`, `unset`, `declare`/`typeset`, `readonly`, `read`, `mapfile`, `printf`, `echo`, `eval`, `source`, `type`, `command`, `getopts`, `shopt`, `set`.
      - Resolved in engine 0.0.13: `printf` repeats consuming formats until arguments run out and emits non-consuming formats once. Direct and split-field regressions cover the behavior, and the parameter fuzzer now captures fields with the repeating format instead of its temporary `argv.py` helpers.
   7. Arrays, associative arrays and namerefs.
   8. Traps (`EXIT`, `ERR`, `DEBUG`, `RETURN`, signals) and aliases.
   9. Process substitution `<(…)` `>(…)` and coprocesses, as live descriptors, never captured text.
   10. Job control builtins: `jobs`, `fg`, `bg`, `wait`, `kill`, `disown`.

4. **Utilities.** Commands that don't change shell state are separate WASI programs started through the process host, starting with a uutils multicall binary plus `grep`, `sed`, `awk` and `jq`. Measure spawn cost per command (brush-web measured about 18 ms per warm child). Where loops make it hurt, add in-process versions of the hottest tools (`cat`, `head`, `tr`, `wc`, `grep`) as tasks on the engine's streaming descriptors. The "cases needing external commands" rows of `npm run compat` track this.

5. **Interactive session.** Prompt, completion requests from the terminal, history, Ctrl+C and Ctrl+Z at the prompt, `$?` carried between commands, `exit`. The terminal owns line editing.

6. **Replace Brush.** When the new shell beats Brush on all three corpora, passes every acceptance test and guardrail, and runs on a live shared filesystem (plan 001 step 2, or equivalent demonstrated coherence: running children see editor and shell writes, and sibling processes see each other's writes, before anyone exits), make it the workbench's default shell. Brush stays selectable for comparison until Bashkit's held-out scores are also passed.

## Out of scope here

The runtime itself (plan 001 step 2 and `handoff-runtime.md`), the terminal choice, the product's look and its repository.

## Follow-up: IFS snapshot storage admission

Status: Approved. Fold this into the immediately ordered ANSI-C word unit below,
before adding more allocation paths. This was found during arithmetic review and predates that PR.

`Ifs::new` in `shell/engine/src/expand.rs` copies the IFS string and inserts
characters into a `BTreeSet` without calling `Work::admit_storage`. It checks
`max_raw` before the string copy and checkpoints character work, but those checks
do not reserve temporary storage. The same implementation is present on main
`2342019`; inspect it with
`git show 2342019:shell/engine/src/expand.rs` around `impl Ifs`.
At arithmetic head `49b255a`, the function starts at line 250. This is a
source-confirmed accounting gap; the allocation-boundary test below has not yet
been added or run. No crash, corpus regression, or timing claim is implied.

Start with a private `expand::tests` test that creates default shared state,
sets IFS to `:`, creates `Work::new(64, 0, 1)` and `Cancel::new()`, then calls
`Ifs::new(&state, &cancel, 64, &mut work).now_or_never()`. Under the current code
this path copies the string and inserts the delimiter without checking the zero
storage allowance. Assert explicit status 2 at that boundary, then cover exact
admission, duplicate characters, empty/default IFS, large IFS, and cancellation.
Run the focused test through the shared queue with the pinned Rust toolchain.

Fix the representation and admission together. Preserve tiny expansion budgets
for default IFS and literal or protected words; blindly charging heap nodes on
every word can reject cases that need no owned IFS storage. Keep literal
protection, final-IFS updates, list separators, and Unicode delimiter semantics.
Run all native/WASI word tests, regenerate word fixtures 1/42 independently and
diff byte-for-byte, and require zero lost fixed-corpus cases. Own and clean any
task-created targets and scratch under the usual lane rules.

## Next word unit: ANSI-C operands and two-phase parameter extraction

Status: Approved. This is the **very next unit after brace expansion merges**,
including the IFS storage-admission follow-up above before adding allocation
paths. It is not a CI exemption.

Brace controls exposed an existing scalar-parameter bug, independent of braces.
The first reproduction is:

```bash
printf '<%s>\n' "${u:-$'\''}"
```

Confirmed with a fresh native release build of exact main
`5deb70ddcee9ec82e208168455a760f9544867a2`: GNU Bash 5.3.15 exits **1**
with no stdout; main exits **0**, stdout bytes `3c273e0a` (an apostrophe field).
The detached proof worktree and build output were removed after measurement.
The brace lane records the same evidence in the PR. These additional operand spellings exercise the same phase:

```bash
v=SET; printf '<%s>\n' "${v:-$'\''}"
printf '<%s>\n' "${u:-$'\x27'}"
printf '<%s>\n' "${u:-$'\x27\x27'}"
v=VALUE; printf '<%s>\n' "${u:-$'$v'}"
v=SET; printf '<%s>\n' "${v:-$'}'}"
printf '<%s>\n' "${u:-$'\x22'}"
```

Decoded apostrophes affect extraction even when the operand is unselected;
decoded `}` can end the parameter early, decoded `$` expands, and decoded
double quotes affect expansion-time quoting without becoming original shell
syntax. In contrast, unquoted ANSI-C operands retain literal protection.

**First step:** extend `scripts/fuzz-shell-words.mjs` to generate `$'…'` and
decoded specials (apostrophes, braces, dollars, double quotes, escapes, empty
text) in **every operator's operand**, both quoted and unquoted, selected and
unselected. Existing seeds 1/42 do not reach this phase. Run Bash self-controls
and failing-first comparisons before implementation; retain exact status and
stdout observations, including Bash failures. No unsupported/CI exemptions.

Implement general **two-phase parameter extraction**, not quote-specific
patches or raw decoded-text insertion into the outer shell grammar. Inspect
`shell/parser/src/parser/lexer.rs` (`read_parameter_body` and ANSI-C decoding),
`shell/parser/src/parser/parameter_scan.rs`, parameter extraction in
`shell/parser/src/parser/mod.rs`, and lazy operand decoding in
`shell/engine/src/expand/operand.rs`. Keep early shell-word syntax separate
from later extraction, preserve storage/work/raw admission and cancellation,
regenerate all affected fixtures with independent byte comparison, and run the
full native/WASI suites and per-case score ratchet before pushing.

## Follow-up: redirect word expansion contexts

Status: Approved. After the immediately ordered ANSI-C unit and the IFS
admission fix, handle redirect-target contexts separately from scalar assignment
RHSs. Current `interpreter.rs::redirects` calls `expand::word` (scalar), which
intentionally suppresses brace expansion and field splitting. Reproducer:
`echo hi >/dev/null{1,2}`. Bash 5.3.15 reports an ambiguous redirect/status 1;
our memory filesystem instead receives a literal `/dev/null{1,2}` filename.
Start with generator controls for redirect brace lists/ranges, quoted and
escaped variants, parameter/IFS splitting, zero/one/multiple fields, and
side-effect order. Do not run host-writing controls except in an owned scratch
filesystem. Then introduce a redirect-specific expansion contract with correct
ambiguity diagnostics, preserving scalar assignments/declarations. Confirm
Bash results before implementation, run full native/WASI tests and exact pass
membership ratchet, and keep zero CI exemptions.

## Approved extraction: public `ShaulLavo/bash-web`, with history

Status: Approved (owner, 2026-10-17). **Scheduled after the oracle/harness PR
merges, then the command/process-substitution PR merges. The root coordinator
owns the extraction; lanes do not create the repository or move files now.**
The destination is the public repository `https://github.com/ShaulLavo/bash-web`.
This is a history-preserving move, not a snapshot copy or a new shell rewrite.

The shell becomes an independently maintained parser/interpreter/engine package.
The shared WASI/browser runtime remains a **separate package that the product
pulls in**, alongside the shell; it is not moved into the destination shell
repository or absorbed into the shell. Preserve the `ProcessHost`, `HostEndpoint`, `FileSystem` and
session/executor boundaries documented in `shell/engine/README.md`. The current
in-process host is still a fixture, not browser integration. Extraction does not
waive step 1's browser-worker gate or authorize replacing Brush before step 6.

### Ordered execution

1. Verify both prerequisite PRs are merged on the host and record their merge
   commits. Fetch the resulting `origin/main`; inventory **that merged tree**,
   not the current shared worktree. The oracle/harness work changes transport,
   oracle metadata/identity, baseline and tests, while the substitution work adds
   generator coverage. Preserve those final versions together.
2. In a root-owned migration lane, perform a history-preserving extraction of
   `shell/` **and the outside-shell paths below**. Retain their earlier changes,
   the original source-repository/base identity and the extraction commit map;
   do not squash the shell into a single initial commit. A shell-only subtree
   export is insufficient because it loses verification, licenses and pins.
   Create/publish the destination only at this step, after both merges.
3. Initially keep `shell/`, `scripts/`, `sources.lock.json` and
   `docs/evidence/` at their existing relative paths. Normalize paths only in a
   separately reviewed change that updates every executable reference. Preserve
   frozen oracle and generator fixture bytes; a repository rename is not a
   reason to recapture expected results, reset the ratchet or regenerate seeds.
4. Adapt the root manifests, shell-only CI and notices as inventoried below.
   Make the standalone default select only `own-shell`; retain browser/reference
   engine comparisons in the host or behind an explicit optional integration,
   not as an implicit download/build dependency of standalone verification.
5. From a clean destination checkout, run the final merged parser/provenance,
   native/WASI, size, runner/scoreboard, generator-replay and fixed per-case
   ratchet gates. On this host use the shared heavy-job queue and SSD-backed
   targets/scratch. Verify that frozen replay needs no corpus caches, installed
   oracle or browser assets. Root owns CI/review/merge and checks the resulting
   destination history and post-merge gates; this note does not run those jobs.
6. Update the old host's shell ownership/consumption and documentation to point
   to the destination rather than leave two writable copies. The future product
   consumes the shell and the separate runtime packages; terminal/UI work and
   runtime implementation remain outside this extraction. Remove migration
   scratch and task-created caches after their consumers stop, preserving shared
   caches and requested evidence.

### Outside-shell dependency inventory

Paths below are relative to this repository root. They are the initial
extraction checklist, to be reconciled with the final two merged PRs. The Rust
workspace itself has no outside-shell path dependency: the engine's local crate
reference is `../parser`; its tests use Cargo's own binary fixture. The missing
pieces are build policy, verification, frozen inputs and provenance.

| Area | Carry with history, or explicitly adapt |
| --- | --- |
| Rust build policy | `rust-toolchain.toml` (Rust **1.98.1**, rustfmt, `wasm32-wasip1`); `.cargo/config.toml` (WASI maximum memory **268435456**); retain `shell/Cargo.toml`, `shell/Cargo.lock`, both crates, READMEs and `shell/parser/LICENSE`. Keep `.build/shell` artifact paths initially. |
| Main compatibility runner | `scripts/bash-compat.mjs`, `bash-compat-worker.mjs`, `bash-compat-helpers.mjs`, `shell-scoreboard.mjs`, `shell-scoreboard-base.mjs`. The entry point imports the helper, runner and scoreboard modules and starts the worker by filename; the worker imports the helpers. Preserve `git show` target-baseline reads. |
| Oracle transport from the prerequisite PR | `scripts/bash-compat-runner.mjs`, `bash-compat-pipe.py`, `audit-bash-oracle-pipe.mjs`, `test-bash-compat-runner.mjs`. These were new/untracked during this inventory; take their committed merged versions. The runner spawns the Python file, including a separate exit-status fd; do not replace its real independent stdout/stderr pipes with direct Node `spawn` transport. The audit imports the helpers, runner and scoreboard. |
| Runner/ratchet tests | `scripts/test-shell-scoreboard.mjs`, `test-shell-scoreboard-base.mjs`, `test-compat-selection.mjs`, `test-own-shell-runner.mjs`, plus the transport runner test above. The own-shell runner test starts `bash-compat-worker.mjs` by filename; tests also depend on the existing evidence/manifest paths. |
| Parser/WASI checks | `scripts/check-shell-parser.mjs` and `scripts/test-shell-wasi.mjs`. The provenance check reads `sources.lock.json` and its `shellParser.directory` license. The WASI check owns streaming acceptance and the brotli-11 **1,000,000-byte** release ceiling; do not lose it when removing browser tooling. |
| Differential generators | `scripts/fuzz-shell-words.mjs`, `fuzz-shell-readonly.mjs`, `fuzz-shell-arithmetic.mjs`, `fuzz-shell-parse-boundaries.mjs`, `fuzz-shell-braces.mjs`, `fuzz-shell-substitution-boundaries.mjs`; `scripts/test-fuzz-shell-braces.mjs`, `test-fuzz-shell-substitution-boundaries.mjs` import their corresponding generators. Carry/adapt the shell instructions from `scripts/README.md`. All six generators use Node built-ins. |
| Seed fixtures | Under `scripts/fixtures/`: `shell-words-seed-1.json`, `shell-words-seed-42.json`, `shell-readonly-seed-17.json`, `shell-arithmetic-seed-7.json`, `shell-arithmetic-seed-314.json`, `shell-parse-boundaries.json`, `shell-braces-seed-1.json`, `shell-braces-seed-42.json`. Add the substitution PR's final `shell-substitutions-seed-1.json` and `shell-substitutions-seed-42.json` once committed; they did not yet exist at inventory time. Inventory all additional merged fixtures rather than synthesizing missing files during extraction. |
| Frozen scoreboard and capture classification | `docs/evidence/own-shell-oracle.json`, `own-shell-baseline.json`, **and** `bash-compatibility.json`. The latter preserves capture's historical case classifications and its hash, even though normal frozen replay does not read it. Carry `docs/evidence/licenses/oils-LICENSE.txt` and `brush-MIT.txt`; Bashkit's retained MIT license is `shell/parser/LICENSE`. |
| Source/provenance manifest | Adapt `sources.lock.json`, preserving `shellParser`, `shellScoreboard`, `shellWords`, `shellParameterDefaults`, `shellParameterEffects`, `shellParameterLength`, `shellParameterTrim`, `shellParameterCase`, `shellParameterIndirect`, `shellParameterReplace`, `shellArithmetic`, `shellBraces`, and any shell entries added by the prerequisite PRs, with complete classifications/change records. Also retain the corpus pins under top-level **`oils`, `brush`, `bashkitTerminal`**: executable frozen validation reads them, not only `shellScoreboard.corpora`. |
| Licenses/notices | Retain the root `LICENSE` and shell-relevant sections of `THIRD_PARTY_NOTICES.md`, including every adapted implementation/test and original-adapter distinction. Extract a shell-only `scripts/notices.mjs` flow that includes the pinned parser license, actual Cargo dependency licenses and retained corpus licenses. The current generator also reads the Brush browser workspace, terminal/Bun/Bashkit distributions, npm lock and `.sources` notices, so it cannot be copied unchanged as the standalone build command. Preserve a distributed generated notice file and update its README links. |
| Documentation | Carry/adapt `docs/bash-compatibility.md` (method, identities, capture/replay, ratchet and generator sections), this plan, `shell/README.md` and `shell/engine/README.md`; fix root-relative links. Keep historical Brush/Bashkit comparisons and original commit/CI links explicitly historical, not fresh standalone measurements. Product/browser architecture, performance and cold-start pages remain host documentation; link them where their acceptance criteria still apply. |
| Root JS/configuration | Create a shell-only `package.json`/`package-lock.json` adaptation, preserving Node **26.7.0** and the named shell scripts below. Frozen replay/generators need no npm packages. Capture additionally needs `yaml` (currently **2.9.1**); keep it reproducible when that operation is retained. Carry/adapt `.gitignore`, `.gitattributes` and `.oxfmtrc.json` if their rules are used. Do not inherit frontend `verify`, `build`, `sources`, or Brush-chained `test:rust` commands unchanged. |
| CI | Extract/adapt `.github/workflows/ci.yml`'s `shell` and `own-shell-compatibility` jobs, plus the prerequisite PR's final transport/audit steps. Preserve Node **26.7.0**, Rust **1.98.1**, wasmtime **v49.0.3**, rustfmt, the WASI target, locked native/WASI builds, bounded `-j2` CI work, generator tests/replays, score artifacts and exact target-branch checks. Preserve full checkout history (`fetch-depth: 0`) for baseline comparisons and adapt the Rust cache workspace to the retained paths. Do not pull in the frontend/browser/reference-engine `verify` job. |

The standalone package scripts must retain `build:shell`, `test:shell:wasi`,
`test:shell:scoreboard`, `compat:shell`, all `fuzz:shell-*` and their `:ci`
replay commands, and `test:fuzz-shell-braces`/`test:fuzz-shell-substitutions`.
Use the final merged scoreboard test list, including the oracle runner tests;
replace `test:rust` with the shell-only provenance and locked workspace tests.
The native generator binary is `.build/shell/release/shell-engine`; WASI replay
uses `.build/shell/wasm32-wasip1/release/shell-engine.wasm`.

### Frozen inputs, maintenance setup and migration traps

- Preserve these exact corpus revisions and their retained license/hash records:
  Oils `bdc8364c253ce921e033bbc2399ea2ce0be41825`,
  Brush `4cfba081f2f8bcda8150010a57203d020f14f0cc`, and
  Bashkit/parser `491c3281f668b76d64b15210b8f5d7bf97244be0`.
  Inputs are respectively `spec/*.test.sh`,
  `brush-shell/tests/cases/compat/**/*.yaml`, and
  `crates/bashkit/tests/spec_cases/bash/*.test.sh` excluding Oils/just-bash ports.
  Keep archive checksums in the manifest, not freshly downloaded substitutes.
- Normal frozen replay reads committed observations only: no corpus downloads,
  GNU Bash execution, browser runtime or comparison-engine builds. Capture is a
  separate explicit maintenance operation requiring Linux, GNU Bash
  **5.3.15(1)-release**, bubblewrap with functioning namespaces, `/usr/bin/python3`
  (standard library, including Unix `fcntl`/`termios`), `yaml` and all pinned
  corpus sources. The exact Node version and environment digest remain identity
  requirements. Preserve both streams as exact bytes; only stdout/status score.
- Add a **corpus-only preparation path**, not an engine build. Oils currently
  uses `.sources/oils` with `.revision`/archive checks; Brush defaults to
  `vendor/brush` or `BASH_COMPAT_BRUSH_DIR`; Bashkit defaults to `.sources/bashkit`
  or `BASH_COMPAT_BASHKIT_DIR`. Extract only the pinned fetch/check/extract part
  of `scripts/build-bashkit.mjs` for Bashkit corpus setup. Do not invoke the full
  build. `scripts/sources.mjs` also fetches the terminal and initializes Brush;
  it is not suitable standalone setup. Cached source directories and downloaded
  binaries are not files to commit/import with the shell.
- Preserve generator **source bytes** as well as fixture bytes. Each fixture
  pins the SHA-256 of its whole generator, so even renaming a comment, queue
  label or default path invalidates it. Any necessary generator edit requires
  an explicit reviewed fixture-identity migration, not silent regeneration as
  part of the repository move. Preserve all existing pass membership; source,
  case/oracle/environment changes require the documented base/candidate rerun.
- Several defaults are machine-local: optional self-queuing through
  `/work/tmp/wave-heavy/run.sh`; the words generator's automatic build uses
  `/work/cache/cargo/bin/cargo` and local Cargo/Rustup homes. Pass `--shell` to
  use the prebuilt native binary without invoking that path. Keep Node-only
  replay portable; document local queue integration separately without changing
  pinned generator bytes incidentally.
- Keep `BASH_COMPAT_MODE=frozen`, `BASH_COMPAT_ENGINES=own-shell`,
  `BASH_COMPAT_SKIP_BUILD=1` after the explicit build, and `BASH_COMPAT_RECORD=0`
  in compatibility CI. `BASH_COMPAT_SHELL_WASM` can select the existing artifact.
  `BASH_COMPAT_BASE_REF` must be a full commit SHA **present in destination
  history**, not a source-host PR base SHA; target baseline/manifest reads still
  use their committed paths. Never bootstrap a new weaker baseline just because
  the repository name changed.
- Explicitly own scratch/results: `BASH_COMPAT_SCRATCH`, generator `FUZZ_*_SCRATCH`
  and `RUNNER_TEMP` must resolve to suitable storage; local heavyweight work
  belongs on `/work`. Audit/runner tests currently contain task-specific
  `/work/tmp/brush-web-climb-subst` defaults to revisit in their final merged
  versions. Substitution mismatch output survives outside its per-run scratch
  intentionally, so record a retention/cleanup owner. Do not copy `.build`,
  `.sources`, `node_modules`, `.scratch`, browser profiles or reference binaries
  into the destination.
- Leave terminal, Bun payloads, browser UI, browser process/runtime adapters,
  measurements and reference-engine build scripts in the host. The worker's
  optional `just-bash`/Bashkit imports and the entry point's default all-engine
  live mode otherwise reintroduce those dependencies; adapt selection explicitly
  before calling the standalone harness independent. The product's separate
  runtime package remains the owner of actual browser transport/filesystems.
