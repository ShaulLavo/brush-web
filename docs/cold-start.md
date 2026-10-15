# Cold start over a phone-like network

**Verdict.** On a first visit over a mobile connection, just-bash reaches a usable prompt first: 1.8 s on Fast 4G and 7.2 s on Slow 4G, against 2.3 s and 10.5 s for Brush and 3.5–3.9 s and 16–19 s for the two Bashkit builds. The cause is download size. Compilation is not the cause: Chrome compiles WebAssembly lazily, so the compile step takes under 15 ms for every engine, even with the CPU throttled. On a fast connection all four engines show a prompt within 110–145 ms, and Brush is the fastest. On repeat visits all four show a prompt in 0.4–0.6 s on Fast 4G. Brush is slowest there only because its WASM file name has no content hash, so the browser checks it with the server once per visit. The download gap is the one difference a fork would have to live with: Brush's 1.0 MB of compressed WASM (0.88 MB with symbol names stripped) against just-bash's 0.28 MB of JavaScript. Each extra 100 KB costs about 0.1 s on Fast 4G and 0.55 s on Slow 4G.

Measured on 2026-10-15 at `f6d1961` plus this change. Main has since changed the Brush patch so that `$$` reports a fixed PID (#8). That change does not touch how the engine downloads or starts. Raw samples are in [cold-start.json](evidence/cold-start.json), and quantiles for every cell are in [cold-start-summary.json](evidence/cold-start-summary.json).

## What was measured

The workbench was served from a local static server that behaves like a CDN with build-time compression. It sends brotli-11 or gzip-9 bytes with `Content-Encoding` and `Vary`. Hashed `assets/` files are `immutable`. `index.html` and the unhashed `brush/brush-browser.wasm` are `no-cache` with an ETag, so a repeat visit revalidates them. Each trial used a new Chromium profile and three browser launches on that profile: a cold visit, then two repeat visits (`warm1`, `warm2`). Each visit lingered 1 s after the first command before the browser closed. There were 10 trials per cell. Engine order rotated and reversed between trials, and no cell failed.

The engine is chosen by URL, so the page opens Ghostty first and starts the shell worker after that. "Engine selected" is the moment the page creates the shell session. Times run from navigation start. (a) is the last engine-specific byte received: the worker script, the engine chunks and the WASM file. (b) is when the worker finished `WebAssembly.compileStreaming`, or finished importing the just-bash chunks. (c) is the first terminal frame after the shell reports ready. (d) adds the measured time from Enter on `echo hi` to the frame that shows `hi`.

| Condition | Network | CPU |
|---|---|---|
| unthrottled | loopback | none |
| fast4g-cdp4x | DevTools "Fast 4G": 1,012,500 B/s down, 168,750 B/s up, 165 ms latency | DevTools 4× (`Emulation.setCPUThrottlingRate`) |
| slow4g-cdp4x | DevTools "Slow 4G": 180,000 B/s down, 84,375 B/s up, 562.5 ms latency | DevTools 4× |
| fast4g-cgroup4x | Fast 4G | Whole browser limited to 25% of one core (cgroup `cpu.max` 2.5 ms per 10 ms) |
| slow4g-cgroup4x | Slow 4G | same cgroup limit |

The network values come from `front_end/core/sdk/NetworkManager.ts` in Chrome DevTools. DevTools CPU throttling only slows the page's main thread: Chrome rejects it on worker targets with "Operation is only supported for pages, not workers". Every shell runs in a worker, and Chrome compiles WASM on background threads, so the cgroup condition was added. It slows every thread, including the network service and the compile threads, and gives the whole browser a quarter of one core. That is harsher than a real phone, which has several slow cores. A main-thread loop ran 3.8–4.3× slower under both throttles. The two models gave cold times within 0.3 s of each other, because the network is the bottleneck.

## Transfer size per engine

| Engine | Files fetched for this engine | Raw | gzip -9 | brotli 11 |
|---|---|--:|--:|--:|
| Brush | `brush-browser.wasm` | 5,083 KB | 1,442 KB | 998 KB |
| Brush, `wasm-opt -Oz` | same, optimized | 3,396 KB | 1,266 KB | 907 KB |
| just-bash | `baseline.js`, `baseline-session.js` | 1,283 KB | 351 KB | 281 KB |
| Bashkit 0.18.2 (published) | `baseline.js`, `bashkit-session.js`, `bashkit_wasm_bg.wasm` | 7,034 KB | 2,646 KB | 1,827 KB |
| Bashkit native (source build) | `bashkit-terminal.js`, `bashkit_wasm_bg.wasm` | 10,177 KB | 3,641 KB | 2,437 KB |
| Bashkit native, `wasm-opt -Oz` | same, optimized | 9,475 KB | 3,599 KB | 2,459 KB |
| Shared by all | `index.html`, page bundle, CSS, `ghostty-vt.wasm`, `bridge.wasm`, `shell.worker.js` | 1,405 KB | 446 KB | 360 KB |

No engine fetched anything after its prompt appeared, including during `echo hi`. just-bash's browser bundle (`just-bash/browser`) inlines all of its commands. They are evaluated lazily but not fetched lazily. The upstream Node build of the same version splits them into 91 command chunks behind a 113 KB (brotli) core.

The source-built Bashkit is larger than the published package because its source is 269 commits newer. The `terminal` feature is not the reason (it adds about 50 KB brotli; a build without it is 2,379 KB), and the missing optimization pass is not the reason either. `wasm-opt -Oz` with the flags from upstream's release script, using pinned binaryen 125, makes the raw file 7% smaller and the brotli file 1% larger. It did not change load time, so the regular build does not run it. Brush gains 91 KB brotli from `-Oz`. Most of that comes from dropping its 1.16 MB `name` section: stripping that section alone gives 884 KB brotli.

## Load time

Navigation to prompt painted, cold visit, median (interquartile range under 0.2 s in every throttled cell; under 20 ms with DevTools throttling):

| Condition | Brush | Brush -Oz | just-bash | Bashkit | Bashkit native | Bashkit native -Oz |
|---|--:|--:|--:|--:|--:|--:|
| unthrottled | 112 ms | 112 ms | 143 ms | 136 ms | 142 ms | 142 ms |
| Fast 4G + DevTools 4× | 2.32 s | 2.23 s | **1.82 s** | 3.49 s | 3.92 s | 3.94 s |
| Slow 4G + DevTools 4× | 10.54 s | 10.03 s | **7.15 s** | 16.28 s | 19.10 s | 19.22 s |
| Fast 4G + cgroup 4× | 2.51 s | 2.43 s | **2.12 s** | 3.71 s | 4.15 s | 4.20 s |
| Slow 4G + cgroup 4× | 10.64 s | 10.15 s | **7.35 s** | 16.42 s | 19.24 s | 19.33 s |

Second repeat visit (`warm2`), same measure:

| Condition | Brush | Brush -Oz | just-bash | Bashkit | Bashkit native | Bashkit native -Oz |
|---|--:|--:|--:|--:|--:|--:|
| unthrottled | 110 ms | 110 ms | 110 ms | 135 ms | 140 ms | 142 ms |
| Fast 4G + DevTools 4× | 600 ms | 599 ms | 426 ms | 462 ms | 443 ms | 454 ms |
| Slow 4G + DevTools 4× | 1.40 s | 1.40 s | 829 ms | 858 ms | 852 ms | 857 ms |
| Fast 4G + cgroup 4× | 1.29 s | 1.39 s | 1.04 s | 1.36 s | 1.37 s | 1.35 s |
| Slow 4G + cgroup 4× | 1.84 s | 1.84 s | 1.14 s | 1.46 s | 1.51 s | 1.49 s |

Cold milestones from navigation, Fast 4G + DevTools 4×, median:

| Engine | Engine selected | (a) Assets fetched | (b) Compiled / evaluated | (c) Prompt | (d) `hi` visible |
|---|--:|--:|--:|--:|--:|
| Brush | 956 ms | 2.29 s | 2.30 s | 2.32 s | 2.36 s |
| just-bash | 958 ms | 1.76 s | 1.79 s | 1.82 s | 1.85 s |
| Bashkit | 957 ms | 3.45 s | 3.46 s | 3.49 s | 3.51 s |
| Bashkit native | 957 ms | 3.88 s | 3.89 s | 3.92 s | 3.95 s |

Slow 4G + DevTools 4×: the engine is selected at 3.76 s for all. Prompt times are listed above. (a) through (d) span 40–100 ms for each engine. The script prints every condition and visit, and the first `warm1` visit, with `npm run cold:analyze`.

## Where the time goes

Cold visit, Slow 4G + cgroup 4×, median per step:

| Engine | Page + Ghostty | Engine download | Compile / evaluate | Instantiate + shell init | Prompt paint | First command |
|---|--:|--:|--:|--:|--:|--:|
| Brush | 3.81 s | 6.74 s | 15 ms | 45 ms | 28 ms | 73 ms |
| just-bash | 3.82 s | 3.34 s | 146 ms | 39 ms | 18 ms | 49 ms |
| Bashkit | 3.82 s | 12.49 s | 30 ms | 64 ms | 20 ms | 29 ms |
| Bashkit native | 3.81 s | 15.30 s | 43 ms | 54 ms | 11 ms | 62 ms |

- **Download dominates.** Engine download time matches (engine bytes ÷ bandwidth) plus one round trip per request in the chain. The chains are: Brush, worker → WASM (2 requests); just-bash, worker → `baseline` → `baseline-session` (3); Bashkit native, worker → glue → WASM (3); published Bashkit, worker → `baseline` → `bashkit-session` → WASM (4). Ghostty and the page add about 1 s on Fast 4G and 3.8 s on Slow 4G for every engine. The shell does not start downloading until Ghostty is ready.
- **Compilation is cheap.** All three WASM engines use streaming compilation. That includes the two Bashkit adapters, which now compile before instantiating so the two steps can be timed separately; wasm-bindgen's loader also streamed. V8 compiles WASM functions lazily on first call, so the compile step is 4–15 ms. just-bash spends more time here (38 ms with DevTools throttling, 150 ms under the cgroup) because V8 must parse and evaluate 1.27 MB of JavaScript.
- **Repeat visits.** Chrome did not write a WASM code cache in any session: `Code Cache/wasm` held only its 72-byte index. There is little compiled code to cache when compilation is lazy. The JavaScript code cache filled after the first visit, holding 416 KB for the page and another 510 KB for just-bash. just-bash's evaluation fell from about 38 ms to 5 ms on the second repeat visit. On the quarter-core profile, the Bashkit builds spend 0.4–0.5 s reading their 10 MB module back from the HTTP cache, against 0.16–0.2 s for just-bash. Brush's repeat visit pays one extra round trip because its WASM file revalidates.

## What is fixable

| Fix | Engine | Expected effect |
|---|---|---|
| Start the engine download in parallel with Ghostty (preload, or start the worker first) | all | Removes the serial wait for the page and Ghostty, ≈ 0.7–3 s cold; total bytes still share the link |
| Content-hash `brush-browser.wasm` so it can be `immutable` | Brush | −1 round trip per repeat visit (165 / 563 ms) |
| Strip the WASM `name` section, or run `wasm-opt -Oz` | Brush | −91 to −114 KB brotli; measured −0.5 s cold on Slow 4G |
| Flatten the import chain (import chunks in parallel, or pass the WASM URL ahead) | just-bash, Bashkit | −1 to −2 round trips cold |
| Code-split just-bash commands as its Node build does | just-bash | ≈ 281 → ~120–150 KB brotli first load (estimate from the Node build) |
| `wasm-opt -Oz` | Bashkit | none measured; brotli size grows |
| Make the Bashkit module smaller | Bashkit | upstream work: the module is 2.4 MB brotli with or without the `terminal` feature |

The size gap is inherent to each engine's design: an interpreter compiled from Rust against a TypeScript interpreter that reuses the browser's JavaScript engine. Brush cannot reach just-bash's first-load size with any of the fixes above. With the first three fixes, rough arithmetic (bytes ÷ bandwidth + about two round trips) puts Brush's cold prompt near 1.6 s on Fast 4G and 8 s on Slow 4G. just-bash with code splitting would be near 1 s and 4 s. Those are estimates, not measurements.

This run also found a startup bug. The workbench aborted any shell startup that took longer than 15 seconds. On Slow 4G, the native Bashkit build needs 15.3 s from engine selection to its prompt, so it always failed there. The guard is now 60 seconds. The measurement page raises it further with `?test=1&startupTimeout=<ms>`.

## Caveats

- This host is an Intel i7-14700K (28 logical CPUs, 32 GB) running Linux 7.2.8 with headless Chromium 156.0.8078.4 and the Canvas2D renderer. CPU throttling imitates a slower device; it is not a phone, and it does not model thermal limits, little cores or mobile GPU paths. The load average fell from 5.0 to 0.7 during the run because other agents' work was finishing.
- Loopback HTTP/1.1 without TLS. DevTools throttling adds latency to each request, but it does not model connection setup, TLS, HTTP/2 multiplexing or packet loss. Precompressed brotli 11 is the best case; a CDN that compresses on the fly at a lower level would send more bytes.
- Profiles live on tmpfs. Chrome writes the HTTP cache as it receives a response, and with profiles on this host's VDO-backed `/work` volume, cache writes capped localhost downloads near 8 MB/s. That would have exaggerated download times in the unthrottled condition.
- Startup instrumentation adds a few `performance.mark` calls and a resource-timing copy at worker initialization.

## Reproduce

```sh
npm run build
npm run measure:cold   # about 65 minutes; writes docs/evidence/cold-start.json
npm run cold:analyze   # prints these tables, writes docs/evidence/cold-start-summary.json
```

Set `BRUSH_COLD_TRIALS`, `BRUSH_COLD_VARIANTS`, `BRUSH_COLD_CONDITIONS`, `BRUSH_COLD_LINGER_MS` or `BRUSH_COLD_PROFILE_ROOT` to narrow a run. The cgroup conditions need `systemd-run --user` with the CPU controller delegated. The `-Oz` variants download binaryen 125 once, check it against the checksum pinned in `sources.lock.json`, and keep it in `.build/binaryen/125` (19 MB). Compressed copies and optimized WASM are cached in `.build/cold-start`. The script owns its server, browsers, cgroup scopes and temporary profiles, and it removes them on success, failure and interruption.
