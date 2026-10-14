# Bashkit comparison

Bashkit is a credible third browser-shell candidate. The evaluated package is `@everruns/bashkit-wasm@0.18.2`, published from the Bashkit repository at revision `567511386572d4c4b9f649ab1da97aad53b9f341`. Its inspected upstream `main` was `491c3281f668b76d64b15210b8f5d7bf97244be0`. The source lock records both revisions.

The package is a single-threaded `wasm-bindgen` build. It needs no `SharedArrayBuffer`, COOP, or COEP. The package documents `Bash.execute()`, `executeWithOutput()`, an in-memory filesystem, 167 built-in commands in the upstream inventory, and a separate interactive `Terminal` class in the source tree. The published package evaluated here exports `Bash` and `executeWithOutput`; its `package.json` does not ship the source-tree `Terminal` class. This experiment therefore uses the published `Bash` API behind the same small adapter editor, SharedBridge, and Ghostty terminal as the just-bash baseline. It is a script-session comparison, not Bashkit's native interactive-terminal path.

The browser package advertises broad text processing and file support, including `grep`, `rg`, `sed`, `awk`, `jq`, `find`, `sort`, `uniq`, `tr`, `wc`, `seq`, `cp`, `mv`, `mapfile`, and `read`. It also exposes a `cancel()` method. The package documentation says cancellation is cooperative and a synchronous CPU loop can prevent the event loop from delivering cancellation until that work returns.

## Browser checks

The adapter passes variables, functions, arrays, cwd, pipelines, redirections, Unicode editing, bracketed paste, completion, and the shared Ghostty path. Bashkit's shell state persists in the same `Bash` instance. The evaluation adapter resets `$?` between submitted scripts because the published API returns an execution result but does not expose the previous shell exit status as a session input. Live terminal stdin is unavailable through `Bash.execute()`.

The published WASM package is about 7.0 MB before compression. It runs without browser isolation headers. A repeated file workload exposes a Bashkit limit on this configuration: after about ten 10,000-line `mapfile` iterations, the array result becomes empty while the command still returns success. This needs upstream investigation before treating Bashkit as a replacement for the other sessions.

The direct worker probe records:

| Case | Result |
| --- | --- |
| `executeWithOutput("echo start; sleep .3; echo end")` | Incremental `start` and `end` callbacks arrive around the sleep boundary |
| `cancel()` during `sleep .3` | Cancel is called, but the published probe completed at the timer boundary rather than immediately |
| `cancel()` during a 200,000-iteration CPU loop | The loop completed and returned `COUNT:200000` before the queued cancel callback ran |
| Repeated `mapfile` file workload | First ten 10,000-line iterations succeed; later iterations return zero array entries with status 0 |

The raw capability probe is [bashkit-capabilities.json](evidence/bashkit-capabilities.json). It owns a browser, static server, and copied package and verifies cleanup.

## Comparable timings

These are 30 trials after one warmup per engine and mode on Chromium 152.0.7977.82, Linux 7.2.8, Intel Core i7-14700K, headless Canvas2D. The candidate run uses the same Ghostty terminal, adapter editor, 32 KiB output drains, status markers, and alternating order as the Brush and just-bash comparisons. It excludes the failing repeated file fixture and measures arithmetic, command substitutions, and a settled 10,000-line transcript.

| Workload | Brush worker / visible | just-bash worker / visible | Bashkit worker / visible |
| --- | ---: | ---: | ---: |
| Arithmetic, 20,000 iterations | 58.08 / 63.60 ms | 59.59 / 64.26 ms | 50.98 / 60.18 ms |
| 1,000 substitutions | 18.85 / 25.74 ms | 30.13 / 36.97 ms | 5.92 / 22.41 ms |
| Settled 10,000 terminal lines | 0.61 / 25.27 ms | 1.94 / 27.84 ms | 1.01 / 27.37 ms |

The Bashkit result is faster on these script workloads, especially substitutions. The terminal-visible numbers are close because all three adapters use the same Ghostty path. The Bashkit result is not a complete interactive-shell result because it lacks live stdin, previous exit-status carry, and the published package's native `Terminal` API.

Raw 540-sample data is in [bashkit-comparison-valid.json](evidence/bashkit-comparison-valid.json). The measurement script can select the same bounded matrix with:

```sh
BRUSH_COST_ENGINES=brush,just-bash,bashkit \
BRUSH_COST_FIXTURES=arithmetic-20000,substitutions-1000,terminal-10000-settled \
BRUSH_COST_TRIALS=30 npm run measure:costs
```

The published-package comparison does not settle the interactive-shell choice. The separately pinned source API is evaluated below.

## Source-tree terminal API

The workbench now has a separate `bashkit-terminal` engine at `491c3281f668b76d64b15210b8f5d7bf97244be0`. `npm run build:bashkit` downloads and checks the source archive, builds with upstream's Rust 1.95.0 release profile and `terminal` feature, and generates bindings with wasm-bindgen 0.2.128. This build deliberately skips optional wasm-opt, so binary size and performance must be compared as a separate build from the published package. The source is unpatched and reproducible without the local reference checkout.

The worker owns one `Terminal`. Ghostty keyboard bytes go to `sendBytes`; one `runUntilIdle` promise runs at a time. While it awaits, an asynchronous worker loop can deliver input and resize events and drain `takeOutput`. The worker uses `resize(rows, cols)`. Output reaches Ghostty without text decoding or newline translation. Bashkit owns echo, native editing, terminal modes, and CRLF conversion. The same bounded shared bridge and main-thread output pump are retained for all engines. Bashkit itself needs no shared memory; this comparison adapter does.

An idle result means waiting for input, including a command's live input or a full-screen program. It does not always mean the shell prompt. Profiling spans therefore describe one submitted turn through the API, rather than claiming every idle result is a completed command. Arithmetic, substitutions, and completed-output fixtures compare complete turns.

The source uses both an internal vt100 screen parser and Ghostty's parser. `takeOutput` copies bytes out of WASM, the bridge copies them into a ring, and the page drains that ring before writing to Ghostty. The existing cost counters measure draining and ring copying; time inside the native interpreter, editor, and vt100 parser remains inside the worker span. This avoids calling every extra millisecond a WASM boundary penalty.

Source inspection finds a 1 MiB input queue, 64 KiB editor line limit, 4 MiB retained raw output buffer, 1 MiB transcript buffer, and 1,000 rows of internal scrollback. The raw output buffer drops oldest bytes when full. A synchronous command cannot be drained until it yields, so that upstream bound is not backpressure. Our adapter adds no unbounded queue, but cannot promise lossless arbitrarily large native output.

The native editor treats Tab as a tab and does not implement bracketed paste. The workbench rejects multiline clipboard paste in this mode to prevent accidental execution. It does not supply a replacement editor. A synchronous CPU loop still prevents the worker from delivering input to `sendBytes`; shared cancellation in Brush is a different implementation. Test results and timings for this source API are recorded separately from the published-package evidence above.

## Native browser results

All 37 workbench browser tests passed on Chrome 154.0.8037.93 on an Apple M1 Mac. The source package's 47 tests passed on Node. Native browser cases exercised persistent exports, functions, cwd and previous exit status; live Unicode `read`; cursor movement, Home/End, deletion and history; incremental output and Ctrl+C during a 30-second sleep; `vi` editing and resize; EOF and worker-failure recovery. The finite CPU-loop case deliberately verifies the remaining cancellation failure. The source editor has no Tab completion, and multiline paste is rejected by the workbench.

The native source still reproduces the repeated-file problem at the same 32 MiB memory limit. A diagnostic variant verifies both files still contain 10,000 lines when `mapfile` returns an empty array with success. The [Node source probe](evidence/bashkit-native-node-probe.json) records this separately from browser validation. It also records 59 Bash builtin names, 171 virtual executable names and unsafe raw bracketed-paste behavior. Names are an inventory, not proof of complete native Unix compatibility.

The [native timing tables](evidence/bashkit-native-timings.md) contain 960 checked workbench samples, plus a 120-sample control comparing both APIs in the same WASM module. The workbench matrices have identical asset hashes and use the same Ghostty renderer and bounded transport for all four engine choices. Chrome reports an Apple Metal 3 adapter with `isFallbackAdapter: false`; screenshots of the WebGPU terminal were inspected. All new runs are headless hardware WebGPU runs. They do not measure physical presentation.

The native API is competitive on arithmetic and faster than Brush and just-bash on the substitution fixture in this run. It is slower on the 10,000-line output fixture. Its cost-mode output drain and ring copying total roughly 0.10 ms for that fixture, compared with a 14.44 ms phase-mode worker span. Those separate instrumentation runs do not support attributing every remaining millisecond to WASM transitions, the interpreter, or vt100. The same-module control measures 2.61 ms through `Bash.execute` and 3.88 ms through `Terminal` for 10,000 lines, with a different geometry and only one live worker. It cannot be subtracted from the full workbench result.

Ghostty immediate presentation reduced the Brush output fixture's submitted-frame median from 26.22 ms to 23.39 ms. Native Bashkit changed from 38.08 ms to 39.24 ms. It did not consistently improve the CPU fixtures. The frame endpoint is the existing `onFrame` event. Additional `outputTiming` hooks were still in open [Fregat PR #1288](https://github.com/ShaulLavo/fregat/pull/1288) at the measurement cutoff; this run pins merged immediate mode.

Cold-worker startup was 28.79 ms for Brush, 63.71 ms for just-bash, 68.75 ms for published Bashkit and 41.13 ms for native Bashkit. Three warm restarts per engine gave medians of 22.24, 46.18, 42.02 and 38.35 ms respectively. These are small startup samples, with cold HTTP-cache treatment rather than cold OS or driver caches. Native Bashkit showed initial output before a 0.3-second sleep finished, while the published adapter and just-bash displayed collected output at completion. Native WASM committed linear memory at the warm prompt was about 2.56 MB; Brush was about 1.77 MB. These exclude code, JS workers and process RSS.

The page's 8 ms output-pump interval and 32 KiB drain size remain common scheduling costs. They deserve a separate transport experiment before treating shell-level changes as the answer to display latency. OPFS remains deferred. The [environment record](evidence/native-mac-environment.json) discloses preparation load, background applications, lack of reserved CPUs, and different geometry/session counts in the API control.

Reproduce the API control with `node scripts/probe-bashkit-apis.mjs` after building. Run `node scripts/analyze-bashkit.mjs` to regenerate the checked tables from retained evidence. For the same workbench fixtures, set `BRUSH_COST_ENGINES=brush,just-bash,bashkit,bashkit-terminal`, `BRUSH_COST_FIXTURES=arithmetic-20000,substitutions-1000,terminal-10000-settled`, `BRUSH_COST_TRIALS=20`, `BRUSH_RENDERER=webgpu` and `BRUSH_PRESENTATION=frame` or `immediate` before `npm run measure:costs`.

After the workload measurement cutoff, Fregat PR #1288 merged. The final demo pins `96f080016aea1b84b06be28167de1507f33e1b3f` through mirror `40a0cb891f8b4f6aa0b8ed3d19669f56252b3fa9` and records `outputTiming` events when tracing is enabled. A separate [forty-turn timing check](evidence/ghostty-new-timing.md) validates input, first/last output, drawn and browser-update timestamps for both presentation modes and every engine. The raw twenty-trial workloads retain their original source pins and hashes. The new check is not substituted for those workloads.
