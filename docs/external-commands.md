# External commands in the browser

The default Brush engine can run `bun` as an external WASI program in a separate browser worker. The shell keeps its variables and current directory. Commands never run on the server or host OS. The examples and historical host limits below describe Brush; the separate `own-shell` integration and its current runtime limitations are called out explicitly.

```sh
printf 'console.log("first"); await Bun.sleep(1000); console.log("last");' > x.ts
bun run x.ts
bun run x.ts | grep first
printf 'console.log(await Bun.stdin.text());' > read.ts
echo hi | bun run read.ts
bun -e 'process.exit(7)'; echo $?
bun -e 'require("node:fs").writeFileSync("note", "from child")'; cat note
```

Output arrives while the child runs. Stdin, stdout, and stderr carry bytes, including NUL and invalid UTF-8. Files and pipes do not apply terminal newline conversion. The stdin pipe and the tagged stdout/stderr pipe each hold at most 64 KiB and apply backpressure. The output tags preserve write order for `2>&1`. Brush pumps all three streams together, so a child can write while it reads.

Ctrl+C terminates the child worker, stops the rest of the submitted command list, and sets the shell status to 130. The same shell returns to its prompt. Terminal stdin supports canonical lines and Ctrl+D for EOF. It does not provide a child PTY or raw terminal control.

On child completion, unread terminal input is discarded, including unfinished canonical lines and bytes still queued for the child. It never becomes a shell command or input to the next child. This avoids executing text intended for the finished child. The host clears canonical and pending line buffers at that handoff.

## Runtime source and guest provenance

The new shell integration consumes the vendored runtime package, not Brush's old one-child host. Its immutable source pin is `bunWasm.runtimeRevision` in `sources.lock.json`: `1d251a99d3d22a4c33c78d4eb7425e5e69299e82`. `node scripts/check-runtime-source.mjs` verifies the complete vendored tree, hashing sorted relative paths and file contents separated by NUL bytes.

| Classification | Upstream source | Local destination | Changes and reason |
| --- | --- | --- | --- |
| Unmodified owned-runtime copy | `ShaulLavo/bun-wasm`, `runtime/`, revision above | `third-party/bun-wasm/runtime/` | Byte-for-byte package copy, including tests and metadata. Provides core descriptor/WASI/FS APIs and the process ABI, worker transport, supervisor and bounded pipes. Kept separate from the shell so the later `waffle` package switch changes imports, not process semantics. |
| Unmodified built guest | `ShaulLavo/bun-wasm`, Bun source build `4af3c580a580270df82d1b051c12571a141ad883`, bundle provenance `1d251a99d3d22a4c33c78d4eb7425e5e69299e82` | `third-party/bun-wasm/bun.wasm.gz` | Deterministically gzip-compressed QuickJS guest copied from the coordinator-provided immutable bundle. Uncompressed SHA-256: `5f1f7eff76d83121b294f971ce5a88e2051167aa4c05e710d77d8391e0e0bd24`. The matching runtime tree includes the job-wait ABI and supervisor quiescence hook. |
| Historical unmodified host copy | `ShaulLavo/bun-wasm`, `web/src/{fs,wasi,subprocess-fs}.ts` and `web/src/net/trampoline.ts`, revision `c81bcce890c5b121d7fee0a3eeaf3c8fef34e5cc` | Top-level files in `third-party/bun-wasm/` | Retained solely for the default Brush engine. The new runtime-backed shell does not build on them. |

The guest, runtime sources, and historical Brush host have distinct pins. A runtime-only change need not rebuild unchanged guest code; a guest-code change requires a new traced artifact and hashes. The historical measurements below retain their recorded artifact identities.

### Browser host adaptations

The following source adapters originate at the distinct immutable browser-source revision `8d3d416aa9cb23718ed3487a33d0b06e8e373672`. Repinning the unchanged runtime package does not silently repin these adapted sources. Every adapted file carries its original path/revision in its header; none is presented as an unchanged copy.

| Classification | Upstream path → local path | Local changes and reason |
| --- | --- | --- |
| Adapted browser worker/control plane | `web/src/{worker.ts,subprocess-broker.ts,subprocess.ts,worker-pipes.ts,shared-fs.ts,fs-worker.ts}` → `src/runtime/` with the same names | Runtime peer imports and Vite worker URLs; persistent preview1 shell root; shared descriptor/terminal transport; process-local terminal admission and teardown; inherited-fd-safe root preopens and child shell imports; retained generic pipe stdin for legacy Bun subprocesses; memory sampling and process/pipe observability. Reuses the generic process service rather than the historical single-child Brush host; the legacy nested Bun subprocess bridge remains pending runtime step 7b. |
| Adapted engine host dependencies | `web/src/{engine-host.js,engine-host.d.ts,crypto-host.js,crypto-inputs.js,native-stream-state.ts,buffer-transfer.ts}` → `src/runtime/` with the same names | Peer import paths and local worker types. Preserve the actual Bun guest engine/crypto/stream host implementations rather than replacing Bun with a fixture. |
| Adapted networking support | `web/src/net/{host.ts,protocol.ts,trampoline.ts,ring.ts}` → `src/runtime/net/` | Runtime peer imports and worker-local paths; retains the engine host's existing network dependency boundaries. |
| Adapted terminal codec | `web/src/runtime-terminals.ts` → `src/runtime/runtime-terminals.ts` | Replaces callback/EOF terminals with transferable fixed-capacity shared terminal endpoint tokens; preserves arbitrary fd remapping and exposes immediate operations for `runtime_proc`. |
| Adapted root lifecycle | `web/src/runner.ts` → `src/runtime/browser-runtime.ts` | Extracted outcome/lifecycle fencing for a persistent preview1 root; Bun registry resolves a separate actual Bun module, never the shell module. One runtime instance can be supplied by an embedding. |
| Original shell embedding adapters | No upstream source → `src/{shell.ts,standalone.ts,shell-terminal-output.ts}`, `src/runtime/{limits.ts,terminal.test.ts,terminal-admission.ts,guest-imports.ts,guest-imports.test.ts,subprocess-broker.test.ts}`, `shell/engine/src/runtime{.rs,/wasi.rs,/tests.rs}`, `shell/engine/src/{runtime_main.rs,terminal.rs}` | Injected peer-runtime shell facade, standalone host entry, synchronous guest process imports, notification reactor, terminal editor, process-local terminal admission fencing, truthful preopen relocation/control imports and original regression tests. These implement the documented ABI; they are not copied upstream shell implementations. |

### Acceptance-only in-process utilities

Step 1 supplies `grep` and `mkdir` as engine tasks on the same streaming
file descriptors used by pipelines. They do not spawn workers and are not a
substitute for plan 004 step 4's general utilities.

| Classification | Source → local destination | Changes and reason |
| --- | --- | --- |
| Adapted Bashkit grep subset (MIT) | `crates/bashkit/src/builtins/grep.rs` at `491c3281f668b76d64b15210b8f5d7bf97244be0` → `shell/engine/src/builtins/grep.rs` | Retain the short-option, per-line selection/count/quiet and per-file status rules. Replace upstream input/output containers with bounded cancellable engine descriptors. Exact source SHA-256 and adapted items are in `sources.lock.json` under `shellAcceptanceUtilities`. |
| Original engine adapters | `shell/engine/src/{builtins.rs,io.rs,runtime.rs,runtime/wasi.rs}` and native regressions | Register both commands, resolve cwd-relative paths, implement directory creation through the runtime filesystem, and validate existing directories for `mkdir -p`. No upstream mkdir implementation copied. The grep BRE translator and regex/record bounds are original adapters, not a copy of Bashkit's full pattern compiler. |

`grep` accepts grouped `-v -c -q -n -i -F -E`, `--`, one positional pattern
(newlines separate alternatives), and optional file operands (`-` means stdin).
It returns GNU's 0 for a selected line, 1 for none, and 2 for invalid input,
I/O or resource errors; shell cancellation remains 130 and broken pipes 141.
`-q` stops immediately on a selected line, even after an earlier file error.
Multiple operands add filename prefixes; `-c` reports selected records per input.
It reads 8 KiB chunks and emits each selected line without waiting for producer
exit. One record is capped at the smaller of `Limits.line_bytes` and 64 KiB;
exceeding it fails explicitly rather than accumulating the stream. Patterns are
capped at 4,096 bytes, compiled regex programs and DFA caches at 256 KiB each,
and regex nesting at 64. Reads, per-byte scanning and output waits observe
cancellation; bounded regex compilation/matching are synchronous.

This is not full GNU grep: regex syntax uses a small BRE adapter or the linear
time regex engine's extended syntax, with no backreferences/PCRE, full locale
collation, long options, recursion or context flags. Record bytes (including CR,
NUL and invalid UTF-8) are preserved rather than classified as binary files.
Unlike the upstream accumulating paths, output is never collected into a command
result buffer (including the earlier bug25 architecture).

`mkdir [-p] [--] path...` uses Preview1 `path_create_directory`; `-p` creates
parents and uses `path_filestat_get` to accept existing directories, never files.
The memory test filesystem separately caps file and directory metadata at 1,024
names each and seeds `/`, `/home`, `/home/guest` and `/tmp`. Runtime directory
metadata calls share the already-deferred synchronous filesystem stall limitation
of file opens: cancellation between operations works, but a stalled service can
block an individual operation. This adds no blocking compatibility fallback and
does not claim the pending asynchronous filesystem gate is closed.

### Embedding and browser acceptance

`createShell({ runtime })` from `brush-web/shell` consumes a page-supplied runtime peer. It does not create or dispose the page's runtime. `brush-web/standalone` separately exports `createBrowserRuntime` for the demo. Runtime imports use `@bun-wasm/runtime` peer subpaths; a local source alias selects the pinned copy. The future `waffle` package switch belongs at that import boundary.

Brush remains the default. Select `?engine=own-shell` to run the Rust `shell-runtime` guest (published as `programs/shell-engine.wasm`). The new path owns a persistent filesystem worker and shell worker, plus a worker per external guest. Browser cleanup assertions compare against this startup baseline, not the historical assumption that a session always has exactly one worker.

`tests/pipelines.acceptance.spec.ts` retains the sixteen pipeline cases and explicitly asserts the selected engine. `tests/runtime-shell.spec.ts` adds foreground CPU interruption/background survival, arbitrary fd inheritance, handled EPIPE, continuing background output, and bounded shell/transport memory. The descendant-confirmation case is retained as an explicit known failure (`fixme`) pending runtime step 7b; it is not passing cancellation evidence. The two Bun inherited-fd3 cases are also explicitly pending: the pinned guest libc exits 71 on the truthful NOTSUP response before finding a relocated root preopen. The runtime owner must change the guest libc to skip occupied non-preopen descriptors; this shell does not fabricate successful preopen metadata. Builtins and direct runtime shell children retain active arbitrary-descriptor/root-preopen coverage. Background output may follow the waiting prompt, as in Bash; acceptance allows only that exact prompt prefix and still checks next-command usability and explicit kill/wait cleanup. Chromium and Firefox run the enabled cases in CI. Safari remains an owner-Mac verification gate; no Linux browser result is presented as Safari evidence. Child programs can deliberately accumulate input in their own heaps; per-program memory policy is a separate runtime concern, not evidence of shell buffering.

The full replacement gate remains open. Current runtime limitations also include a 1,024-slot lifetime process-directory limit (including the root), synchronous Preview1 filesystem opens/directory metadata calls that can block shell cancellation on a stalled filesystem service, and raw inherited terminal input without per-child canonical editing/EOF. [Plan 004](../plans/004-own-shell.md#steps) records the pending runtime work, retained limitation reproducer and filesystem test specifications. This integration does not claim that `poll` is already the sole blocking operation.

## Build the Bun asset

`npm run build` runs `npm run build:programs`. That script expands the pinned `third-party/bun-wasm/bun.wasm.gz` into ignored `public/programs/bun.wasm`, which Vite copies into `dist/programs/`. It verifies the gzip and uncompressed SHA-256 against `sources.lock.json`. A fresh checkout needs no Bun checkout or separate binary download.

The compressed source asset is committed because the public playground replaced its artifact during verification. The uncompressed size and both SHA-256 hashes are recorded in `sources.lock.json`. An immutable upstream release asset can replace the committed gzip later. Builds must continue to check the pinned hash.
The Bun playground defaults to a different engine, `bun-browser.wasm`. That engine runs JavaScript in the worker's own JS engine after WASM setup. This integration uses the complete QuickJS WASI executable, `bun.wasm`. It needs no service worker or JS engine bridge.

To supply the exact artifact locally, set its path before building:

```sh
BUN_WASM=/work/projects/bun-wasm/dist/bun.wasm npm run build
```

The source revision and artifact hashes are pinned in `sources.lock.json`. The stdin fix now comes from bun-wasm itself at revision `c81bcce890c5b121d7fee0a3eeaf3c8fef34e5cc`. Its runtime returns before calling Rust's buffered stdin reader for a zero-byte request. This was a bug in bun-wasm's own runtime, not in Bun. Without that guard, a zero-byte `fs.readSync` issues an 8 KiB WASI read and waits for input. The pipe transport also returns immediately for zero-capacity reads. bun-wasm's [patch documentation](https://github.com/ShaulLavo/bun-wasm/blob/c81bcce890c5b121d7fee0a3eeaf3c8fef34e5cc/docs/bun-patches.md#zero-length-stdin-reads-waited-for-eof) records the cause and regression coverage.

The committed artifact is pinned by hash, not reproducible byte for byte. Rebuilding the pinned revision gives a working binary with a different hash, because the build embeds absolute QuickJS and Bun dependency source paths. To build a comparable binary, make a worktree of bun-wasm at the pinned revision, source `env.sh`, prepare its Bun dependencies with `scripts/sync-bun.sh`, and run `JOBS=4 BINARYEN_CORES=2 scripts/build.sh`; supply it with `BUN_WASM` only after updating the pins. No local runtime patch is needed.

`BUN_WASM` supplies a local uncompressed artifact and must pass the same hash check. A changed guest requires a traced build revision and updated compressed/uncompressed hashes. A runtime-source-only repin updates the independent runtime revision and tree hash; it does not require rebuilding unchanged guest bytes.
The unmodified Bun filesystem and WASI host files live in `third-party/bun-wasm/`. Their original paths and source revision are recorded in the lock file. Bun, QuickJS, libc, and Temporal dependency licenses ship in `THIRD_PARTY_NOTICES.txt`.

## Register another WASI program

Add its absolute command path and same-origin WASM asset path to `src/wasi-programs.ts`. Arrange for the build to copy the executable under `public/`. The host creates a file at the command path so Brush's ordinary PATH search, `command`, and completion can find it. Those files identify registered programs; their contents are not executable code.

Every invocation starts a fresh worker and WASM instance. The page caches the compiled module for the session. Executable paths resolve against the current directory and normalize dot segments before lookup. The path must still name a regular file. Existing unregistered files and directories fail with status 126. Missing paths, including deleted registered programs, return 127.

`patches/brush-external-commands.patch` routes only the WASI browser build through seven host imports. Rust keeps the shell stream handles, pumps input and tagged output, and closes the child on every return path. The page owns worker creation and module caching, so a blocked shell cannot prevent a child from starting.

The host accepts WASI preview1 executables with exported memory and `_start`. It does not start native executables, run shebang interpreters, supply Bun networking slots, or support Bun's own nested subprocess APIs. Those capabilities need additional hosts. Only descriptors 0, 1, and 2 cross the command boundary; extra descriptor inheritance is unsupported.

## File ownership and current limits

The shell worker owns the filesystem. At spawn, the child receives a copy with the current files. At normal exit, including nonzero exit, only the child's changed and deleted paths merge back. The merge finishes before the shell observes the status or starts its next command. Shell writes to unrelated files, including redirected output, survive. A conflict at the same path uses the child's final value. A worker crash or forced termination drops its file changes.

The result buffer accepts at most 8 MiB of serialized changes. The merged shell tree must also fit the existing 8 MiB data and 1,024-object quotas. A failed merge returns status 1 without changing the shell tree. This is temporary copy-at-spawn behavior. Plan 001 step 2 replaces this adapter with one filesystem worker shared by the shell and children.

Brush still executes pipeline stages sequentially and limits each intermediate pipeline to 1 MiB. Terminal output streams live, but a downstream pipeline stage starts after the upstream stage finishes. A long-running producer below the limit keeps downstream waiting until it exits, so `bun dev | grep error` never shows live output. On overflow, Brush stops the producer and prints `browser pipeline buffer exceeds 1 MiB; stages execute sequentially`. The downstream stage still runs with the first 1,048,576 bytes. The overall pipeline can return 0 when the downstream stage succeeds; `set -o pipefail` makes the overflow return 1. Ctrl+C stops a waiting producer with status 130 and reaps its worker. Plan 001 step 1b replaces sequential stages with bounded streaming pipes.

The demo `grep` accepts one literal pattern on stdin; regexes, files, and options belong to the command work in step 3.

## Measure startup and command overhead

Run the production build, then:

```sh
npm run measure:external
```

The measurement owns its static server on port 4299 and its headless Chromium instance, and stops both on exit. Timings come from the shell worker's spawn import, first received output byte, and child cleanup. Cold includes the first asset fetch and WASM compilation. Warm reuses the compiled module while starting a fresh worker and instance. These values exclude shell startup and terminal drawing.

On 2026-10-15, unthrottled Chromium 156.0.8078.4 on an Intel(R) Core(TM) i7-14700K measured these times on localhost. The shell had its default small filesystem. The child used the bun-wasm pin above. The host was shared with other work.

| Command | Trials | First output | Spawn through cleanup |
| --- | ---: | ---: | ---: |
| `bun -e 'console.log(1)'`, cold | 1 | 92.0 ms | 92.3 ms |
| Same command, warm mean | 5 | 37.0 ms | 37.0 ms |
| `bun -e '0'` inside a shell loop | 20 | No output | 17.1 ms per command |

The complete 20-child loop took 342.7 ms. These are worker timings; terminal drawing is outside the measurement.

A paired run used the same production app with only the executable replaced. Before the re-pin, cold spawn through cleanup took 92.8 ms, warm mean took 37.4 ms, and the loop averaged 18.7 ms per command. After the re-pin, those values were 92.3 ms, 37.0 ms, and 17.1 ms. Cold and warm startup stayed within 1.2%. The loop was 8.8% lower in this sample. These shared-host measurements show no material startup regression and do not establish a speed improvement.

The recorded measurements and raw samples are in [external-commands.json](evidence/external-commands.json) and [external-commands-before-repin.json](evidence/external-commands-before-repin.json). Each record includes the measured executable's hash.
