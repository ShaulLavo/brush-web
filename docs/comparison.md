# Brush and just-bash comparison

Brush is a convincing interactive shell in this browser milestone. It retains native shell state, reuses its VT editor, accepts live stdin, and streams terminal output. just-bash offers a much wider bundled command catalog, but its public `exec` API is oriented toward isolated scripts. The baseline cannot provide equivalent state retention or output timing without a different upstream session API.

## Behavior

Both engines pass the same browser-driven fixture for directory creation, file redirection, `cat` pipelines, and command substitution within one submitted script. Both execute inside the worker and share Ghostty and the bounded byte rings.

| Behavior | Brush | just-bash baseline |
| --- | --- | --- |
| Shell execution | Pinned Rust interpreter compiled to WASI | Published browser JavaScript interpreter |
| cwd, exports, functions, aliases, status | Persist across submissions | Reset by public `exec` on every submission |
| Files | Session-local WASI memory | Session-local InMemoryFs |
| Prompt editing | Patched native VT backend | Adapter editor with basic completion |
| History | Native Brush history | 200 adapter entries |
| Unicode editing | Grapheme-aware buffer; native width convention | Intl.Segmenter; approximate cell widths |
| Multiline paste | Native bracketed-paste insertion | Adapter bracketed-paste insertion |
| Live stdin | Basic canonical driver; explicit raw key demo | `exec` accepts fixed stdin; live reads unsupported |
| Output | Incremental terminal bytes, ordered stdout/stderr writes | Completed stdout then stderr strings |
| Pipelines | Real Brush expansion/execution; sequential 1 MiB buffers | Public interpreter pipelines, collected output |
| Ctrl+C | Shared flag, Rust checkpoints, interruptible reads/sleep | Shared flag via AbortSignal getter; abort events for async waits |
| Native programs / packages | Unsupported, fail clearly | Outside browser command set |
| Utility coverage | 11 small Rust utilities plus native shell builtins | 45 enabled package commands, broader text processing |

Brush patches add cancellation, safe paste, grapheme editing, resize notifications, truthful WASI file probes, portable native printf, and explicit unsupported-mode failures. They are reproducible local patches, documented in [the runtime notes](brush-runtime.md).

The baseline has 429 TypeScript lines, including its editor, scheduling, and execution adapter. The Brush browser host has 358 TypeScript lines for WASI stdio, files, and quotas, and 546 Rust lines for terminal bindings and utilities. Both use the common session, worker entry, and shared-ring code. Counts include comments and blanks, measured with `wc -l`; patch line counts include diff context and are not equivalent implementation-size measurements. Brush saves a second editor implementation, while WASI hosting and upstream changes add integration work.

## Recorded measurements

Recorded on 2026-10-13, Chromium 152.0.7977.82, Arch Linux 7.2.8, Intel Core i7-14700K, NVIDIA GeForce RTX 3060 Ti. The headed run reported adapter vendor `nvidia`, architecture `ampere`, `isFallbackAdapter: false`, and Ghostty renderer `webgpu`. Both headed screenshots were visually inspected. The headless run explicitly selected Ghostty Canvas2D; its available GPU adapter was SwiftShader and is not hardware evidence.

The fixture is `echo stream-start; sleep 0.3; echo stream-end`. Input latency uses 21 samples from typing `echo latency-fixture` and ends when Ghostty reports the frame containing worker output. Timings below are milliseconds, rounded from the linked raw evidence.

| Run and engine | Cold first terminal frame | Warm frames, three restarts | Input p50 / p95 | First output / completion |
| --- | ---: | --- | ---: | ---: |
| Headed WebGPU, Brush | 404.7 | 129.9, 166.0, 149.8 | 8.2 / 24.9 | 31.3 / 314.6 |
| Headed WebGPU, just-bash | 195.8 | 166.9, 150.5, 150.1 | 7.3 / 19.1 | 315.8 / 317.1 |
| Headless Canvas2D, Brush | 117.8 | 61.0, 64.2, 64.6 | 8.0 / 21.2 | 30.3 / 313.9 |
| Headless Canvas2D, just-bash | 191.3 | 80.1, 81.5, 82.1 | 6.9 / 19.3 | 314.4 / 315.5 |

These runs establish output behavior, not a general speed ranking. Each row has one cold navigation and three warm restarts. Brush goes first, so graphics-driver initialization can inflate its first headed startup. OS and driver caches are warm. The cold context disables HTTP cache, but does not simulate a first visit over a network. Warm restarts recreate the terminal and worker while browser caches remain available.

Brush reported 1,769,472 bytes of WASM linear memory at the initial prompt; its memory has a 256 MiB maximum. This is not allocator live usage or worker RSS. Chromium's main-page heap readings varied with collection and include the terminal; they do not fairly compare the workers. Worker JavaScript heap, GPU allocations, and full process memory were not measured. The Brush module was 5,072,613 bytes during these runs; the final build's module size can change with documented patches.

Frame latency excludes physical display scanout and compositor presentation. Polling adds about one browser frame to the output-timing fixture, so those values are observed bounds rather than byte-exact worker timings. Results depend on font metrics, browser scheduling, GPU setup, and machine load.

Raw evidence and screenshots:

- [Headed WebGPU measurements](evidence/headed-webgpu.json), [Brush](evidence/headed-webgpu-brush.png), [just-bash](evidence/headed-webgpu-just-bash.png).
- [Headless Canvas2D measurements](evidence/headless-canvas.json), [Brush](evidence/headless-canvas-brush.png), [just-bash](evidence/headless-canvas-just-bash.png).

Run `npm run build && npm run measure` to repeat the fallback measurement. Set `BRUSH_RENDERER=webgpu` and, for a visible browser, `BRUSH_HEADED=1`. The script records actual renderer and adapter information and cleans up its server and browser.

## Remaining acceptance work

The automated suite exercises production browser interaction, including synthetic composition commitment. Operating-system IME candidate UI, Safari, Firefox, real mobile keyboards, very tall edit buffers, and complex-script caret rendering require the [manual checklist](ux-checklist.md). A synthetic composition test does not prove every OS IME path.

This milestone demonstrates a persistent browser Brush session and the terminal bridge. It does not claim a production filesystem, complete coreutils, arbitrary TUI compatibility, job control, or a browser development environment.
