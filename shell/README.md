# Shell workspace

Plan [004](../plans/004-own-shell.md) starts here. This is a parser library, not
an executable shell, interpreter, browser worker or process engine. Brush remains
the workbench's default; the existing compatibility scores and guardrails do not
change in this skeleton.

## Parser and provenance

Package `shell-parser` (`shell_parser` in Rust) exposes Bashkit's parser and AST:

```rust
use shell_parser::{Command, Parser, Script};

let script: Script = Parser::new("echo hello | cat").parse()?;
assert!(matches!(&script.commands[0], Command::Pipeline(_)));
```

All nine files in `parser/src/parser/`, including their unit tests, are copied
**unchanged** from `everruns/bashkit`, revision
`491c3281f668b76d64b15210b8f5d7bf97244be0`, directory
`crates/bashkit/src/parser/`. That directory is the only vendored code here. Its
MIT license is retained at `parser/LICENSE`. The `shellParser` entry in
`../sources.lock.json` pins the source and file/license SHA-256 checksums.
`node scripts/check-shell-parser.mjs` from the repository root verifies the exact
file set and bytes without downloading anything. Rustfmt skips the vendored
module so formatting the adapters cannot rewrite upstream source. Any upstream
update must update the pin, checksums and provenance together.

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

The future engine owns execution semantics, async scheduling, descriptors,
process hosting and session state; none are placeholders in this crate.

## Verification

From the repository root, using the pinned Rust toolchain:

```sh
npm run test:rust
cargo fmt --manifest-path shell/Cargo.toml --all --check
npm run build:shell
```

`test:rust` checks vendored checksums, runs all upstream parser unit tests plus
original adapter/API tests, then retains the existing Brush tests. CI runs that
command and the WASI release build. `build:shell` compiles the **library** for
`wasm32-wasip1`; it does not yet produce or publish a runnable `.wasm` shell.
`../scripts/notices.mjs` includes the pinned MIT license and this workspace's Rust
dependency licenses in the existing distribution notices flow.
