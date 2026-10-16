# Async shell core

This is plan 004's engine core, **not step 1's browser-worker gate**. Brush remains
unchanged and is still the workbench default. The `shell-engine -c` executable is
a native/WASI CLI and release-size harness; its process registry contains only
the shared `argv.py` and `printenv.py` compatibility fixtures.
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
| Expanded command | 1 MiB, at most 4,096 fields including command name and assignments |
| Expansion work | Per command: source-byte + expansion-byte + argument capacity in character/part/element steps; cooperative yield every 64 steps; intermediate word bytes also capped at 1 MiB |
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
streaming/state builtins. The first word area adds quote-aware fields for literals,
ordinary variables, positional parameters and `PIPESTATUS`, including IFS splitting,
quoted `@` boundaries, `*` joins and command-name field promotion. Assignment and
`export`/`local` assignment operands retain scalar expansion. Scalar default and
alternative operators (`-`, `:-`, `+`, `:+`) lazily expand selected operands with
quote protection and shared work limits. Scalar assignment operators (`=`, `:=`)
store selected, quote-removed values without field splitting; their completed
writes persist in the calling shell. Scalar error operators (`?`, `:?`) stop the
containing shell, while subshells, pipeline stages and background jobs contain
those failures. Error operands split unquoted expansions using IFS and join fields
with ASCII spaces, preserving direct literal whitespace and inner quotes even
when the error is selected inside a trim pattern. Surrounding quotes and scalar
contexts do not suppress diagnostic splitting. All eight forms currently require
ordinary identifier targets.
Scalar indirection (`${!pointer}`) resolves one ordinary identifier pointer to
one ordinary identifier scalar target. The eight scalar operators above also
apply to that resolved target: `${!pointer:-fallback}`, `${!pointer:=value}` and
`${!pointer:?message}`, with their non-colon and alternative forms. Valid unset
targets expand empty or select their operand; unset, empty and invalid pointers
are fatal status 1 errors. Selected error operands retain the existing fatal
parameter status and identify `!pointer`; nested errors keep their own names.
Quotes, final IFS splitting, lazy operands, persistent writes and child containment
use the existing machinery. Pointer/value snapshots share command storage/work
before copying; scans and identifier validation yield and check cancellation.
There is no target-string reparse. Positional/special pointers and targets,
arrays/namerefs, prefix listing, options and all generic indirect suffixes
(including trim, case, replacement and substring) remain status 2 unsupported.
Subscript-bearing target strings are rejected without interpreting their contents.
Supported indirect results can appear inside existing lazy operands, trim
patterns, diagnostics, scalar assignments, declarations and redirects. This does
not add indirect length or suffix composition; the existing parser AST is unchanged.
Scalar length (`${#name}`) also supports ordinary identifiers, positive positional
parameters, `$?` and `$#`; unset values have length zero. `C`/`POSIX` count bytes;
recognized UTF-8 locales count Unicode scalar values, not grapheme clusters.
Locale selection follows nonempty `LC_ALL`, `LC_CTYPE`, then `LANG`, defaulting to
`C`; unrecognized locale names use bytes rather than claiming full locale emulation.
List/array length and `${#0}` remain unsupported. Length reads and counting share
the command's storage/work limits and cooperative cancellation checkpoints.
Scalar prefix/suffix removal supports ordinary identifiers with `#`, `##`, `%`
and `%%`, using literals, `*`, `?` and basic bracket expressions, including
ranges and negation. Patterns expand supported scalar operands lazily; empty
and unset values skip the pattern. Outer quotes protect the returned value;
quotes and escapes inside the pattern protect its metacharacters only. Pattern
side effects participate in final IFS splitting and existing scalar contexts.
Matching uses Unicode scalar values and codepoint ranges, checked against focused
GNU Bash probes under `LC_ALL=C.UTF-8`. Byte-oriented non-UTF-8 matching and locale
collation are deferred. Selected extglob, named classes and collating/equivalence
symbols return status 2. The matcher allocates no candidate strings; snapshots,
pattern/state storage and all matching steps share command bounds and cancellation.
Scalar replacement supports `${v/p/r}`, `${v//p/r}`, `${v/#p/r}` and
`${v/%p/r}` for ordinary identifiers and the same basic UTF-8 patterns. Matches
are leftmost-longest. A leading unprotected `#`/`%` in an expanded first pattern
anchors it; global patterns treat those characters literally. Unset targets
skip operands, while set-empty targets evaluate them. Patterns expand before
replacements, even when nothing matches. Inner pattern quotes protect matching;
inner replacement quotes and escapes control Bash 5.3's default
`patsub_replacement` ampersands. Outer quotes protect only the result, whose
unquoted text uses final IFS. Assignment, declaration and redirect contexts
retain scalar behavior. Matching allocates no candidate strings or range list;
search, snapshots, replacement retention and output share command bounds and
cancellation checkpoints. Exhaustion fails with status 2 before dispatch;
cancellation returns 130. Arrays, namerefs, option changes, byte locales and
locale collation are outside this subset. Selected unsupported syntax fails
closed. Empty patterns are inert except first-replacement empty anchors;
global empty matches advance without revisiting the end of nonempty input.
Scalar arithmetic supports `$((expression))`, `((expression))` and `let`, with
signed 64-bit wrapping values, Bash numeric bases, operator precedence, recursive
scalar variable values, assignments and increment/decrement. Logical operators
and ternaries skip unselected arithmetic evaluation without skipping syntax
validation. Shell dollar expansions happen before evaluating arithmetic syntax;
`let` receives arguments already expanded by the ordinary word machinery.
Completed variable writes remain visible even if a later operation fails.
Arithmetic expansion errors return status 1 and discard the current top-level
read unit, including same-line commands and active function/compound bodies.
Execution resumes at the next top-level newline. Arithmetic commands and `let`
instead return status 1 and allow the next command in the same unit to run.
Resource exhaustion remains status 2 and cancellation 130.
Scalar `${v:offset:length}` supports ordinary identifiers, positive positional
parameters, `$?` and `$#`, with arithmetic expressions for the offset and optional
length. UTF-8 locales count Unicode scalar values;
C/POSIX and unknown locales count bytes, following scalar length's locale rules;
selected byte slices must land on UTF-8 boundaries or return unsupported status 2
rather than emit invalid text. Arbitrary byte-valued shell strings remain deferred.
`${@:offset:length}` slices positional fields, retaining quoted empty elements.
Offset zero includes the configurable `State::shell_name`, which defaults to `bash`.
Negative offsets count from one past the last positional argument; negative
lengths are errors. Source elements are copied and charged one at a time.
The source value is snapshotted before arithmetic side effects. Unset sources skip
both expressions, and out-of-range offsets skip the length expression. Slices
retain outer quote protection and final IFS splitting. Shell-word boundary errors
are fatal status 127; errors found while extracting brace operands are fatal status 1,
including nested slices in unused default values. Earlier complete lines still run.
Process-substitution lookalikes are checked as shell grammar without executing them.
Arithmetic parsing,
recursive evaluation, snapshots and character scans share the command's bounded
storage/work accounting and cancellation checkpoints. Arrays, subscript arithmetic,
namerefs and command substitution remain outside this scalar arithmetic subset.
Nested scalar operands have an explicit depth limit of 16, exercised through the
deepest accepted level in both native and WASI tests.
Other parameter operators, pathname globbing, command substitution, arrays, traps,
aliases, `lastpipe`, directory validation and full utility option coverage are not
implemented. Whole-script parsing retains the original separator policy. Captured
shell bodies used by substring boundary validation explicitly request
`Parser::with_strict_command_separators`; nested parsers inherit that policy.
Unsupported AST forms return status 2. Utility names/format options here are not
claims of full Bash compatibility.

The scheduler, descriptors, process adapter and streaming execution are original
implementations. Word expansion and its focused `tests/words.rs` cases adapt the
Bashkit sources recorded separately in `sources.lock.json` and
`THIRD_PARTY_NOTICES.md`. Protection is structural, with cooperative work and
explicit intermediate/aggregate limits instead of sentinel strings or truncation.
The parser starts from Bashkit at the recorded base revision and is maintained
freely with local changes recorded in the source pin. No known Bashkit buffering or
`mapfile` implementation is ported.

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
claimed here. Step 2 registers `own-shell` with the fixed GNU bash corpus
scoreboard through `npm run compat:shell`; see the workspace README.
