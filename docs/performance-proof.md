# Browser shell performance proof

Brush is now faster on the tested file and substitution work after one bounded I/O correction round. It is not faster everywhere. Both arithmetic workloads are close, and just-bash still reaches the visible end of a 10,000-line transcript sooner. This is evidence for continuing the Brush evaluation, not a universal Rust-speed claim or a completed Unix toolset.

OPFS and additional Unix text tools remain deferred. Neither engine nor the terminal was replaced.

## What changed

The browser Rust `seq` utility buffers at most 8 KiB before writing to WASI. It checks cancellation on every number and flushes at completion and on errors or interruption. Unlimited regular-file `mapfile` reads use an 8 KiB buffer in the single-worker browser target; limited reads, terminals and nonseekable streams retain their original behavior. Read-ahead restores the shared descriptor position. The interpreter and compiler optimization level remain unchanged.

The WASI host reserves file capacity geometrically, copies directly from WASM iovecs, and keeps cached live-byte accounting between namespace/descriptor mutations. Logical contents remain separate from spare capacity. Truncation followed by growth yields zero bytes; append uses current EOF. The logical file-data budget remains 8 MiB, spare capacity is capped at 16 MiB, and open/unlinked files remain accounted until their consumers close.

just-bash retains the published 3.6.0 implementation, all 45 enabled commands, execution limits and stock `seq`. Its completed-output adapter now uses bounded UTF-8 encoding instead of allocating a second full concatenated and newline-expanded output. A preliminary browser-worker encoding check measured numeric output at 3.1 to 2.4 ms median and Unicode output at 4.3 to 2.6 ms. Those measurements exclude shell execution, transport and rendering, and predate the final fix for a surrogate pair split between stdout and stderr. Raw results and the measured source hash are in [the encoding evidence](evidence/baseline-output-encoding.json). The full proof uses the corrected adapter.

An optional `?engine=just-bash&baselineState=carry` adapter uses public result/environment/cwd APIs to carry scalar values, ordinary cwd and alias data. Functions, arrays, options and prior exit status still reset. The default comparison remains isolated to match stock behavior. Browser tests verify both contracts and prompt editing after resize.

## Method and scope

The proof runs real Ghostty keyboard input against frozen copies of the original built demo and corrected demo. It verifies every command's exit status and current-trial checksum. Seven workloads each have one warmup and 30 warm samples for both engines and both builds. Engine/build order alternates by trial. The 1,680 timed executions include separate import-counter and phase-only runs.

Worker time starts when execution begins and ends before the next prompt is drawn. It includes host I/O and output backpressure, but excludes input editing and terminal rendering. Phase-only timestamps supply the timing table below. Separate import-profiled runs collect call counts and actual candidate allocations; their per-import timestamp overhead is excluded from that table. Direct shared profile counters are checked against the current command sequence.

Visible completion starts at Enter delivery and ends at Ghostty's frame callback containing the result marker. It includes transport, editing backlog, rendering, frame submission and polling; it excludes compositor presentation and physical display scanout. Both engines use the same grid, font, viewport and Canvas2D renderer. A fixed 58,907-byte transcript replayed in identical 32 KiB chunks takes 16.56 ms median for Brush's terminal and 16.60 ms for just-bash's terminal. Their rendering paths are the same; their natural command-output schedules differ.

Recorded on 2026-10-14, Chromium 152.0.7977.82, Arch Linux 7.2.8, Intel Core i7-14700K. The main matrix uses headless Canvas2D. A separate headed run used Ghostty WebGPU on NVIDIA Ampere with `isFallbackAdapter: false`. Artifact hashes, all raw samples and verified cleanup are retained in [performance-proof.json](evidence/performance-proof.json).

## Corrected engines

All times are milliseconds. Each cell is median / p95 over 30 warm trials.

| Workload | Brush worker | just-bash worker | Brush visible | just-bash visible |
| --- | ---: | ---: | ---: | ---: |
| Arithmetic, 2,000 iterations | 6.49 / 9.85 | 6.45 / 10.54 | 29.3 / 31.1 | 29.6 / 31.6 |
| Arithmetic, 20,000 iterations | 59.47 / 67.86 | 59.11 / 66.44 | 78.6 / 81.2 | 77.8 / 85.9 |
| 100 substitutions | 2.56 / 2.82 | 3.87 / 10.51 | 28.2 / 30.8 | 28.7 / 30.1 |
| 1,000 substitutions | 19.31 / 21.76 | 29.06 / 37.06 | 28.8 / 44.7 | 44.4 / 47.1 |
| Files and pipeline, 5,000 lines | 1.67 / 2.47 | 3.39 / 5.18 | 26.0 / 33.5 | 28.2 / 29.7 |
| Files and pipeline, 10,000 lines | 3.02 / 3.10 | 6.89 / 8.61 | 25.1 / 35.2 | 27.1 / 29.8 |
| 10,000 terminal lines | 0.62 / 0.99 | 1.43 / 1.99 | 46.8 / 51.8 | 30.9 / 36.7 |

The paired worker-time median ratio for Brush versus just-bash is 0.50 on 5,000-line files and 0.43 on 10,000-line files, about 2.0x and 2.3x faster. For 1,000 substitutions it is 0.67, about 1.5x faster. These are medians of per-trial ratios, so they differ from ratios of the table's pooled medians. The 20,000-iteration arithmetic ratio is 1.03 with a seeded exploratory 95% bootstrap interval of 0.99 to 1.04. This does not establish a consistent winner for that CPU path. Other tested paired intervals are below 1. The [analysis](evidence/performance-analysis.json) records the calculation and source hash; `scripts/analyze-performance.mjs` regenerates it. Samples on one machine are not independent trials of all browser/hardware configurations.

## The measured I/O costs were removed

The old Brush 5,000-line file workload used 23,894 one-byte read requests and 10,009 WASI writes. The corrected workload uses eight reads and twelve writes. At 10,000 lines it changes from 48,895 one-byte reads and 20,012 writes to fourteen reads and eighteen writes. The unchanged output includes the verification markers.

Brush's worker median for those file workloads falls from 50.44 to 1.67 ms at 5,000 lines, and from 167.09 to 3.02 ms at 10,000 lines. The original results primarily measured inefficient I/O, rather than the Rust interpreter alone.

Old copied-file volumes of roughly 115 MB and 479 MB are derived from observed append sizes and the pinned shim's exact-growth algorithm. They are estimates, not allocation-profiler measurements. The corrected host's direct counters report no new copied file bytes in the warm file trials because capacity is reused. Warm trials intentionally overwrite the same files. A first allocation still reserves and may copy memory; host tests verify growth and repeated reclamation rather than claiming zero-allocation storage.

The old 10,000-line terminal workload makes 20,005 WASI writes; the corrected workload makes twelve. Brush's worker median falls from 11.83 to 0.62 ms in the phase-only run. Its visible completion remains around 47 ms, so the worker gain is not an equivalent display gain. For candidate storage, use `worker.direct.fileAllocatedBytes` and `fileCopiedBytes`. The raw external counters retain the old exact-growth reconstruction for comparison and do not describe candidate allocation.

## Interactive acceptance

All 27 automated checks pass. Twenty-two drive the browser terminal, covering persistent Brush state, Unicode/grapheme editing, safe paste, completion, wrapped prompts and resizing, live stdin, EOF, pipelines, redirections, worker restart, shared file positions, and optional just-bash carry semantics. Five exercise the just-bash adapter and output encoding directly. Ten Rust runtime tests and 31 builtin tests cover bounded sequence writes, cancel/error flushing, buffered file offsets, delimiters and control bytes. WASI Clippy and rustfmt pass.

The declared budgets for this host were input-frame p95 below 50 ms and cooperative cancellation recovery below 150 ms. Brush input-frame p95 is below 25 ms. Tight-loop, sleep and stdin interruption recover in about 14 to 21 ms; just-bash's loop and sleep recover in about 17 to 20 ms. These are observed browser recovery times, not OS signal delivery measurements. The Brush linear memory reading after the workloads is 4,063,232 bytes; worker JavaScript heap, GPU allocation and process RSS were not measured. Shared queues and file budgets remain bounded.

In the separate headed WebGPU check, `echo stream-start; sleep 0.3; echo stream-end` displays Brush's first output at about 31 ms and finishes at 315 ms. just-bash's collected output appears at about 315 ms. [Headed measurements](evidence/optimized-webgpu.json) and inspected [Brush](evidence/optimized-webgpu-brush.png) / [just-bash](evidence/optimized-webgpu-just-bash.png) screenshots distinguish this hardware check from the Canvas2D matrix. Cold startup remains affected by first-engine driver initialization; no cold-start ranking follows from one navigation.

Across three warm restarts in that headed check, Brush's worker-startup median is 28.7 ms and just-bash's is 53.5 ms. First-frame medians are 131.5 and 166.8 ms respectively. These small startup samples are descriptive and use the engines' ordinary, different-sized terminal grids. The 30-trial workload matrix equalizes grid size separately.

## Decision and repeatability

This bounded round passes the current interactive gates and demonstrates a meaningful Brush worker-time advantage on the measured file and substitution paths. It does not prove every command is faster, complete POSIX job/process behavior, concurrent streaming pipelines, or a full text-processing command catalog. Those remain separate capability gates. OS IME candidate UI and real mobile keyboards remain manual checks.

Stop this tuning round here. Decide the next capability milestone from these results; OPFS remains deferred as requested. Do not start a broad fork or another optimization sweep merely to improve the arithmetic or transcript score.

```sh
npm run build
npm run verify
BRUSH_BASELINE_DIST=/path/to/accepted-baseline/dist npm run proof
node scripts/analyze-performance.mjs
```

The proof needs an accepted original build for comparison. Rebuild commit `f200c70` in an isolated checkout if it is no longer available; keep that build separate from the candidate. Both artifacts are frozen and hashed by the runner. The runner owns its temporary bundles, four loopback servers and browsers, and cleans them in `finally`, including interruption. Host allocation/descriptor checks run with `npm run test:host`.

Use `BRUSH_PROOF_OUTPUT=/path/to/result.json` for smoke or interruption checks so they preserve the accepted evidence. The runner checks its four ports are available before setup and records its owned resources.
