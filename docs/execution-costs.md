# Browser execution costs

The 10,000-line display delay mainly comes from delivery pacing and frame alignment on this host. Ghostty's synchronous parsing and terminal-state work takes about 1–2 ms. Main-thread allocation and shared-ring draining takes about 0.02–0.06 ms. The adapter still drains 32 KiB, then waits 8 ms. Brush's queued editing redraws can push the transcript into a third delivery.

This is a diagnostic run of both engines. Neither interpreter, utility implementation, editor scheduling nor terminal renderer was optimized in this change. OPFS remains deferred. The earlier [performance proof](performance-proof.md) remains a separate comparison against the original demo.

## The observed main-thread timeline

The tables use the phase-only trial nearest the median Enter-to-submitted-frame time. These intervals are disjoint and add to the elapsed time. Worker execution overlaps this timeline and is reported separately. Times are milliseconds.

| Immediate Enter after typing, Canvas2D | Brush | just-bash |
| --- | ---: | ---: |
| Enter to first drain | 9.50 | 11.91 |
| Shared queue allocation and drain | 0.045 | 0.035 |
| Synchronous Ghostty write | 1.865 | 1.870 |
| Between drains | 16.165 | 8.085 |
| Last drain to submitted frame | 16.040 | 6.940 |
| Total | 43.615 | 28.840 |
| Delivered bytes | 67,598 | 59,230 |
| Number of drains | 3 | 2 |

| Immediate Enter after typing, hardware WebGPU | Brush | just-bash |
| --- | ---: | ---: |
| Enter to first drain | 11.210 | 7.480 |
| Shared queue allocation and drain | 0.030 | 0.035 |
| Synchronous Ghostty write | 1.475 | 1.395 |
| Between drains | 16.145 | 8.075 |
| Last drain to submitted frame | 15.890 | 7.280 |
| Total | 44.750 | 24.265 |
| Number of drains | 3 | 2 |

When the harness waits for editing output to drain before Enter, both engines need two deliveries. Canvas2D visible medians are 24.06 ms for Brush and 28.22 ms for just-bash. Hardware WebGPU medians are 28.09 and 26.25 ms. Waiting before Enter is an intervention to identify editing backlog, not an optimization or a reduction in total interaction time.

The main timing ends inside Ghostty's frame callback. It excludes compositor presentation and physical scanout. Synchronous Ghostty write includes VT parsing, terminal-state updates and scheduling; it does not include the later frame draw.

## Ghostty replay and frame work

Both engines replay the same transcript directly into Ghostty in 32 KiB chunks, bypassing the shell and shared queue. Ordinary replay reaches a submitted frame around 16.5 ms for both engines. The frame interval is not 16.5 ms of rendering CPU.

A separate 20-trial replay times browser animation-frame callbacks and observes `GPUQueue.onSubmittedWorkDone()` after submissions:

| Hardware WebGPU replay | Brush terminal | just-bash terminal |
| --- | ---: | ---: |
| Synchronous terminal write median | 0.915 ms | 0.860 ms |
| Observed animation-frame callback CPU median | 0.310 ms | 0.275 ms |
| Submit to GPU completion callback median | 2.67 ms | 2.96 ms |

Callback CPU includes the page's observed callbacks and test instrumentation. GPU completion latency includes queue work, an extra completion fence and browser callback scheduling; it is not an isolated shader timestamp. This probe waits for completion between trials, which changes frame alignment, so its 13.6–14.0 ms frame medians are not a speed improvement over ordinary replay. These results provide no evidence that GPU throughput explains the roughly 45 ms shell transcript delay.

The headed run used NVIDIA Ampere with `isFallbackAdapter: false`. The inspected [Brush](evidence/cost-webgpu-brush.png) and [just-bash](evidence/cost-webgpu-just-bash.png) screenshots show the hardware renderer, completed commands and usable prompts.

## Worker and adapter measurements

Six fixtures cover arithmetic, substitutions, files and pipelines, settled and immediate 10,000-line transcripts, and 100,000-line output. The runner alternates engine and instrumentation order, checks each current command's output and status, and records 720 executions in headless Canvas2D and 240 in headed WebGPU. All measurements use Chromium 152.0.7977.82, Linux 7.2.8 and an Intel Core i7-14700K, recorded on 2026-10-14. Both engines use the same grid and font.

Phase mode records only command boundaries in the worker. Cost mode also records all WASI imports and custom browser imports except phase events. Both retain the same bounded main-thread trace. Import timers start after entering JavaScript, so dispatch and return costs remain outside those spans.

For immediate 10,000-line output, phase-only worker medians are 0.72 ms for Brush and 1.96 ms for just-bash in Canvas2D, and 0.61 and 1.81 ms in WebGPU. These are inclusive worker elapsed times, not pure interpreter CPU times. just-bash's separate execution span includes its virtual filesystem and output-string construction. Its following adapter conversion includes newline handling and UTF-8 encoding. Brush's conversion handles terminal newlines on already encoded bytes.

Detailed Canvas2D trials record about 0.16 ms of Brush newline conversion and 0.405 ms of just-bash conversion/encoding for immediate 10,000-line output. Shared-ring copies are about 0.015 and 0.010 ms. These child spans sit inside larger worker or host spans and must not be added again.

At 100,000 lines, the queue reaches its 256 KiB bound. Detailed Canvas2D trials record median blocked output time around 84 ms for Brush and 116 ms for just-bash. Main-thread gaps with known queued bytes total about 171 ms for either engine. Worker blocking overlaps main-thread activity; summing those numbers would double-count elapsed time.

## Memory access and crossing controls

Creating `new Uint8Array(memory.buffer, pointer, length)` creates a view without copying the payload. `.slice()` allocates and copies; `.set()` copies into an existing destination. Host I/O may also normalize bytes, maintain filesystem state and wait for queue capacity.

Paired hot-buffer controls execute in a dedicated browser worker. They verify observable results, alternate order and use 30 trials after warmups. Canvas2D-run medians for a 64 KiB payload are:

| Operation | WASM memory | Ordinary ArrayBuffer |
| --- | ---: | ---: |
| Create a view and read two bytes | 10.8 ns | 11.1 ns |
| Copy into a reused destination | 0.890 µs | 0.890 µs |
| Allocate and copy with slice | 17.38 µs | 17.09 µs |

The view test reads two bytes, not the full payload. Copy controls use hot buffers; allocation includes possible garbage collection. The experiment does not establish these costs for cold memory or every device. It finds no special WASM-memory penalty here compared with ordinary buffers.

A WASM loop with an imported identity callback versus an inline equivalent yields a median differential around 2.8 ns per call in this control. That includes callback dispatch and compiler/JIT differences. It is not a pure transition measurement and must not be multiplied by real import counts as exact shell attribution. Both shell engines also use Ghostty's WASM after delivery.

## The observer changes the work

Brush makes about 10,012 browser calls and 12 WASI calls in the 10,000-line fixture, largely because `seq` checks cancellation for every number. Timing every callback makes the small worker phase about five times longer. The detailed timer is substantially more expensive than the imported identity callback control.

Use phase-only runs for engine timing. Use detailed runs to locate operations and count bytes/calls, while retaining their overhead ratios. `workerOutsideImportsMs` is unattributed elapsed time, including Rust work, transitions and instrumentation; it is not pure Rust CPU. Output-limited work can hide observer overhead by replacing time otherwise spent blocked, and ratios below one can reflect scheduling or noise.

The next performance work belongs at the shared delivery scheduler and editing redraw batching. These measurements do not justify blaming raw WASM memory access or replacing Ghostty. They also do not establish either shell's maximum speed or complete Unix tool coverage.

## Repeat the diagnosis

```sh
npm run build
npm run measure:costs
BRUSH_HEADED=1 BRUSH_RENDERER=webgpu BRUSH_COST_TRIALS=10 npm run measure:costs
BRUSH_COST_REPLAY_ONLY=1 BRUSH_COST_OUTPUT=docs/evidence/cost-render-replay-canvas.json npm run measure:costs
BRUSH_HEADED=1 BRUSH_RENDERER=webgpu BRUSH_COST_REPLAY_ONLY=1 BRUSH_COST_OUTPUT=docs/evidence/cost-render-replay-webgpu.json npm run measure:costs
npm run costs:analyze
```

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for a system Chromium. Headed Linux verification needs the host's display environment. `BRUSH_COST_PORT` chooses a free loopback port and `BRUSH_COST_OUTPUT` preserves accepted evidence during smoke or interruption checks. Manual profiling uses `?test=1&trace=1&profile=1`; `profile=phase` disables worker cost timers.

The runner freezes and hashes its production assets, owns its browser and one static loopback server, and records verified cleanup. It does not execute shell commands on that server. The [derived analysis](evidence/cost-analysis.json) records raw-source hashes and checks that representative timelines add up. Raw [Canvas2D](evidence/cost-attribution-canvas.json), [WebGPU](evidence/cost-attribution-webgpu.json) and render replay results remain available. Source HEAD names the base revision; asset hashes identify the measured working build. No JavaScript heap, process RSS or isolated GPU shader duration is claimed.
