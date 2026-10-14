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

The comparison is worth continuing. The next fair Bashkit step is to build and pin its source-tree `Terminal` API or get a released package that includes it, then compare native terminal session behavior before deciding among Brush, just-bash, and Bashkit.
