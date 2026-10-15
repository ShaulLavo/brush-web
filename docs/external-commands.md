# External commands in the browser

Brush can run `bun` as an external WASI program in a separate browser worker. The shell keeps its variables and current directory. Commands never run on the server or host OS.

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

`BUN_WASM` supplies a local uncompressed artifact and must pass the same hash check. Changing the runtime requires updating the source pin and compressed artifact together.
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
