# 004: Our own WASM-first shell

Status: Approved (owner, 2026-10-16)

## Goal

The browser dev environment from plan 001 gets a bash-compatible shell we design ourselves, written for single-threaded `wasm32-wasip1` from the start. It runs real programs (`bun`, `grep`, `sed`) as child processes and streams their output live: `bun dev | grep error` shows each matching line as it happens. Correctness is measured against GNU bash, and the score only goes up.

Brush stays the working shell in this repository until step 6 replaces it.

## Decision

A shell has three parts:

- **Parser:** text to syntax tree. We take Bashkit's parser unchanged.
- **Bash rules:** what the syntax means. Variables, quoting, word splitting, expansions, arithmetic, control flow, functions, `set -e`, traps and the state-changing builtins (`cd`, `read`, `declare`, `eval`).
- **Engine:** how commands run. Starting processes, moving bytes between pipeline stages, waiting, Ctrl+C and background jobs.

We write the engine and the interpreter structure ourselves, then port Bashkit's bash rules into that structure one area at a time. Each area is checked against real bash as it lands.

Why not keep Bashkit's interpreter and swap its engine: the spike's low-confidence estimates to reach Brush-level compatibility are 4–9k newly written or substantially changed shell lines for that route, against 8–16k for this plan, both excluding the shared runtime, utility ports and tests. But Bashkit is built as a sandbox for AI agents. Its README promises no process spawning by default, all 167 commands reimplemented in Rust in-process, and scripts that run to completion and return their output. That assumption runs through its interpreter (one `Interpreter` struct with 123 declared fields). The spike found four separate places where output or input is collected whole instead of streamed: the final pipeline stage, generic stdin collection, process substitution and the accumulated result output. Each missed spot would be a pipeline that silently stops streaming, which is Brush's problem again. Porting the rules into a structure built for real processes avoids that. The risk of porting, getting bash rules subtly wrong, is what the compatibility harness measures.

Evidence: `/work/reports/browser-shell-research/own-shell-spike.md` (execution-model proof, Bashkit audit with file:line references, estimates and risks), [docs/bash-compatibility.md](../docs/bash-compatibility.md) (scores), `/work/reports/browser-shell-research/handoff-shell.md` and `handoff-runtime.md`. No Unix fork and no WASIX: neither StackBlitz nor CodeSandbox does fork in the browser, and StackBlitz ships its own shell.

This supersedes plan 001's choice of Brush, its fallback of forking Bashkit, and its steps 1b, 3 and 4. Plan 001 step 2 (one WASI host, OPFS filesystem) continues as the shared runtime work this shell runs on.

## The score

The scoreboard is `npm run compat`: GNU bash 5.3 is the oracle, a case passes when stdout bytes and exit status match, and the interpreter score uses builtins-only cases. Targets to pass, in order:

| Builtins-only corpus | Cases | Brush (browser) | Bashkit source |
| --- | ---: | ---: | ---: |
| Oils | 1,682 | 78.4% | 95.4% |
| Brush suite | 1,889 | 70.8% | 84.1% |
| Bashkit suite | 2,223 | 82.1% | 96.2% |

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

0. **Skeleton.** A Rust workspace at `shell/` in this repository (it moves with the product repository later). Vendor Bashkit's parser unchanged at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT): pin it in `sources.lock.json`, add it to `THIRD_PARTY_NOTICES.md`, and run its upstream parser tests in `npm run test:rust`. The spike's proof (`/work/tmp/own-shell-spike-tloM5o/proof`) is the starting reference, not code to extend blindly: its mock processes, polling reactor and toy commands are replaced.

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
   1. Words: quoting, parameter expansion, word splitting, pathname expansion, tilde and brace expansion.
   2. Command substitution and arithmetic.
   3. Control flow: `if`, `for`, `while`, `until`, `case`, `[[ ]]`, `test`, `&&`/`||`, `!`, `set -e` and its exceptions.
   4. Functions, `local`, positional parameters, `return`, `shift`, `set --`. Ordinary function calls share the caller's state. Asynchronous lists and subshell environments get an isolated copy, and so do pipeline stages, except the last stage under bash's `lastpipe` rules. Local, positional and trap frames unwind correctly when a task is cancelled. (The spike caught a wrong copy once.)
   5. Redirects and here-docs, including `exec` descriptor changes.
   6. State-changing builtins: `cd`, `pwd`, `export`, `unset`, `declare`/`typeset`, `readonly`, `read`, `mapfile`, `printf`, `echo`, `eval`, `source`, `type`, `command`, `getopts`, `shopt`, `set`.
   7. Arrays, associative arrays and namerefs.
   8. Traps (`EXIT`, `ERR`, `DEBUG`, `RETURN`, signals) and aliases.
   9. Process substitution `<(…)` `>(…)` and coprocesses, as live descriptors, never captured text.
   10. Job control builtins: `jobs`, `fg`, `bg`, `wait`, `kill`, `disown`.

4. **Utilities.** Commands that don't change shell state are separate WASI programs started through the process host, starting with a uutils multicall binary plus `grep`, `sed`, `awk` and `jq`. Measure spawn cost per command (brush-web measured about 18 ms per warm child). Where loops make it hurt, add in-process versions of the hottest tools (`cat`, `head`, `tr`, `wc`, `grep`) as tasks on the engine's streaming descriptors. The "cases needing external commands" rows of `npm run compat` track this.

5. **Interactive session.** Prompt, completion requests from the terminal, history, Ctrl+C and Ctrl+Z at the prompt, `$?` carried between commands, `exit`. The terminal owns line editing.

6. **Replace Brush.** When the new shell beats Brush on all three corpora, passes every acceptance test and guardrail, and runs on a live shared filesystem (plan 001 step 2, or equivalent demonstrated coherence: running children see editor and shell writes, and sibling processes see each other's writes, before anyone exits), make it the workbench's default shell. Brush stays selectable for comparison until Bashkit's held-out scores are also passed.

## Out of scope here

The runtime itself (plan 001 step 2 and `handoff-runtime.md`), the terminal choice, the product's look and its repository.
