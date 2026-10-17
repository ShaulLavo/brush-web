# Shell workspace

Plan [004](../plans/004-own-shell.md) now has a parser library and an original
async engine with a runnable native/WASI CLI. Brush remains the workbench's
default. The native fixture process host stays separate from the runtime-backed
WASI executable; step 1's real browser gate remains mandatory before replacing Brush.

## Parser and provenance

Package `shell-parser` (`shell_parser` in Rust) exposes Bashkit's parser and AST:

```rust
use shell_parser::{Command, Parser, Script};

let script: Script = Parser::new("echo hello | cat").parse()?;
assert!(matches!(&script.commands[0], Command::Pipeline(_)));
```

The parser starts from `everruns/bashkit`, revision
`491c3281f668b76d64b15210b8f5d7bf97244be0`, directory
`crates/bashkit/src/parser/`, including its upstream unit tests. It is now our
parser and may change freely. Its MIT license is retained at `parser/LICENSE`.
The `shellParser` entry in `../sources.lock.json` records that base revision,
local changes and reasons, and the license checksum.
`node scripts/check-shell-parser.mjs` verifies that provenance record and license,
not source byte identity. Keep upstream parser tests running; remove one only for
a deliberate behavior change recorded with a reason in `removedUpstreamTests`.
Rustfmt skips the imported module to avoid unrelated formatting changes.

The spike at `/work/tmp/own-shell-spike-tloM5o/proof/parser` was inspected only as
a reference for extracting the module. Its adapters and mock engine are not
included. `parser/src/{error,limits,time_compat}.rs` and the root wrapper are
**original adapters** implementing only what the parser needs:

- `error`: typed syntax/resource errors and a byte-bounded UTF-8 diagnostic writer;
- `limits`: real configurable parser input-size, AST depth, operation fuel,
  parser timeout, request work allowance and request timeout; cloned work budgets
  share counters and a sticky failure, including cancellation;
- `time_compat`: `std::time::Instant`, which is monotonic on native and WASI
  preview 1. No Tokio, JS clock, process runtime or interpreter is imported.

These are not the full Bashkit `ExecutionLimits` or execution budget. In
particular, they do not implement command, loop, output, memory or process limits.
The upstream `validate_budget(&Script, &ExecutionLimits)` is a separate optional
AST plausibility check using fixed upstream ceilings; it does not enforce the
configured runtime limits. The parser's hard AST depth ceiling remains 100.

## Engine integration

`parser::{Parser, ParseOptions, Script, Command, Word, WordPart, Span, ...}` is
public and re-exported at crate root. No alternate AST or translation layer is
introduced. The unchanged `Parser` supports aliases, extglob, recovering parses
and caller-supplied depth/fuel/timeout limits.

Prefer `parse(source, &ExecutionLimits)` for a complete bounded parse. To share
work across multiple parses in one request, construct
`ExecutionBudget::new(&limits, Arc<AtomicBool>)` and pass clones to
`parse_with_budget(source, &limits, budget)`. Cancellation is checked at parser
work checkpoints; parsing is synchronous, not preemptible or an async yield point.
The direct upstream `Parser` API does not check maximum input size: its caller
must do that and attach the budget with `with_execution_budget`. Input size is
measured in UTF-8 bytes before the wrapper constructs the parser. The shared work
counter does not reset in nested command substitutions. Parser-local fuel and
AST depth errors retain the upstream syntax-error representation; request work,
cancellation and timeouts return `Error::ResourceLimit`.

The separate engine owns execution semantics, async scheduling, descriptors,
process hosting and session state. The parser crate does not implement them.

## Verification

From the repository root, using the pinned Rust toolchain:

```sh
npm run test:rust
cargo fmt --manifest-path shell/Cargo.toml --all --check
npm run build:shell
```

`test:rust` checks parser provenance and the retained license, runs all upstream parser unit tests plus
original adapter/API tests, then retains the existing Brush tests. CI runs that
command and the WASI release build. `build:shell` produces the runnable
`.build/shell/wasm32-wasip1/release/shell-engine.wasm` CLI as well as the libraries.
`../scripts/notices.mjs` includes the pinned MIT license and this workspace's Rust
dependency licenses in the existing distribution notices flow.

## Async engine core

The original async [engine core](engine/README.md) is now tested natively and under
wasmtime against an explicitly in-process `ProcessHost`. This is not the browser
worker gate: Brush remains the default. The runtime adapter below is the browser
embedding, separate from this native test host.

## CLI and fixed compatibility scoreboard

```sh
npm run build:shell
wasmtime run .build/shell/wasm32-wasip1/release/shell-engine.wasm -c 'echo hello; exit 7'
npm run test:shell:wasi
npm run test:shell:scoreboard
npm run compat:shell
```

`-c SCRIPT` accepts exactly one script with empty stdin. The exit status is the
script's status. stdout and stderr use independent 32 KiB pipes drained between
executor turns with 8 KiB host scratch. The CLI imports its environment, uses
`PWD` for its virtual cwd, and keeps file writes in a fresh 16 MiB memory filesystem.
Its `ProcessHost` registers only the original `argv.py` and `printenv.py` fixture
commands shared by the compatibility engines. It never launches host processes.
The two helpers stream through the same bounded descriptors.

`compat:shell` uses `own-shell` in frozen-oracle mode. It builds only that engine
and runs the fixed builtins-only cases from the committed GNU bash fixture.
It needs Node 26.7.0 and the Rust toolchain, but no installed bash, submodules,
corpus downloads, npm dependencies or other engines. Set
`BASH_COMPAT_SKIP_BUILD=1` to reuse the release WASM. The separate CI compatibility
job does this after its release build. WASI streaming tests and the brotli-11
1,000,000-byte ceiling remain in the existing shell job.

See [the comparison method and commands](../docs/bash-compatibility.md#own-shell-fixed-scoreboard)
for exact identities, skips, target-branch checks and baseline updates. The first
measured baseline is 288/1,682 Oils, 295/1,888 Brush-suite and 445/2,222
Bashkit-suite. Two freshly nondeterministic oracle cases explain the smaller
secondary denominators. Candidate baselines must include every current passing
case; CI separately rejects any corpus count below the target branch. Browser cold-start measurement is deferred until browser
integration; this CLI establishes no cold-start or browser acceptance result.


## Runtime-backed interactive guest

`cargo build --manifest-path shell/Cargo.toml --release --target wasm32-wasip1
-p shell-engine --bin shell-runtime` builds the persistent guest. The browser
publishes it as `/programs/shell-engine.wasm`; the existing `shell-engine -c`
fixture executable and its in-process compatibility registry are unchanged.

Start the runtime guest with argv `['shell-engine', '-i']` (or `-c SCRIPT`).
It imports the environment, uses `PWD` for its cwd, and defaults `PS1` to `$ `.
Provide a preview1 `/` preopen and runtime_proc using **the same descriptor
table**. Opens use preview1 `path_open` for immediate metadata; reads, writes,
pipes, child waits and job waits use runtime_proc. The guest requires
`wait_job(job, 1, status_ptr)` and job-completion poll kind 4 in addition to the
base process ABI. Shell-local group numbers are not runtime job IDs: the first
spawn creates a job and `job_of(pid)` supplies the ID later stages join.
Background lists create independent background jobs and survive later commands.

Only the embedding's reactor calls blocking `runtime_proc.poll`, between executor
turns. Endpoint futures register removable read/write/exit/job subscriptions and
retry EAGAIN without blocking. Subscription and event records are each 16-byte
little-endian records. Endpoint clones share one owned runtime fd binding; its
last drop calls preview1 `fd_close`. Spawn synchronously retains all inherited
bindings, including nonstandard descriptors. Job completion waits for runtime
confirmation of descendant teardown before releasing the group.

The guest owns basic terminal echo, history, UTF-8-aware backspace, cursor arrows,
Home/End, Delete and common control-key editing. Forward raw terminal input
without browser local echo. Send SIGINT to the shell PID: foreground cancellation
forwards it to the mapped job, while unrelated background jobs persist. At the
prompt SIGINT clears the edited line. Ctrl-D on an empty line or `exit` shuts down
all shell-owned jobs. Parser and execution budget checkpoints dequeue signals
even while the guest has not returned to the worker message loop.

The guest also imports `shell_terminal.phase(i32)` for embedding/test state:
1 means prompt painted and editor ready, 2 means a command is running, and 0
means shutdown. This is UI metadata only, not a command or descriptor channel.
