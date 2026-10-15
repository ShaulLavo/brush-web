# Brush browser runtime

The shell is the pinned upstream Brush interpreter. The browser worker instantiates a `wasm32-wasip1` executable and provides WASI filesystem and byte-stream imports. No command crosses into the development server or the host OS.

`rust/brush-browser/src/main.rs` constructs one persistent `brush_core::Shell`, registers native Brush builtins plus the small Rust browser command host, then runs `InteractiveShell` with upstream `VtInputBackend`. The shell owns variables, aliases, functions, cwd, history and exit status. The existing VT editor owns echo, cursor movement, completion and history navigation. The worker's input bridge owns canonical input while commands read stdin. The output bridge owns LF-to-CRLF translation, including incremental writes. Ghostty interprets the resulting bytes and terminal modes.

WASI makes ordinary Rust filesystem calls useful without adding a second filesystem model to Brush. Files are session-local browser memory. The browser host mounts `/home/guest` and `/dev/null`. Native process creation remains unavailable. Registered WASI programs run through the [browser external command host](external-commands.md). Brush uses ordinary command lookup before the host starts a child worker.

## Worker import contract

The Rust module imports functions from the `browser` WebAssembly module. Pointers and lengths refer to the WASM memory, and integers are wasm i32 values.

| Function | Meaning |
| --- | --- |
| `read(ptr, len) -> i32` | Read input bytes. Nonnegative values are byte counts; zero is EOF; -1 is an explicit interrupt; -2 is shutdown. |
| `wait(timeout_ms) -> i32` | Wait in the worker for input or resizing. 1 means ready, 0 means timeout, -1 means interrupt. |
| `columns()`, `rows()` | Current terminal size. |
| `raw_mode(enabled)` | Use byte input for the native line editor or key demo; restore canonical command input when disabled. |
| `cancelled() -> u32` | Read the sticky cancellation flag. |
| `clear_cancel()` | Clear cancellation after execution has unwound, at the next prompt boundary. |
| `sleep(ms) -> i32` | Interruptible worker wait. Zero means elapsed, nonzero means cancelled. |
| `event(kind, value)` | Phase notification: 1 for a prompt, 2 for execution, 3 for exit with the status in `value`. |

Input and output use bounded shared rings. Only the dedicated worker waits with `Atomics.wait`. The main thread publishes bytes, resize epochs, interrupts and shutdown directly into shared memory; a blocked worker cannot run Comlink callbacks. Comlink handles asynchronous initialization and control outside the blocking shell execution.

The module also exports `browser_scalar_width(codepoint) -> u32`. The host uses the same pinned `unicode-width` 0.2.2 scalar table as Brush's editor to erase canonical stdin cells. Invalid Unicode scalars and nonprinting control characters return zero. Caret notation for echoed ASCII controls remains a host translation. Ghostty's default mode 2027 is off, so joined and modified emoji retain the sum of their scalar cell widths.

## Upstream patch

`patches/brush-browser.patch` applies to the pinned submodule revision. Changes are local to this repository, with no upstream publication.

- Add opt-in `browser-host` cancellation imports inside Brush's platform layer. Check them between commands and on each shell loop iteration. Propagate interrupts out of the complete program instead of running the remaining commands. The interactive loop sets status 130 and starts the next prompt on the existing shell.
- Treat explicit browser interrupted reads as Ctrl+C while preserving native terminals' existing retry behavior for incidental interrupted system calls.
- Recognize bracketed paste in the native VT backend. Insert pasted text atomically, including embedded newlines, and wait for a separate Enter before executing. The pending paste limit is 256 KiB. Newlines in the edit buffer use upstream readline-style `^J` display.
- Enable bracketed paste while editing and disable it for commands.
- Redraw on browser resize notification `ESC [ 997 ~`, query columns again and update the editor's cursor-row calculation. The browser sends this internal event through the same incremental key decoder.
- Move and delete whole Unicode grapheme clusters, including combining accents, joined emoji and skin-tone modifiers. The VT renderer keeps ordinary scalar-cell measurement to match Ghostty's default mode with grapheme clustering mode 2027 off.
- Bound WASM pipeline buffers at 1 MiB. Upstream runs synchronous pipeline stages sequentially on its single-threaded WASM runtime, so blocking a producer on a full pipeline buffer would deadlock before the consumer starts. Oversized pipelines fail explicitly. Terminal output streams incrementally through the separate bounded shared ring.
- Replace WASM's unconditional readable, writable and executable answers with actual browser filesystem existence and file probes. Open `/dev/null` through the browser WASI host.
- Enable Brush's existing `printf` on WASI, moving its portable formatting dependency out of the native-only dependency section. Native signal helpers stay target-specific.
- Reject terminal `read -n`, `read -N`, `read -s` and `read -d`, since this host's canonical driver does not implement their byte-count, echo or delimiter modes. Reject `read -t` because upstream WASM polling is unsupported. Plain `read`, `read -r` and `read -p` continue to work; byte-count and delimiter reads from files and buffered pipelines retain upstream behavior.
- Buffer unlimited regular-file `mapfile` reads at 8 KiB only when the single-worker browser host opts in. Restore unread bytes to the shared file position after early termination. Limited reads, terminal input and pipes retain their original reads. Check cancellation before each underlying refill.

## Command host and limitations

Native Brush builtins remain the default Bash-mode builtin set. Browser utilities implemented in Rust are `cat`, literal-only stdin `grep`, `ls`, `mkdir`, `touch`, `rm`, `seq`, `sleep`, `clear`, `uname`, `keydemo` and `browser-help`. They are registered as shell builtins, so Brush still performs parsing, expansion, pipes and redirections. Unsupported utility options fail explicitly. These implementations are small demonstrations, not full coreutils replacements.

The browser `seq` utility buffers at most 8 KiB of output and checks cancellation for every number. The WASI host grows file capacity geometrically within its logical-data and reserved-capacity budgets. The [performance proof](performance-proof.md) documents the measurements and remaining losses.

`keydemo` enters the alternate screen, prints key bytes and the current size, redraws when resizing wakes its read, and leaves on `q`, EOF or Ctrl+C. Its cleanup restores the cursor, alternate screen and canonical input. This demonstrates the browser byte/mode bridge, not arbitrary native TUI compatibility.

Pipelines buffer between sequential stages instead of streaming concurrently. Background jobs, coprocesses and process substitution fail explicitly because blocking input cannot share this worker with concurrent jobs. Arbitrary native programs are outside the milestone. `read -e`, `read -t`, terminal byte-count and silent reads, some terminal-control options and signal/trap delivery remain unsupported and fail explicitly. Cancellation checks cover shell command and loop boundaries and blocking host operations. A single expensive parser or regular-expression operation does not yet have an internal cancellation checkpoint.

## Rust checks

The build uses Rust 1.98.1 and the `wasm32-wasip1` target. Dependencies are captured in the runtime's `Cargo.lock`.

```sh
cargo +1.98.1 check --manifest-path rust/brush-browser/Cargo.toml --target wasm32-wasip1 --locked
cargo +1.98.1 build --manifest-path rust/brush-browser/Cargo.toml --target wasm32-wasip1 --release --locked
cargo +1.98.1 test --manifest-path vendor/brush/Cargo.toml -p brush-interactive --features vt --lib vt::
cargo +1.98.1 fmt --manifest-path rust/brush-browser/Cargo.toml --check
```

The VT tests exercise real upstream key decoding and editor behavior, including fragmented Unicode and escape sequences, complete grapheme editing, completion, history, interrupted-read retry, safe bracketed paste and resize notifications. Browser interaction tests remain the acceptance check for the worker bridge and rendered terminal.
