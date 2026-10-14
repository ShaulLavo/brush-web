# brush-web

Brush runs as Rust/WASM inside a browser worker, connected to Ghostty's byte-oriented terminal. Remix 3 supplies the workbench. The shell session retains cwd, variables, exports, functions, aliases, history, and exit status. Files live in memory until the session ends.

The demo includes completion, grapheme-aware editing, safe bracketed paste, resize handling, incremental terminal output, interruptible stdin, and Ctrl+C cancellation of tight shell loops. Run `browser-help` for the small Rust command host, or `keydemo` for an interactive key and resize demonstration.

## Run the shell

Prerequisites: Node 26.7 or newer, npm, Git, Rust through rustup, and `tar`. The repository pins Rust 1.98.1 and Remix 3.0.0. Use a current browser on localhost or HTTPS.

```sh
git clone --recurse-submodules https://github.com/ShaulLavo/brush-web.git
cd brush-web
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --target wasm32-wasip1
npm ci
npm run build
npm run dev
```

Open `http://localhost:5187/`. The development server provides the required isolation headers. The terminal requests WebGPU when available and labels any Ghostty fallback renderer.

For the built static demo:

```sh
npm run serve
```

Open `http://localhost:4187/`. This server serves files only. Shell commands run inside the browser worker.

Try these as separate submissions to exercise persistent state:

```sh
export COLOR=violet
hello() { echo "hello $1, $COLOR"; }
hello browser
mkdir demo; cd demo
printf 'file data\n' > note; cat note | cat
while :; do :; done
```

Press Ctrl+C during the loop, then run `echo "$? $COLOR"`. The expected result is `130 violet`.

## Verify behavior

Build before running the browser tests. They drive Ghostty's textarea, keyboard, and paste events, then inspect the native terminal grid.

```sh
npx playwright install chromium
npm run verify
npm run test:rust
cargo fmt --manifest-path rust/brush-browser/Cargo.toml --check
```

`npm run verify` builds from pinned sources, checks TypeScript and Oxfmt, and tests the production bundle in Chromium using Ghostty Canvas2D. This is explicitly fallback-renderer coverage. For an installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path.

`npm run compare` inventories actual commands and runs four shared workloads with five warm trials per engine. It checks each result and records raw evidence.

`npm run measure` records startup, actual terminal frame latency, output streaming, and available memory data under `docs/evidence`. It owns and stops its temporary server and browser. Set `BRUSH_RENDERER=webgpu` to request the GPU path and `BRUSH_HEADED=1` to run a visible browser for visual review. Report the returned adapter information; a WebGPU API alone does not prove hardware acceleration.

See the [manual UX checklist](docs/ux-checklist.md), [runtime architecture and patches](docs/brush-runtime.md), [worker transport](docs/architecture.md), [just-bash adapter](docs/baseline.md), and [measured comparison](docs/comparison.md), and [command inventory and workload benchmarks](docs/commands.md).

## Static hosting

Upload the contents of `dist/` to a static host. Serve `.wasm` as `application/wasm` and apply these headers to the page and assets:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

HTTPS or localhost is required. The page explains missing capabilities and offers session restart after a worker failure. All runtime assets come from the same origin. There is no shell backend, PTY server, or command network endpoint.

## Scope and limitations

Brush's WASM pipelines run stages sequentially with a bounded intermediate buffer. Interactive terminal output streams incrementally. Arbitrary native executables, job control, process substitution, networking, packages, and persistence are unsupported. A long parser or regex operation can delay cooperative cancellation until its next execution checkpoint.

The just-bash baseline uses the same terminal and byte bridge, but its public `exec` API isolates shell state and returns collected stdout and stderr. Its adapter preserves files and input history, supplies its own small editor, and discloses those differences. This comparison does not claim equivalent interactive sessions.

The source revisions and archive checksum are in [sources.lock.json](sources.lock.json). Brush is a pinned Git submodule with a checked-in patch; terminal source is downloaded from the public mirror, whose `src/` matches the inspected canonical revision. No dependency requires an existing local checkout. The build generates `dist/THIRD_PARTY_NOTICES.txt` with dependency licenses and the terminal's notices.

## Choose the next architecture change

The [architecture research](reports/Browser%20shell%20architecture%20choices.md) separates avoidable host I/O costs from session, pipeline, and process requirements. It compares supported just-bash improvements and browser-runtime precedents, then defines one bounded experiment before considering a fork.

The [completed performance proof](docs/performance-proof.md) separates worker execution from visible output and records both improvements and remaining losses. OPFS remains deferred.

The [instrumented cost breakdown](docs/execution-costs.md) measures host calls, conversion, copying, queue gaps and submitted frames for both engines, with separate controls for profiler overhead and hardware WebGPU replay.

The [Bashkit comparison](docs/bashkit-comparison.md) evaluates `@everruns/bashkit-wasm` through the same Ghostty adapter and records its session and cancellation limits.
