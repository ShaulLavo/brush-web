# Async shell core

This is plan 004's engine core, **not step 1's browser-worker gate**. Brush remains
unchanged and is still the workbench default. The `shell-engine -c` executable is
a native/WASI embedding and release-size harness; its process registry is empty.
It is not a new browser shell or a replacement external-command host.

## Execution contract

- `Executor::drive(max_polls)` makes a bounded nonblocking host turn. Futures stay
  on one thread. Every pipeline stage, subshell and asynchronous list gets a task.
  The ready queue contains only notified tasks; there is no sleep/poll reactor.
- `IdleWakeSource` supplies a generation-counted, race-safe notify/park boundary.
  `park_if_idle` checks the ready queue after taking the generation snapshot.
  A browser embedding can drive turns instead of blocking. A stage never parks.
- `Cancel` registrations are removed on drop. Commands, loops, expansions and
  streaming builtins check interruption and yield on a bounded work quantum.
- Session-owned background jobs survive a foreground invocation. `interrupt`
  targets only the foreground; `shutdown().await` cancels and joins all jobs.
  Isolated environments have their own child-job scope: they cannot wait on or
  kill parent jobs, and cancel/join their children before leaving. Root-shell
  backgrounds remain session-owned. Process-group guards transfer kill-and-reap
  ownership to the host if dropped.
- Ordinary functions share caller state. Pipeline stages (with more than one
  stage), subshells and background jobs copy shell state. Positional arguments,
  local declarations and local export attributes have cancellation-safe guards.
  `lastpipe` is not implemented; no stage of a multistage pipeline runs in the
  caller's environment.
- Descriptor tables clone references to open endpoints, including a shared file
  offset for duplicated file descriptors, never endpoint data. Redirections are
  scoped; `exec` changes the current descriptor table across session commands.
  Arbitrary descriptor numbers reach `ProcessHost::spawn`, not only 0, 1 and 2.
- `ProcessHost` accepts argv, exported environment, cwd, descriptor bindings and
  job/parent identity. Spawn/kill return without waiting; waits register exit
  notifications. The host allocates group identities, so sessions sharing a host
  cannot collide. Group waits confirm cleanup without collecting exit history;
  individual waits return exit status. Kill includes descendants, and termination
  must confirm exits, including interruption during the final cleanup wait.
  Broken pipe is an I/O error: an unhandled writer returns 141; a guest that
  handles EPIPE retains its chosen exit code.

`InProcessHost` is the stand-in for these tests, not an OS or browser process
implementation. Its registered programs run as tasks on the same executor.
`HostEndpoint` is the extension point for runtime-backed readiness and streams.
The shared runtime must map that contract onto its eventual guest ABI; no ABI
numbers, browser worker transport or shared-memory layout are frozen here.

## Explicit bounds

| Boundary | Bound / policy |
| --- | --- |
| Pipe / terminal queue | 32 KiB of queued bytes, partial writes and backpressure |
| Producer/consumer scratch | At most 8 KiB per copy iteration |
| Capture | Caller supplies a byte ceiling; overflow returns `LimitExceeded` |
| Accumulating test consumer | 64 KiB capture, explicit failure (not unbounded collection) |
| Memory filesystem | Caller supplies total data ceiling; growth fails |
| Source input | 256 KiB per invocation plus parser depth, fuel, work and time limits |
| Expanded command | 1 MiB, at most 4,096 argument words |
| `read` line | 64 KiB, explicit failure |
| Pipeline / jobs / function nesting | 128 stages / 128 retained jobs / 128 function frames |

A terminal is a bounded endpoint drained by the host, not a result string appended
until exit. The standalone harness drains it **between** executor turns. The real
browser adapter must apply the same bound to worker/terminal transport queues;
a local pipe test does not establish browser memory bounds.

## Deliberately narrow rules

Supported for the gate: literal/quoted words, ordinary variables and positional
parameters, `$?`, `PIPESTATUS`, scalar assignments, function definitions/calls,
AND/OR lists, background lists, brace groups, subshells, `while`, pipelines,
`pipefail`, `!`, file/append/input and descriptor-duplication redirects, and a few
streaming/state builtins. Broad Bash expansion, splitting, globbing, substitution,
arrays, traps, aliases, `lastpipe`, directory validation and full utility option
coverage are not implemented. Unsupported AST forms return status 2. Utility
names/format options here are not claims of full Bash compatibility.

The interpreter, scheduler, descriptors, process adapter and test programs are
original implementations, not copied or adapted Bashkit interpreter/builtin code.
Only `../parser/src/parser` is vendored, unchanged, as recorded in the source pin.
No known Bashkit buffering or `mapfile` implementation is ported.

## Verification

`npm run test:rust` includes the workspace's native tests and the unchanged
upstream parser tests. `npm run test:shell:wasi` runs the engine unit/streaming
tests under wasmtime, builds the release WASI embedding, checks a status smoke,
and enforces a brotli-11 ceiling of 1,000,000 bytes. It reports raw/compressed bytes.
This is a core-size baseline; the future browser process adapter must stay inside
the same final-shell ceiling.

`tests/streaming.rs` adapts all sixteen tests across the seven scenarios from
`pipelines.acceptance.spec.ts`: live filtering, all four >1 MiB builtin/external
pairings, cancellation, seven Bash pipeline-status cases, early reader exit,
state inheritance, and slow-reader backpressure. Extra tests cover handled EPIPE,
a continuously ready background loop, independent background lifetime, frame
unwinding, inherited nonstandard descriptors, bounded captures and a slow terminal.
All external programs are explicitly stand-ins. Real Bun children, Ctrl+C's
shared interrupt word, worker exit acknowledgment, live shared files and cold
browser startup remain step 1's unpassed gate; no browser acceptance score is
claimed here. Step 2 will register this engine with the corpus scoreboard.
