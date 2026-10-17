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

0. **Skeleton.** A Rust workspace at `shell/` in this repository (it moves with the product repository later). Start from Bashkit's parser at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT): pin it in `sources.lock.json`, add it to `THIRD_PARTY_NOTICES.md`, and maintain it freely as our own parser. Record local changes alongside that base revision instead of requiring byte identity. Keep its upstream parser tests running in `npm run test:rust`; remove one only for a deliberate behavior change with the reason recorded in the parser change log. The spike's proof (`/work/tmp/own-shell-spike-tloM5o/proof`) is the starting reference, not code to extend blindly: its mock processes, polling reactor and toy commands are replaced.

1. **Engine on real browser workers.** This gate is mandatory before step 6 replaces Brush. Steps 2 and 3 may proceed with tested `ProcessHost` stand-ins, as approved by the owner on 2026-10-16. The interpreter runs on one async executor in one worker: every pipeline stage, subshell and background job is a task. Shell I/O never blocks; the executor parks only when no task can run, and wakes on I/O readiness, child exit or interrupt. File descriptors are a table of reference-counted endpoints: subshells and stages share open endpoints, never copies, so EOF and EPIPE follow the last close. Pipes are bounded (the proof used 32 KiB). Bounded pipes alone do not bound memory: define limits and backpressure, spilling or explicit failure at the terminal and worker queues, command captures, substitutions and accumulating utilities. Command dispatch, loops, expansions and in-process utilities run with bounded work budgets, explicit yields and interrupt checks, because a task that never waits on I/O would otherwise starve every other task. Child processes go through a process-host interface (spawn with argv, environment, cwd and descriptor bindings; wait; kill; nonblocking readiness and exit notifications), implemented on the shared runtime from plan 001 step 2. Until that lands it may use this repository's current process imports, but only after generalizing that host: today it tracks one active child and passes no arbitrary descriptor bindings, so it cannot run Bun-to-Bun pipelines or the inherited-descriptor test. Define the guest-visible broken-pipe contract with the runtime: a child killed by a closed pipe reports 141, but a guest that handles EPIPE keeps its own exit status.

Step 1 includes the minimum production semantics, fixture commands and session interface these tests need (simple functions, redirects, a few builtins). Later steps broaden that implementation; steps 2 and 3 can use the native/WASI stand-ins while this browser gate remains open. Acceptance, in the browser:

- commit `/work/reports/browser-shell-research/pipelines.acceptance.spec.ts` under `tests/`, change it to select the new engine explicitly and assert which engine is running (Brush is still the default), then pass all sixteen tests across its seven scenarios with real `bun` children: live ticker through `grep`, more than 1 MiB in all four builtin/external pairings, Ctrl+C, `pipefail` and `PIPESTATUS`, early reader exit, state inheritance, backpressure;
- Ctrl+C reaches the shell while WASM is running (a shared interrupt word, not a message), interrupts the foreground job and its descendants, confirms their exits, and leaves unrelated background jobs running; shell shutdown cleans up the whole session;
- an always-ready background loop (`while :; do :; done &`) does not stop foreground commands from responding;
- a guest that handles EPIPE and exits with its own status keeps that status;
- a slow terminal and an accumulating consumer stay within the defined memory bounds;
- a non-standard descriptor (`3>&1`, `exec 4<file`) is inherited by a child;
- `bun dev &` returns to the prompt, keeps streaming, and the next command can `kill %1` or `wait` for it.

**Acceptance-only utilities (2026-10-17, Approved).** Provide `grep` and
`mkdir` as in-process descriptor tasks solely for this gate. The grep subset is
adapted from the pinned Bashkit `builtins/grep.rs`; it accepts `-v -c -q -n -i
-F -E`, streams records without the bug25 output-buffering path, bounds records
and regex resources, and retains GNU 0/1/2 statuses. `mkdir` and `-p` use the
runtime filesystem. Provenance, exact bounds and deliberately unsupported syntax
are in `sources.lock.json:shellAcceptanceUtilities` and
`docs/external-commands.md#acceptance-only-in-process-utilities`.

These commands unblock exactly these existing, unchanged cases in
`tests/pipelines.acceptance.spec.ts` (not a claim that the entire browser gate
has passed):

- `pipeline forwards ticker lines while the producer is running` —
  `bun run ticker.ts | grep tick`;
- `pipeline Ctrl+C stops every stage and its children` —
  `export KEEP=kept; bun run endless.ts | bun run read.ts | grep unmatched; echo BAD_AFTER_INTERRUPT`;
- `pipeline stages inherit functions, unexported variables, cwd and redirections`
  — `mkdir nested; cd nested; secret=retained; f() { printf '%s\n' "$secret:$PWD:$1"; }; f value | cat > result; cat result`.

Native descriptor regressions additionally pin quiet early exit, no-match
cancellation, byte preservation, regex/record admission, >1 MiB streaming,
broken pipes, counts/statuses, and existing directory/file handling. No new
utilities beyond these commands are approved here; the general set remains
step 4. Directory metadata uses the same synchronous Preview1 filesystem
boundary as opens, so the filesystem stall/cancellation gate below also applies
to `mkdir`; it is not closed by racing the outer future with cancellation.

**Terminal dependency (2026-10-17).** Step 1's raw shared endpoint carries
byte-exact pipes and gives the shell guest its own prompt editor. Per-child
canonical terminal input (echo/editing and one-shot Ctrl+D EOF for a foreground
child) depends on the shared runtime's step 5, **Terminal**: terminal descriptor
foreground ownership, cooked mode ported from Brush, and raw mode that passes
Ctrl+C through. This is approved later work, not a reason to close the whole
shared terminal to fake child EOF. When that runtime feature lands, the shell
hands foreground terminal ownership to the child job and takes it back on exit.
The current integration does not claim a child PTY/canonical-input implementation.

**Remaining runtime gates (2026-10-17).** The integration may land while these
runtime-owned limitations remain explicit; step 1 is not fully satisfied until
they are removed, and they remain mandatory before step 6 replaces Brush:

- **Lifetime process limit.** The shared directory currently has 1,024 slots,
  including the shell root; completed/reaped processes do not release them.
  `runtime/proc/worker-client.ts:reserveRecord` monotonically consumes the count.
  `scripts/fixtures/runtime-process-limit.test.ts` uses the real client, broker,
  supervisor, wait and reap to pin the known failure after 1,023 sequential
  controlled commands; it launches no guest. Its TODO preserves the 2,000-command
  target. Run through admission: `bun test scripts/fixtures/runtime-process-limit.test.ts`;
  `--todo` additionally attempts that currently failing target. Remove the
  known-failure assertion and execute the target after runtime slot recycling
  with PID/generation validation lands. Recheck real browser sessions afterwards.
- **Bun-created descendants.** Runtime step **7b** will replace the historical Bun
  subprocess bridge with the shared process service. Today a shell-launched Bun
  parent is in the directory, but its `Bun.spawn` descendants are not, so shell
  whole-job interruption cannot reach them. Nested `Bun.spawn({stdin:"inherit"})`
  now retains a generic runtime pipe reader, but still gets EOF for a generic
  parent's regular-file or terminal fd 0 across that legacy bridge. Direct
  `runtime_proc` child inheritance is not affected. The full foreground-descendant
  and independent-background browser test remains unchanged but explicitly
  `fixme` pending 7b; this is a known failure, not passing cancellation evidence.
- **Bun guest libc preopen discovery.** The pinned Bun guest's wasi-libc scans
  descriptors from 3 until BADF and exits 71 on any other error. A truthful NOTSUP
  for an inherited terminal at fd 3 therefore aborts startup before the real
  relocated root preopen is found. The Bun fd3/fd4 offset and root-preopen browser
  cases remain explicitly `fixme` pending a guest libc fix that skips occupied
  non-preopen descriptors. Do not invent successful directory metadata or invalid
  prestat tags. Builtins and direct `runtime_proc` shell children retain active
  arbitrary-fd/root-preopen browser coverage; those do not use Bun's libc scan.
- **Shared-filesystem devices.** The runtime has no device nodes yet. Do not
  create a regular `/dev/null`: it retains writes instead of discarding them.
  Waffle will provide real `/dev/null` (discard writes, EOF reads), `/dev/zero`,
  `/dev/urandom`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd/N`
  aliases resolved against the opening process's descriptors. `/dev/tty` follows
  the terminal step. Missing devices are a known limitation, not shell-only
  implementations; child programs must observe the same semantics.
- **Filesystem stall/cancellation.** Rust `Runtime::open` currently calls Preview1
  `path_open`; directory creation/stat likewise use synchronous Preview1 calls.
  `FilesystemClient.call` can enter an indefinite `Atomics.wait`.
  A stalled filesystem service therefore blocks shell task progress and SIGINT
  handling: `poll` is not yet the sole blocking operation. The runtime will add
  copied-input open submission, nonblocking take/cancel and kind-3 completion
  readiness; Rust must use a cancelling RAII request owner with no blocking
  fallback. `scripts/fixtures/runtime-filesystem-pending.test.ts` records the
  pending deterministic gate: hold an open indefinitely, advance ready background
  work, interrupt the foreground to status 130 without releasing the gate, then
  deliver the late result and prove no fd leak. Success, ENOENT,
  completion-before-registration, completion/cancel ownership and invalid output
  memory are separate pending cases. These TODOs are not execution evidence.

**Approved job-lifetime transition (2026-10-17).** The current runtime seals a
job when its pending membership reaches zero, before it is reaped. A shell job
can launch another command later in a loop or after a pipeline; joining that
sealed runtime job fails with ECHILD and shell status 127. Until creator-owned
job handles land, the small Rust `Runtime` group adapter starts one runtime job
per direct child and retains every job ID under the logical shell group. Group
kill closes admission before signaling every job; group wait confirms and reaps
all jobs, including descendants and members admitted while an earlier wait was
pending. Background groups remain separate from each other and the foreground.
The browser acceptance uses a supported background brace sequence: a short Bun
exits, a later persistent Bun starts, then `kill %1; wait %1` confirms cleanup
without executing the following command. The original fixture used unsupported
`for`/`if` syntax from the parked control-flow climb; restore that additional
loop-form acceptance there,
without treating this sequential-members gate as loop-compatibility evidence.
This fanout is not the final runtime job model. After slot recycling, add an
explicit creator hold that keeps a job open across temporarily empty membership:
job-empty/wait-job becomes true only after release and no remaining members,
and kill-job covers all current members. Then replace the contained adapter
fanout with one shell job to one runtime job handle, retaining the same dynamic
membership, cancellation, isolation and descendant-confirmation regressions.

Runtime delivery order after its package split is slot recycling and creator-held
job handles, then 7b, then asynchronous filesystem requests. The current PR does
not implement substitute cross-transport job fencing or a blocking filesystem
fallback.

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
