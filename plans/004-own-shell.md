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

Status: Approved. Complete this with the post-substitution ANSI-C guard follow-up
below, before adding more allocation paths; the deferred full cursor is not a
prerequisite. This was found during arithmetic review and predates that PR.

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

## Follow-up: admit every isolated shell-state snapshot

Status: Approved. This is a bounded, pre-existing engine follow-up outside the
current command/process-substitution critical path. Carry it with this plan in
the approved repository extraction below; do not reopen the substitution unit or
fold a broad execution/AST ownership rewrite into it.

**Evidence (source-confirmed, not executed):** inspected the `climb/subst-gen`
working tree based on `3fb4fab8ae707141b0f948a352558ba5c2439fe0`, including the
current substitution edits, on 2026-10-17. These three remaining
`state.borrow().clone().shared()` calls bypass `Work::admit_storage` and
cooperative checkpoints:

- `shell/engine/src/interpreter.rs:656`, `execute`'s multi-stage pipeline path;
  the loop makes one copy per stage before awaiting `join_all`.
- `shell/engine/src/interpreter.rs:1022`, `subshell`, before spawning its task;
  its redirect-expansion `Work` is created later at line 1032.
- `shell/engine/src/interpreter.rs:1130`, synchronous `background`, called by
  `list_command` at line 1072.

`State` still derives `Clone` (`shell/engine/src/state.rs:24`). Function bodies
now use `Rc<Command>` (line 32), avoiding recursive function-AST copies, but
variables, binding names, exported/readonly sets, positionals, cwd/shell name,
pipeline statuses and saved local/prefix values still copy eagerly. There is no
aggregate retained-state limit: `Limits::expansion_bytes` is command-wide
(`interpreter.rs:25`), preparation creates fresh work for each simple command
(line 1489), and assignment checks at lines 1767/1790 cover the current command's
bytes, not previously retained bindings. `Session::start` retains the same state
across submissions (lines 349–375); public `Session::state` (line 331) also allows
host-injected state. Pipeline/job count limits do not bound bytes per copy.

**Deterministic reproduction to add, not yet run:** use the existing native
`Rig` in `shell/engine/tests/words.rs`, with default limits and a single session:

```rust
let rig = Rig::new(Limits::default());
let seed = "x".repeat(16 * 1024);
assert_eq!(rig.run(&format!("seed='{seed}'")), 0);
for index in 0..96 {
    assert_eq!(rig.run(&format!("v{index}=$seed")), 0);
}
for source in ["( : )", ": | : | :", ": & wait"] {
    assert_eq!(rig.run(source), 0); // source-predicted existing behavior
}
```

Each submission is below the source/command limits, but 97 retained payloads
alone occupy 1,589,248 bytes, above the default 1 MiB expansion allowance. The
three fork forms are predicted to copy that state successfully without emitting
it; the pipeline makes three copies without a checkpoint inside the setup loop.
This is not an observed failure, crash, cancellation latency measurement or
corpus regression. First add and execute the failing-first admission test; after
the repair require explicit status 2 before child dispatch, not the old status 0.
A separate smaller-state case must cover a pipeline whose individual snapshots
fit but whose combined snapshots exceed one command's allowance.

**Bounded implementation:** reuse `State::snapshot(&state, &cancel, &mut work)`
(`state.rs:75`), including its accounting for saved frames, collection metadata
and shared function bindings. Preserve the command/process-substitution snapshot
admission already in this unit. Subshell setup uses one work account for its
snapshot and redirections. Make background setup async and await it from its
caller; admit its snapshot before allocating a process group, registering a job
or spawning the body, using one work account for that background command. Use
one shared `Work` for all snapshots of a multi-stage pipeline, not a fresh
allowance per stage; the single-stage path retains the caller's shared state.
Prepare/admit all child states before spawning any stages, or explicitly cancel,
join and unwind every already-started task/descriptor/scope on a later setup
failure. Do not solve this by imposing an unrelated new global variable cap or
by cloning first and checking afterwards. Immutable shared AST payloads remain
separate from any admitted AST copies needed for execution.

**Gates:** focused native and WASI tests cover each fork form, metadata-only and
saved-frame admission, exact/over-budget storage, shared pipeline accounting,
ordinary state isolation, and cancellation both before admission and during a
snapshot yield. Instrument the existing process-host fixture to require zero
partial dispatch on failed/cancelled setup; assert no leftover jobs, open pipe
ends or stranded tasks. Preserve background ownership and cancellation isolation,
`PIPESTATUS`/`pipefail`, redirect inheritance, and all command/process-substitution
regressions. Run the full native/WASI suites and fixed-corpus zero-loss ratchet
through the shared queue. Record the small reproduction/results and clean every
task-created target, process and scratch directory under the existing lane rules.

## Follow-up: Bash-scale function recursion on the WASI stack

Status: Approved; scheduled for the functions/execution work after the current
substitution unit. The inherited default `Limits::function_depth` is 128
(`shell/engine/src/interpreter.rs`), and the separate 256 execution-depth guard
in `shell/engine/src/interpreter/eval.rs` can reject compound function bodies
earlier. These are compatibility limitations, not Bash-correct final limits:
Bash has no default function nesting limit.

**Observed evidence:** at `c090eb9`, CI [39048383922, native producer
117441646576](https://github.com/ShaulLavo/brush-web/actions/runs/39048383922/job/117441646576)
and a queued local debug reproduction abort with stack overflow in
`command::returned_evals_release_storage_before_later_function_calls`, which
configures only 32 calls. Reproduce with `cargo test --manifest-path
shell/Cargo.toml -j2 -p shell-engine --test words
command::returned_evals_release_storage_before_later_function_calls -- --exact`.
The substitution PR owns fixing this crash with small polling/drop frames and
unchanged limits; passing that bounded regression does not establish Bash-scale
recursion or make the inherited caps correct.

**Target:** at least 512 nested function calls must succeed under ordinary
configuration in native and WASI execution, without enlarging the WASI/native
stack or retaining large per-call frames. Include ordinary function bodies and
sequential completed eval readers. Measure actual admitted call depth and
per-level stack/frame cost. Replace accidental low nesting ceilings with an
explicit configurable FUNCNEST-style policy and bounded live-memory admission;
configured-depth or genuine admission exhaustion must produce a clear shell
error and leave the session usable, never crash or silently truncate execution.
Preserve cancellation, local/positional restoration, retained function/source
ownership, the separate parser/eval guards and peer-background isolation. Gate
accepted depth, one-beyond configured depth, cancellation and recovery on native
and WASI, then replay the fixed corpora with zero lost cases. Do not claim the
512-call target until those executions pass. This follow-up does not start the
parked control-flow or functions unit as part of the substitution PR.

## Next word unit: ANSI-C operands and two-phase parameter extraction

Status: Approved. Land command/process substitution first and restore the
control-flow checkpoint. Sequence the full ANSI-C cursor by measured fixed-corpus
yield as described below; low-yield work is approved for later, not dropped. Finish
the IFS storage-admission follow-up above before adding allocation paths.

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
stdout observations, including Bash failures. The complete implementation must
match these controls. While the cursor is deferred, explicitly diagnosed
unsupported shapes remain separately counted, never converted into passes or
blanket operator exemptions; Bash failures must also retain their exact oracle
status/stdout observations.

Implement general **two-phase parameter extraction**, not quote-specific
patches or raw decoded-text insertion into the outer shell grammar. Inspect
`shell/parser/src/parser/lexer.rs` (`read_parameter_body` and ANSI-C decoding),
`shell/parser/src/parser/parameter_scan.rs`, parameter extraction in
`shell/parser/src/parser/mod.rs`, and lazy operand decoding in
`shell/engine/src/expand/operand.rs`. Keep early shell-word syntax separate
from later extraction, preserve storage/work/raw admission and cancellation,
regenerate all affected fixtures with independent byte comparison, and run the
full native/WASI suites and per-case score ratchet before pushing.

### Two-phase design checkpoint (2026-10-17)

Status: Approved; the complete word-wide cursor is deferred, with no identified
direct fixed-corpus gains. Land command/process substitution first; only then
schedule the narrow typed guard below. Preserve these controls and the complete
design for later, and put the compatibility climb into control flow,
functions/`set --`, errexit and redirects. Before reopening the full cursor,
remeasure affected failures in the Oils, Brush and Bashkit lists. Do not preserve
silently incorrect output or mark unrelated ANSI-C quoting unsupported.

Fixed-corpus yield checked against `docs/evidence/own-shell-oracle.json` and the
matching `docs/evidence/own-shell-baseline.json` at brace PR #29, commit
`9b371d4dd098bca90590d9102dff3dd74ef95178`: all 9,221 scripts were screened;
43 contained both `$'` and `${` and were read individually. Only eight actual
ANSI-C-in-parameter-operand cases (11 occurrences) exist: one of 2,492 Oils cases,
one of 2,894 Brush cases and six of 3,835 Bashkit cases. **All eight already pass;
none covers the vulnerable double-quoted decoded quote/brace/dollar/backslash/NUL
shapes. At that checkpoint, zero of 4,088 failures was directly attributable to
this unit.** These are historical screening results, not newly measured gains.
Therefore defer the complete cursor. **Immediately after command substitution
lands, fold in a small, narrowly scoped status-2 `unsupported` guard for the
silently wrong outer-double-quoted decoded quote/brace/NUL shapes.** Preserve the
eight passing cases and protected quoting contexts, and show only Bash-successful
controls moving from `MISMATCH` to `UNSUPPORTED`, not to `MATCH`. If Bash errors,
a guard returning status 2 must remain `MISMATCH` against Bash's actual status and
stdout; never reclassify a Bash failure as unsupported or invent a successful
oracle result. This schedules future work, not an implemented guard or a claimed
score gain. The screening is direct source coverage, not a proof about arbitrary
text synthesized later with `eval`.

Preserve the passing case IDs: `oils:var-sub-quote:217`,
`brush-suite:word_expansion/params:53`,
`bashkit-suite:param-operand-quotes:43`,
`bashkit-suite:param-operand-quotes:113`, and
`bashkit-suite:var-op-test:252`, `:271`, `:280`, `:289`. They exercise protected
trim/replacement patterns, an unquoted default with `}`, and a quoted tab default;
a blanket ANSI-C-in-parameter rejection would lose useful supported behavior.
The older multi-engine `docs/evidence/bash-compatibility.json` is not the current
own-shell failing list. Reproduce the screening by joining oracle/baseline case
IDs, filtering scripts containing `$'` and `${`, then inspecting source context;
also check `$` plus escaped-newline before the apostrophe (the sole current case,
`brush-suite:line_continuation:4`, is top-level ANSI-C, not a parameter operand).

The existing lexer `read_parameter_body` decodes an ANSI-C island into a quoted,
NUL-protected string. The word parser then commits its operand boundary, and the
engine sees only a selected operand. Changing just that final operand cannot fix
this: a decoded close and quote can affect later text in the same original word.
GNU Bash 5.3.15 controls, checked on this host:

```bash
v=SET; X='a b'
printf '<%s>\n' "${v:-$'}\x22'}"$X
# One field: <SET}a b>
printf '<%s>\n' "${v:-$'}\x22'}""$X"
# Two fields: <SET}a> and <b>
printf '<%s>\n' "${v:-$'}\x22'}" $X
# Three fields: <SET}>, <a>, <b>. Original word boundaries stay fixed.
printf '<%s>\n' "${v:-$'}\x22'}"$'\x24X'
# One field: <SET}'a b'>. Generated quote recipes are not hard protection.
```

**Phase 1: original shell grammar.** Keep source word/command/redirection
boundaries authoritative. The lexer consumes each ANSI-C island by its original
spelling, never feeding decoded punctuation into the shell lexer or its source
boundary scanner. Retain original quote delimiters, source spans, ANSI-C islands
and original command-substitution descriptors in an expansion-source payload for
the complete affected word. Keep `Word.raw` unchanged for printing, braces and
diagnostics. Distinguish original syntax, genuinely protected literal escapes,
decoded data and generated quote events with typed provenance, not data bytes.
Original command bodies still receive eager shell-syntax validation. Dollars
created by decoding do not introduce new original-script syntax validation.

**Phase 2: word-wide expansion projection.** Use one shared cursor that projects
an ANSI-C island exactly once using its phase-1 quoting recipe. When execution
reaches `${`, extract its complete projected boundary before choosing the operand,
including nested projected parameters. Return the existing parameter operation
and bounded operand views, evaluate only selected operands, then resume the same
cursor immediately after the actual projected close. A decoded `}` may leave a
tail outside the parameter but inside the original word. Quoting of that tail and
later source text must follow the cursor, not precomputed per-part quote flags.
Unaffected words may retain the current parsed-parts fast path; the deferred
payload must be authoritative for affected words, never executed alongside stale
static parts. Keep existing protected segments and final IFS splitting downstream.

Extraction and selected-operand expansion share provenance and cursor positions,
not identical quote rules. Apostrophes can participate in boundary matching while
remaining literal during expansion of an outer-double-quoted default operand.
Operator disposition matters: `#`, `%`, `^`, `,` patterns and replacement pattern
and RHS preserve ANSI-C quoting; defaults and substring expressions project
active decoded syntax. Undocumented `~`/`~~` act like the latter, unlike `^`/`,`.

```bash
v=abc
printf '<%s>\n' "${v:-$'\x27'}" # status 1, no stdout, even unselected
printf '<%s>\n' "${v#$'\x27'}"  # <abc>, status 0
printf '<%s>\n' "${v/a/$'\x27'}" # <'bc>, status 0
printf '<%s>\n' "${v~$'\x27'}" # status 1, no stdout
```

The decoder must preserve an explicit NUL-termination outcome; its current empty
string result loses a distinction needed by extraction and by the remaining word:

```bash
v=SET
printf '<%s>\n' "${v:-$'\x00tail'}" # status 1, no stdout
printf '<%s>\n' "${v:-$'}\x00tail'}"AFTER # <SET>, status 0
v=abc; printf '<%s>\n' "${v#$'\x00'}" # <abc>, status 0
```

Malformed projected extraction fails when execution reaches that expansion, not
while parsing the script. Bash `-n` accepts these words, an unexecuted `if` branch
does not fail, and an earlier `printf 'BEFORE\n'` still prints before the error.
An executed outer `${v:-${u:-$'\x27'}}` fails even if `v=SET`: boundary extraction
precedes outer operand selection. Preserve source-order expansion side effects;
do not validate every deferred word/parameter in a script eagerly. Generated
`$v`, `${…}`, `$((…))` and `$()` may expand, but generated `$'…'` must not trigger
original ANSI-C decoding again. Decoded separators and redirects stay word data.

**Interim guard implementation:** carry one allocation-free typed feature bit
from the lexer through `SpannedToken` and parser current-token metadata into
`Word`. Set it while consuming original-source ANSI-C islands, using an explicit
`ParameterScan` query for active-double-quoted versus protected operand context.
The decoder classifies decoded apostrophe, double quote, `}`, backslash, dollar,
backtick and NUL before truncation; retain `had_decoded_nul`. Do not make this a
parse error or runtime source reparse. At `expand_one` entry, after the ordinary
work/cancellation checkpoint and before interpreting parts, return a typed static
unsupported-feature error rendered as status 2 with the normal source line. The
guard rejects an affected word atomically: earlier words have already expanded,
but earlier expansions inside the same rejected word do not run. This conservative
unsupported contract is distinct from the eventual exact side-effect semantics.

OR the bit when words are appended; preserve it in scalar assignment words and
bounded brace reparsing. Nested parameter flags accumulate into their containing
word even across lazy outer operands; opaque command-substitution bodies keep
independent execution scopes and must not poison their containing words.

Decoded-special detection alone is insufficient. Bash 5.3.15 prints `<B>` for
`v=A; vfoo=B; printf '<%s>\n' "${u:-$v$'foo'}"`: decoded `foo` can join an earlier
variable name without containing any structural special itself. Keep the only
unguarded active-default case a proven simple literal operand: literal text and
ANSI-C chunks, with no other expansion, quote or escape syntax and no decoded
specials. Fixed-capacity frame flags for active ANSI presence and other operand
syntax suffice to reject complicated active operands conservatively. Guard
active ANSI-C substring operands too: `v=abcdef; printf '<%s>\n' "${v:$'1:2'}"`
prints `<bc>` in Bash, so decoded arithmetic delimiters also matter. The existing
quoted tab default remains a supported simple literal; all other seven frozen
cases remain protected. Do not blanket-disable an operator or ANSI-C quoting.

Implementation points: the source/projection distinction and operator context
belong beside `ParameterScan` in `shell/parser/src/parser/parameter_scan.rs`;
`lexer.rs` retains source islands and decoder outcomes; `mod.rs` parameter-token
parsing accepts extracted typed views; `substring.rs` validates original command
bodies only; `shell/engine/src/expand/operand.rs` consumes projected views; the
word dispatcher in `shell/engine/src/expand.rs` selects the authoritative cursor
before static part iteration. Preserve the existing decoder's byte-run UTF-8,
unknown-escape and `\c` consumption behavior rather than extending the smaller
duplicate decoder in `parse_word`.

Both phases share work, storage, raw/output allowances and cancellation. Admit
piece vectors, decoded buffers, materialized tokens and diagnostics before
allocation, including extraction of unselected operands. Cursor clones copy
positions, not buffers; use admitted stable storage and span views to avoid
quadratic decoding/copying. Keep status 1 malformed extraction distinct from
status 2 resource/unsupported failures and status 130 cancellation. Verification
must include original corpus membership, operator/selection/quote matrices,
whole-word quote crossings, NUL termination, skipped branches, expansion-side
effects, token/depth limits, native/WASI suites and independent fixture replay.

## Current unit follow-up: preserve requested job signals

Status: Source acceptance passed at `e4202c7`; final evidence-head CI and merge
remain required. Found during runtime integration, not introduced by it:
`kill %1` took the Session cancellation path and sent SIGINT (2), although Bash
defaults to SIGTERM (15). The source now carries default TERM and explicit
named/numeric signal values through scoped job and process-substitution groups.
Native/WASI controls passed with wait statuses 143 for TERM and 130 for INT.
Both Bash 5.3.15 substitution seeds passed 3,142 controls each with zero
mismatches or unsupported cases. Invalid signals now return Bash status 1 before
mutation; known unsupported actions retain explicit status 2.

Reproduce against Bash 5.3.15 and the exact-head native CLI with an owned,
bounded background job: launch it, issue default or explicit `kill`, wait for
that job and print the status. Add generator controls covering default TERM,
named/numeric TERM and INT, and invalid signal handling without signaling any
unowned process. Trace the builtin-to-Session-to-runtime path; fix signal
propagation generally rather than changing only the displayed status. Preserve
Ctrl-C cancellation as INT, job scope/identity, descendant ownership and work
bounds. Require native/WASI coverage, Bash differential agreement and zero lost
passing corpus cases before calling this follow-up complete.

The generator's INT controls use an owned `sleep 1` job whose lifetime does
not depend on interpreter throughput, save the `kill` command status, then wait
and reap the job. They compare the kill-command result with Bash; the observed asynchronous
child wait status can depend on whether the child has installed its signal
disposition before the kill, so these controls do not claim a fixed Bash wait
status for INT. Native and WASI ProcessHost controls assert requested signal 2
and wait status 130. Full POSIX asynchronous
signal-mask parity remains an Approved follow-up after this unit, with no source
text or corpus-case exception. The old million-iteration arithmetic job was
only a lifetime guard; the generator now records Bash 5.3.15 observations for
the independent sleep-based control, while the arithmetic loop remains an
explicit performance benchmark below. The native shell-engine candidate does
not provide external `sleep`, so its recorded candidate-side background job
exits with status 127 before the invalid signal is issued; the semantic
assertions still cover kill status, wait/status output and no stray output, and
real signal delivery remains covered by the native/WASI ProcessHost controls.
The Bash fixture regeneration verifies that Bash has a live owned `sleep` job
when `kill -s INVALID` runs.

The current builtin boundary supports signal 0 as a non-destructive owned-job
existence check and supports HUP, INT, QUIT, KILL, and TERM as terminating
signals. Stop/continue, child-status, user, alarm, pipe, and other unsupported
actions return a diagnostic before job or host mutation. Out-of-range numbers
are invalid. Traps, ignored-signal inheritance and broader POSIX signal action
parity remain deferred rather than being represented as termination statuses.

## Current unit: preflight and loop-work repairs

Status: Source acceptance passed at `e4202c7`; final fixture/evidence-head CI,
independent review and merge remain required. Its exact native CLI passed all
six Bash 5.3.15 sweeps: substitutions 3,142 each (seeds 1/42), braces 7,334 each
(1/42), arithmetic 3,692 each (7/314), all with zero mismatches or unsupported
cases. Old word, readonly and parser-boundary fixture replays passed. Frozen
scores are Oils 681/1,682, Brush-suite 606/1,888 and Bashkit-suite 1,028/2,222,
with zero lost case IDs against runtime main `e3f245f` (527 / 394 / 792).
The exact source producer passed native/WASI tests and size gates (2,518,525
bytes raw, 529,529 bytes Brotli-11); actual browser verification passed 132
controls with six existing skips. The independent exact-source review approved
`e4202c7`. [Run 39053112336, producer job 117455545690](https://github.com/ShaulLavo/brush-web/actions/runs/39053112336/job/117455545690)
contains that source evidence; its two stale fixture/baseline data gates are
not accepted as final green CI. Refresh and strictly replay those data in this
unit before landing. Arithmetic timing margin remains the Approved follow-up
below, not a completed throughput claim.

Historical diagnostic at `8dd11b8`: native/WASI and size gates passed (2,514,034
bytes raw, 528,401 bytes Brotli-11), and browser verification passed 132 controls
with six existing skips. The following failures were discovered at that head
and repaired before `e4202c7` source acceptance.

The six Bash 5.3.15 sweeps at that head exposed two remaining defects: both
substitution seeds time out on the unchanged invalid-signal control's finite
million-iteration job (2,000 ms acceptance bound), and both brace seeds report
two protected-dollar arithmetic boundary mismatches. A separately admitted,
bounded diagnostic completes the job in roughly 2.9 seconds but reveals an
additional invalid-signal status difference (2 instead of Bash's 1). Preserve
the time bound and workload; repair execution cost and signal parsing generally,
not the generator. `$((0 + "$"((1+2))))` must not reactivate a quoted dollar as
an arithmetic opener. The arithmetic sweeps, old fixture replays and per-case
ratchet passed; they do not waive these failures. Qualified source artifact:
[run 39050413259, producer job 117447674511](https://github.com/ShaulLavo/brush-web/actions/runs/39050413259/job/117447674511).

The qualified native CLI from [run 39037414534, producer job 117409933867](https://github.com/ShaulLavo/brush-web/actions/runs/39037414534/job/117409933867)
exposed five actual finite-control gaps before the full generator sweeps:
external multiple heredocs need one isolated reader state, `${!+set}` is rejected,
a repeated numeric wait loses its known status, IFS nameref target mutations
must not be conflated with positional-join cache invalidation, and an overflowing
nameref assignment must stop the remainder of its physical input line while
preserving next-line recovery. The runtime author owns readers, special scalar
operators, wait lifecycle and assignment error flow; the scalar author owns the
IFS state/expansion adapter. Controls compare exact stdout bytes and status;
they do not substitute unsupported `test` syntax for expansion assertions.

The same run's full browser verification passed 125 tests, skipped six existing
runtime limitations and failed one Chromium control:
`tests/runtime-shell.spec.ts:74`, **Ctrl+C interrupts executing shell WASM without
killing an independent background Bun**. The unchanged `while :; do :; done`
control reported `CPU_STATUS:2` instead of `CPU_STATUS:130`; the unrelated Bun
kept ticking. Loop work accounting is owned by this unit's runtime author.
An endless or long loop is valid shell: execution checkpoints yield and poll
interruption rather than terminate the loop for elapsed work. Keep admitted
memory/storage and recursion limits, audit other looping/long-running paths,
and add a native/WASI control that runs beyond the former work allowance before
interrupting to 130. Do not raise a limit or loosen the browser assertion.
Inspect `shell/engine/src/interpreter/eval.rs:Scope::frame/admit_execution` and
its cumulative parser-work charge as a hypothesis, not a proven sole cause.

Every source revision invalidates the earlier binary/generator acceptance.
Qualify a fresh exact-head push artifact using its completed producer job, run
ID, job ID, source receipt and binary checksum. Full verification may run in
parallel, but final acceptance still requires every CI job green, six actual
Bash differential sweeps, refreshed strict fixture replay, zero lost corpus
passes and independent review of the exact final head.

## Follow-up: arithmetic throughput and timing margin

Status: Approved; throughput remains unfinished even when the substitution
sweeps pass. Target **at most 1,000 ms for both foreground and background
million-iteration controls**, under the unchanged release configuration and
2,000 ms differential timeout. Do not raise the timeout, reduce the iteration
count, change the release profile, enlarge stacks or weaken tests to obtain
margin.

The canonical admitted local experiment at `e4202c7` measured 2,082 ms foreground
and 1,846 ms background after borrowed arithmetic-command replay, versus
2,981 / 2,800 ms before it. These are single-run diagnostic observations, not a
performance headline or a reliability distribution. The exact CI CLI from
[run 39053112336, job 117455545690](https://github.com/ShaulLavo/brush-web/actions/runs/39053112336/job/117455545690)
passed substitution seeds 1/42 under the unchanged timeout, but 154 ms of local
background headroom is too thin to call throughput complete. A bounded numeric
leaf future-representation experiment passed native semantic tests but was
reverted: three alternating matched-compiler rounds under ordinary non-quiet
admission measured median scaled retired user instructions of 35.318 billion
control versus 35.617 billion candidate foreground (+0.85%), and 31.282 billion
versus 31.216 billion background (-0.21%). All 12 outputs/statuses matched; these
counts do not establish a clear reduction. Counters included inherited child
instructions and recorded enabled/running time for multiplex scaling. The
experiment changed no permissions, kernel settings, profile or timeout. Its
source and temporary binaries were removed; it is not part of accepted source.
No quiet timing hold ran. Do not assume that fewer allocations meet the target.

The host-probe isolation repair at `1976a05` was independently reviewed and
passed native shell tests, but exact-head CI run `39060501467` still timed out
the old invalid-signal million-loop control under the unchanged 2,000 ms bound.
The matching local diagnostic measured 1,495.5 ms for the plain foreground
million-iteration loop and 1,526.7 ms for the invalid-signal foreground loop,
versus Bash 5.3.15 at 593.8 ms and 603.7 ms. These are bounded local
observations, not a completion claim. The generator's signal control now uses
`sleep 1 &`, so it tests owned-job signal semantics without making the
correctness gate an incidental arithmetic benchmark. Record the next matched
retired-instruction profile before choosing another general hot-path repair;
the target remains at most 1,000 ms, then parity with Bash.

The final evidence head `bc4e3b5` then reproduced the timing failure on CI:
[run 39055395219, shell job 117462215829](https://github.com/ShaulLavo/brush-web/actions/runs/39055395219/job/117462215829)
passed native/WASI/size/CLI and the earlier fixture gates, but the substitution
replay's invalid-signal million-loop candidate timed out (null status, empty
stdout) against Bash exit 0 and `kill=1` / `status=0`. Its actual browser and
compatibility jobs passed, and the exact downloaded CLI separately passed all
six local sweeps; neither overrides this red CI result. **Landing is blocked**
until a measured general hot-path repair gives adequate margin with unchanged
limits. Before another source change, build the native CLI with symbols and
sample that exact loop's retired instructions under ordinary admission. Rank
functions and attribute checkpoint/interrupt, arithmetic parsing/expansion,
variable lookup/allocation and storage-accounting costs from the samples, not
guesses. Confirm the chosen repair with alternating matched-toolchain
instruction counts, then requalify exact-head native/WASI/browser/six-sweep,
fixture and zero-loss gates. Do not retry unchanged source into green.

Reproduce the fixed control without host files or unowned processes:

```bash
i=0; while ((i < 1000000)); do ((i += 1)); done &
kill -s INVALID %1; kill_status=$?; wait %1
printf 'kill=%s\n' "$kill_status"
status=$?; printf 'status=%s\n' "$status"; exit "$status"
```

Require exact stdout `kill=1` then `status=0` and exit 0. For the foreground
control, run the same loop without `&` and print `i=1000000`. Use the canonical
host queue, a qualified exact-head CLI and Bash 5.3.15; retain every bounded
sample rather than choosing the fastest. PC performance research never requests
`--quiet` holds: compare retired instruction counts under ordinary admission
(or WASI fuel), alternating matched control/candidate binaries. Wall-clock
performance verdicts belong on the Mac or Pi. The unchanged PC generator timeout
remains a correctness gate, not a timing benchmark. The existing generator command is
`node scripts/fuzz-shell-substitution-boundaries.mjs --queue-active --shell
"$SHELL_NATIVE" --seed 1` inside that admitted run; also run seed 42 and the
other four arithmetic/brace sweeps with their unchanged settings.

Profile and attribute remaining cost before choosing further work. Current
static candidates are boxed arithmetic `expression` / `parse` / `unary` frames
and recursive scalar reads in `shell/engine/src/arithmetic.rs`, descriptor and
`PIPESTATUS` allocations in `interpreter.rs::loop_arithmetic/finish_command`,
and repeated cancellation checks in `expand.rs::Work::checkpoint`. A persistent
scheduling quantum must be separate from fresh command admission: persisting
all of `Work` would eventually reject valid loops; resetting the scheduling
quantum for each short command would never yield. Do not remove probes merely
because they look duplicated: they reach foreground ABI interrupt ownership and
affect cancellation-versus-resource-error ordering. No broad arithmetic-driver
or scheduler rewrite is mandated without measurements.

Preserve the complete grammar, current-variable reads, recursive scalar values,
assignment order and durable side effects; pre-growth live admission, bounded
copies charged to `Work.storage`, cooperative interruption/yielding and small
poll/drop stacks. Valid long loops never fail for cumulative elapsed work.
Retain function128/execution256/eval16, exact32/deep127, admission/depth/error
boundaries, peer progress, cancellation/recovery and actual consuming-ABI
foreground ownership. Acceptance includes native/WASI/browser controls, six
unchanged differential sweeps and zero lost corpus IDs. Record target results
and remaining margin in the final evidence and PR; a green semantic gate alone
does not close this performance follow-up.

## Follow-up: redirect word expansion contexts

Status: Approved. After the IFS admission fix, handle redirect-target contexts
separately from scalar assignment; this may precede the full low-yield ANSI-C
cursor once unimplemented ANSI-C shapes fail explicitly. Current
`interpreter.rs::redirects` calls `expand::word` (scalar), which
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
session/executor boundaries documented in `shell/engine/README.md`. Distinguish
the in-process test fixture from the substitution lane's actual browser runtime
integration: real Bun children now exercise captures, process-substitution input
and here-string input on Chromium and Firefox. Those controls do not alone
satisfy every step 1 browser-worker gate or authorize replacing Brush before
step 6. Extraction waives none of those requirements.

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

| Area                                         | Carry with history, or explicitly adapt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust build policy                            | `rust-toolchain.toml` (Rust **1.98.1**, rustfmt, `wasm32-wasip1`); `.cargo/config.toml` (WASI maximum memory **268435456**); retain `shell/Cargo.toml`, `shell/Cargo.lock`, both crates, READMEs and `shell/parser/LICENSE`. Keep `.build/shell` artifact paths initially.                                                                                                                                                                                                                                                                                                                              |
| Main compatibility runner                    | `scripts/bash-compat.mjs`, `bash-compat-worker.mjs`, `bash-compat-helpers.mjs`, `shell-scoreboard.mjs`, `shell-scoreboard-base.mjs`, `shell-scoreboard-migration.mjs`, `shell-process-group.mjs`. The entry point imports the helper, runner and scoreboard modules and starts the worker by filename; the worker imports the helpers. Preserve immutable `git show` target-baseline reads, the isolated target rebuild and original-membership proof, inherited-startup-hook exclusion, cancellation ownership and process-group draining.                                                             |
| Oracle transport from the prerequisite PR    | `scripts/bash-compat-runner.mjs`, `bash-compat-pipe.py`, `audit-bash-oracle-pipe.mjs`, `test-bash-compat-runner.mjs`. Take their final committed merged versions. The runner spawns the Python file, including a separate exit-status fd; do not replace its real independent stdout/stderr pipes with direct Node `spawn` transport. The audit imports the helpers, runner and scoreboard.                                                                                                                                                                                                             |
| Runner/ratchet tests                         | `scripts/test-shell-scoreboard.mjs`, `test-shell-scoreboard-base.mjs`, `test-shell-scoreboard-migration.mjs`, `test-compat-selection.mjs`, `test-own-shell-runner.mjs`, `test-bash-compat-audit.mjs`, `test-bash-compat-cleanup.mjs`, plus the transport runner test above. Preserve the real-entrypoint cancellation controls, delayed consumer/worker termination barriers, private migration fixtures and startup-hook rejection. The own-shell runner test starts `bash-compat-worker.mjs` by filename; tests also depend on the existing evidence/manifest paths.                                  |
| Parser/WASI checks                           | `scripts/check-shell-parser.mjs` and `scripts/test-shell-wasi.mjs`. The provenance check reads `sources.lock.json` and its `shellParser.directory` license. The WASI check owns streaming acceptance and the brotli-11 **1,000,000-byte** release ceiling; do not lose it when removing browser tooling.                                                                                                                                                                                                                                                                                                |
| Differential generators                      | `scripts/fuzz-shell-words.mjs`, `fuzz-shell-readonly.mjs`, `fuzz-shell-arithmetic.mjs`, `fuzz-shell-parse-boundaries.mjs`, `fuzz-shell-braces.mjs`, `fuzz-shell-substitution-boundaries.mjs`; `scripts/test-fuzz-shell-braces.mjs`, `test-fuzz-shell-substitution-boundaries.mjs` import their corresponding generators. Carry/adapt the shell instructions from `scripts/README.md`. All six generators use Node built-ins.                                                                                                                                                                            |
| Seed fixtures                                | Under `scripts/fixtures/`: `shell-words-seed-1.json`, `shell-words-seed-42.json`, `shell-readonly-seed-17.json`, `shell-arithmetic-seed-7.json`, `shell-arithmetic-seed-314.json`, `shell-parse-boundaries.json`, `shell-braces-seed-1.json`, `shell-braces-seed-42.json`. Add the substitution PR's final `shell-substitutions-seed-1.json` and `shell-substitutions-seed-42.json` once committed; they did not yet exist at inventory time. Inventory all additional merged fixtures rather than synthesizing missing files during extraction.                                                        |
| Frozen scoreboard and capture classification | `docs/evidence/own-shell-oracle.json`, `own-shell-baseline.json`, `oracle-pipe-audit.json`, **and** `bash-compatibility.json`. The audit retains the proven transport corrections, unchanged identities, original-membership proof and corrected replay; the classification file preserves capture's historical case classifications and its hash, even though normal frozen replay does not read it. Carry `docs/evidence/licenses/oils-LICENSE.txt` and `brush-MIT.txt`; Bashkit's retained MIT license is `shell/parser/LICENSE`.                                                                    |
| Source/provenance manifest                   | Adapt `sources.lock.json`, preserving `shellParser`, `shellScoreboard`, `shellWords`, `shellParameterDefaults`, `shellParameterEffects`, `shellParameterLength`, `shellParameterTrim`, `shellParameterCase`, `shellParameterIndirect`, `shellParameterReplace`, `shellArithmetic`, `shellBraces`, and any shell entries added by the prerequisite PRs, with complete classifications/change records. Also retain the corpus pins under top-level **`oils`, `brush`, `bashkitTerminal`**: executable frozen validation reads them, not only `shellScoreboard.corpora`.                                   |
| Licenses/notices                             | Retain the root `LICENSE` and shell-relevant sections of `THIRD_PARTY_NOTICES.md`, including every adapted implementation/test and original-adapter distinction. Extract a shell-only `scripts/notices.mjs` flow that includes the pinned parser license, actual Cargo dependency licenses and retained corpus licenses. The current generator also reads the Brush browser workspace, terminal/Bun/Bashkit distributions, npm lock and `.sources` notices, so it cannot be copied unchanged as the standalone build command. Preserve a distributed generated notice file and update its README links. |
| Documentation                                | Carry/adapt `docs/bash-compatibility.md` (method, identities, capture/replay, ratchet and generator sections), this plan, `shell/README.md` and `shell/engine/README.md`; fix root-relative links. Keep historical Brush/Bashkit comparisons and original commit/CI links explicitly historical, not fresh standalone measurements. Product/browser architecture, performance and cold-start pages remain host documentation; link them where their acceptance criteria still apply.                                                                                                                    |
| Root JS/configuration                        | Create a shell-only `package.json`/`package-lock.json` adaptation, preserving Node **26.7.0** and the named shell scripts below. Frozen replay/generators need no npm packages. Capture additionally needs `yaml` (currently **2.9.1**); keep it reproducible when that operation is retained. Carry/adapt `.gitignore`, `.gitattributes` and `.oxfmtrc.json` if their rules are used. Do not inherit frontend `verify`, `build`, `sources`, or Brush-chained `test:rust` commands unchanged.                                                                                                           |
| CI                                           | Extract/adapt `.github/workflows/ci.yml`'s `shell` and `own-shell-compatibility` jobs, plus the prerequisite PR's final transport/audit steps. Preserve Node **26.7.0**, Rust **1.98.1**, wasmtime **v49.0.3**, rustfmt, the WASI target, locked native/WASI builds, bounded `-j2` CI work, generator tests/replays, score artifacts and exact target-branch checks. Preserve full checkout history (`fetch-depth: 0`) for baseline comparisons and adapt the Rust cache workspace to the retained paths. Do not pull in the frontend/browser/reference-engine `verify` job.                            |

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
