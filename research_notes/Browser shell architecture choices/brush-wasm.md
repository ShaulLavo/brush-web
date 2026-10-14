# Brush browser architecture choices

Research date: 2026-10-14. This review reads source and documentation. It does not run a new benchmark or make source changes. Local evidence refers to brush-web commit `5749936352339bdc3705c6d887042f1443e73355`; Brush is pinned to `4cfba081f2f8bcda8150010a57203d020f14f0cc` with a reproducible local patch. [Project pins](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/sources.lock.json)

## Are the small I/O calls an inherent Brush or WebAssembly penalty?

### Takeaway

No fixed ABI rule requires two crossings for every printed number. This fixture combines an unbuffered utility that we wrote, a simple WASI shim, and a terminal transport. Those choices explain concrete extra work. Brush's sequential WASM pipeline execution is a separate architectural constraint.

### Cited findings

- The project's `seq` utility obtains `context.stdout()`, calls `writeln!(output, "{current}")`, and flushes on every iteration. This is our utility, not upstream Brush's `seq` implementation. It also checks cancellation on every iteration. [Local utility](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/rust/brush-browser/src/utilities.rs#L228)
- Brush's `OpenFile` forwards `Read` and `Write` to ordinary Rust stdin, stdout, stderr, files, pipe ends, or boxed streams. This interface supports another writer that buffers before forwarding. It does not impose one crossing per character or per formatted argument. [Pinned OpenFile](https://github.com/reubeno/brush/blob/4cfba081f2f8bcda8150010a57203d020f14f0cc/brush-core/src/openfiles.rs#L252)
- Rust's `BufWriter` exists specifically to combine small repeated writes into large, infrequent writes. Its documentation requires explicit flushing when callers need to observe write errors. Buffering at this point occurs before the eventual WASI import. [Rust BufWriter](https://doc.rust-lang.org/std/io/struct.BufWriter.html)
- The installed shim is `@bjorn3/browser_wasi_shim` 0.4.2, whose npm metadata identifies git revision `4a55f2a519d0ddfa7e4609c42e0c9769c37c9ae8`. Its WASI `fd_write` copies every iovec with `Uint8Array.slice`, then invokes the descriptor's JS writer. WASI accepts multiple iovecs in one call; the implementation loops over them. [Package metadata](https://registry.npmjs.org/@bjorn3/browser_wasi_shim/0.4.2), [Pinned fd_write](https://github.com/bjorn3/browser_wasi_shim/blob/4a55f2a519d0ddfa7e4609c42e0c9769c37c9ae8/src/wasi.ts#L540)
- The same pinned shim extends a file by allocating an array exactly as large as the new file, copying the old array, then copying the new bytes. This occurs whenever an append grows the file. Its `fd_read` also creates a slice of file data for each call. [Pinned OpenFile storage](https://github.com/bjorn3/browser_wasi_shim/blob/4a55f2a519d0ddfa7e4609c42e0c9769c37c9ae8/src/fs_mem.ts#L45)
- The current shim repository head `b068ec2c22d68581c48f2592f8cca1681bf71a98`, dated 2026-02-03, extracts growth into `dataResize` but still resizes on every growing write. Its README explicitly says it implements a subset of WASI Preview 1 and that other operations may fail or be incorrect. An upgrade alone is not evidence of a solved filesystem cost. [Current file implementation](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/fs_mem.ts#L135), [Current README](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/README.md)
- Upstream `mapfile` reads through a one-byte buffer. This can cause one WASI read for every byte when its `OpenFile` is a file. Buffering that read in JavaScript after entry cannot remove the already-paid import crossing. [Pinned mapfile](https://github.com/reubeno/brush/blob/4cfba081f2f8bcda8150010a57203d020f14f0cc/brush-builtins/src/mapfile.rs#L118)
- `OpenFile::clone` shares the same underlying file through an `Arc`. Rust warns that independent `BufReader` instances over one stream, or dropping a reader with unread buffered bytes, can lose data. A blanket per-command `BufReader` is therefore unsafe for shell descriptors whose file positions must remain shared across commands. [Pinned OpenFile cloning](https://github.com/reubeno/brush/blob/4cfba081f2f8bcda8150010a57203d020f14f0cc/brush-core/src/openfiles.rs#L107), [Rust BufReader](https://doc.rust-lang.org/std/io/struct.BufReader.html)
- Upstream WASM task execution is single-threaded and cooperative. `spawn_blocking` does not yield its returned handle until the task finishes. Upstream WASM pipes buffer everything until read; blocking a producer would prevent the consumer from running. The project patch places a 1 MiB error limit on these pipes. This is distinct from the terminal ring, whose consumer runs on the main thread. [Pinned tasks](https://github.com/reubeno/brush/blob/4cfba081f2f8bcda8150010a57203d020f14f0cc/brush-core/src/sys/wasm/tasks.rs), [Pinned pipes](https://github.com/reubeno/brush/blob/4cfba081f2f8bcda8150010a57203d020f14f0cc/brush-core/src/sys/wasm/pipes.rs), [Project patch](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/patches/brush-browser.patch)
- The project's release profile uses `opt-level = "s"`, thin LTO, and one codegen unit. It prioritizes size in the compiler configuration. No source finding establishes how much a speed-oriented setting would change these workloads. [Runtime Cargo manifest](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/rust/brush-browser/Cargo.toml)

### Inferences

- The two writes observed in this benchmark are an implementation choice. A bounded Rust buffer around this utility can combine number formatting and newlines before crossing into JS. This requires neither a shell rewrite nor a maintained Brush fork.
- Buffering only in the JS host reduces subsequent ring writes or allocations, but cannot reduce the count of Wasm-to-JS calls that have already entered the host. Measure both levels separately.
- Exact-length reallocation makes repeated appends copy a growing prefix repeatedly. This is an algorithm problem in the chosen filesystem storage. A capacity-bearing or chunked storage implementation addresses it without changing Brush parsing or expansion.
- A descriptor-owned read buffer must preserve logical offsets across clones, `read`, `mapfile`, seek, redirections, and close. A small upstream change in this area is justified only with semantic tests. Merely inserting a `BufReader` in `mapfile` can break `read` after partial consumption.
- A throughput improvement must retain prompt visibility and flushing before blocking reads, sleeps, command completion, and cancellation. A timer callback queued on the blocked shell worker cannot flush a Rust buffer. Time-based flushing needs explicit execution checkpoints or an asynchronous scheduler.
- Concurrent bounded pipeline streaming is a deeper requirement than the initial terminal-output benchmark. Fixing terminal output batching does not solve that requirement.

### Gaps

- The profile counts reported earlier in this thread were not repeated in this research lane. This note confirms the source causes, not a new percentage breakdown of their runtime cost.
- There is no measured lower bound here for a Wasm import crossing on this exact browser and CPU. Calling every crossing "terrible" overstates the evidence. Allocation, translation, quota walks, ring operations, and terminal drawing can dominate the host function itself.

## Would another runtime or a Brush fork solve the right problem?

### Takeaway

Retain WASI for the current experiment. A targeted patch is enough to test the visible I/O inefficiencies. Wasmer/WASIX is a credible browser process runtime worth studying when real child programs become a requirement, but it is a larger integration and has no demonstrated performance advantage for this shell fixture.

### Cited findings

- Rust's `wasm32-wasip1` target implements file operations through WASI APIs. It supports `std`, but normal thread creation and process spawning fail. Replacing the WASI implementation does not add process spawning to a program compiled against this target's unsupported standard-library operation. [Rust wasip1 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html)
- Rust's `wasm32-unknown-unknown` target does not provide working `std::fs`; `println!` does nothing and thread spawning panics. The standard-library behavior cannot be overridden for this target. A Rust-host/VFS design using that target must move the shell's filesystem and stdio dependencies behind usable application interfaces. [Rust unknown target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
- Brush already separates its parser, shell state and execution, builtins, and interactive frontend. Platform code belongs under `sys`. The existing `ShellExtensions` trait changes error formatting, not an entire virtual filesystem or process host. [Pinned architecture](https://github.com/reubeno/brush/blob/4cfba081f2f8bcda8150010a57203d020f14f0cc/docs/explanation/architecture.md)
- Current Wasmer SDK source is `0ba1eadc55daff2f1005e5c44eb5d246199187bd`, dated 2026-10-07, following the JS SDK 0.19.1 release. Its browser entrypoint runs Wasmer and WASIX compiled to Wasm. `packages.load` and `packages.create` can run a raw WASI/WASIX module exporting `_start`, without requiring a registry download. It is currently alpha. [SDK README](https://github.com/wasmerio/wasmer-js/blob/0ba1eadc55daff2f1005e5c44eb5d246199187bd/README.md), [JS SDK guide](https://github.com/wasmerio/wasmer-js/blob/0ba1eadc55daff2f1005e5c44eb5d246199187bd/js/README.md)
- The current JS SDK exposes live process stdin, stdout, stderr, exit status, and terminal resize. The guide's interactive-shell example attaches byte streams and a terminal to a process tree. Browser worker execution still requires cross-origin isolation and SharedArrayBuffer. External networking over WISP is optional, and is separate from shell execution. [JS SDK terminal and browser guide](https://github.com/wasmerio/wasmer-js/blob/0ba1eadc55daff2f1005e5c44eb5d246199187bd/js/README.md)
- The SDK's worker pool is explicitly backed by Web Workers and a scheduler. Its current browser shell warns when `WebAssembly.Suspending` and `WebAssembly.promising` are missing. This option does not preserve the initial one-worker architecture automatically. [Worker pool](https://github.com/wasmerio/wasmer-js/blob/0ba1eadc55daff2f1005e5c44eb5d246199187bd/js/bindgen/src/tasks/thread_pool.rs), [Browser feature detection](https://github.com/wasmerio/wasmer-js/blob/0ba1eadc55daff2f1005e5c44eb5d246199187bd/wasmer-sh/src/browser-compatibility.ts)
- Our module imports custom functions from the `browser` module for input, terminal size and modes, sleep, cancellation, and lifecycle. These imports are additional to WASI. The public SDK guide describes execution of WASI/WASIX commands; it does not document a way to inject this project's custom imports. A replacement cannot be assumed to instantiate the existing binary unchanged. [Browser host bindings](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/rust/brush-browser/src/host.rs), [Current runtime contract](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/docs/brush-runtime.md), [SDK raw-module guide](https://github.com/wasmerio/wasmer-js/blob/0ba1eadc55daff2f1005e5c44eb5d246199187bd/js/README.md)
- JSPI bridges synchronous Wasm code and Promise-bearing imports by suspending at those imports and resuming when the Promise resolves. An import that returns a plain value does not suspend. It requires matching `WebAssembly.Suspending` imports and `WebAssembly.promising` exports. It changes boundary behavior without new Wasm instructions. [Pinned JSPI proposal `5b247b1026d2f438eefe51914a79f4218cbda9f9`](https://github.com/WebAssembly/js-promise-integration/blob/5b247b1026d2f438eefe51914a79f4218cbda9f9/proposals/js-promise-integration/Overview.md)
- V8 documents constant-time suspension and resume mechanisms but also event-loop scheduling when a Promise resolves. Its examples deliberately contrast ordinary integer arithmetic, mixed JS/Wasm calls, and suspending calls. These published example timings are not measurements of Brush. [V8 JSPI explanation](https://v8.dev/blog/jspi)
- Asyncify transforms Wasm code to unwind and rewind. Emscripten documents added size and runtime overhead, an approximate example of 50%, indirect-call analysis limits, and reentrancy pitfalls. That published estimate is not a Brush measurement. JSPI leaves the original Wasm code size unchanged. [Emscripten asynchronous code guide](https://emscripten.org/docs/porting/asyncify.html)

### Inferences

- A narrow browser WASI host can be a reasonable product dependency. A simple shim is useful for a spike but is not evidence that every WASI host has the same storage and copying costs.
- A Rust VFS within the guest would avoid JS crossings for ordinary file work, but requires a deliberate shell filesystem abstraction because existing code calls `std::fs`. Compiling a separate WASI host to Wasm is another possibility, with guest-memory access and linking to design. Neither is a cheap runtime flag.
- JSPI could let a blocked read release its worker event loop instead of using `Atomics.wait`. It does not make small output calls disappear and does not preempt a tight pure-Wasm loop. CPU cancellation still needs checkpoints or another interrupt mechanism.
- JSPI alone does not schedule Brush's existing synchronous builtins as concurrent pipeline stages. Its `spawn_blocking` execution semantics and pipe operations still need redesign for that contract.
- Asyncify should be considered only if asynchronous host calls are needed on browsers without the required JSPI support, and measured costs fit the product budget. It is a poor first move for a throughput complaint while a correct dedicated-worker bridge already exists.
- Wasmer/WASIX earns a separate experiment when there is a real need for compiled guest commands, child processes, or a shared guest process filesystem. Downloading packages, outbound TCP, backend proxies, and an IDE are not prerequisites for such an offline experiment. None belongs in the current milestone by default.
- We already maintain a local upstream patch. Creating a separate GitHub fork changes how that patch is organized, not the runtime cost. A broader fork is justified by a required execution or host contract that upstream cannot support, not the two writes in our `seq` utility.

### Gaps

- No SDK binary was installed or run. Startup, bundle size, peak memory, signal behavior, and throughput of Wasmer versus the current host remain unknown.
- The SDK guide does not establish whether the current package exposes arbitrary custom imports. This is a documented integration gap rather than proof of impossibility.
- A WASIX target/toolchain would require a separate compatibility investigation for Brush. Our current `wasm32-wasip1` module must not be credited with WASIX process and terminal features merely because the runtime supports them.
- Current source has browser compatibility messages that name particular version thresholds; V8's page names other historical thresholds. Rely on feature detection and real-browser tests instead of copying either list as a universal support guarantee.

## What experiment should decide whether to stop, patch upstream, or change architecture?

### Takeaway

Run one bounded comparison that removes known host pathologies and gives each engine the best supported adapter for the required behavior. Stop after the experiment answers whether interactive latency, cancellation, bounded output, and applicable command throughput meet the product goal. A faster batch script API does not substitute for a persistent interactive session.

### Cited findings

- The current comparison puts incremental Brush output against just-bash's completed output strings. It documents reset shell state between baseline submissions, fixed stdin, and a different prompt editor. Those are adapter behaviors that make an overall winner claim premature. [Current comparison](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/docs/comparison.md), [Baseline implementation](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/src/baseline.ts)
- The shared bridge has bounded input and output rings, with main-thread draining and worker waiting. Comlink initializes the worker; shared state handles input, resize, cancellation, and shutdown while the synchronous shell loop runs. This already isolates main-thread responsiveness from blocked shell reads. [Current transport architecture](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/docs/architecture.md)
- The Brush patch checks cancellation between commands and shell-loop iterations. Browser reads and sleeps observe the flag. A single long parser or regex operation still lacks internal cancellation checks. [Patch](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/patches/brush-browser.patch), [Runtime limitations](https://github.com/ShaulLavo/brush-web/blob/5749936352339bdc3705c6d887042f1443e73355/docs/brush-runtime.md)

### Inferences

Recommended bounded experiment:

1. Record the actual renderer, browser build, and device adapter. Separate renderer-only replay, worker-only execution, and full terminal interaction. Compare the same renderer configuration for both engines.
2. Add import counts, byte counts, allocation/copy estimates where source permits, and time spent in the host. Use the same terminal transcript or sink for both engines. Keep observed counts distinct from estimated copied bytes.
3. Make only the known changes first: bounded Rust output batching for our producer, capacity-bearing file storage, and safe descriptor buffering where small file reads are measured. Count the reduction in calls before attributing wall-time changes to the interpreter. Compare speed versus size compiler settings only as an explicitly separate configuration.
4. Improve just-bash's adapter within its pinned public capabilities. Measure script batches and interactive sessions separately. A reset-on-submission adapter must not be called the engine's unavoidable state model without inspecting its source and lifecycle API.
5. Run identical scripts for arithmetic-only execution, text processing, file creation and reading, and command substitution. Record unsupported scripts rather than substituting different work. Use streaming workloads to measure first output and completion independently.
6. Run keyboard-driven editing, live stdin, resize while output streams, a persistent state fixture, and Ctrl+C of a tight loop. Compare actual latency, maximum buffering, and post-interrupt usability. These acceptance tests decide product fitness even when batch throughput differs.

Decision rules:

- Keep the current WASI design if removing the obvious host costs meets the agreed UX and throughput budgets. Do not continue optimizing merely because another percent remains available.
- Submit or retain a small upstream patch if the remaining cost comes from byte-at-a-time descriptor use or missing cancellation hooks, and it can preserve native behavior with tests.
- Start a browser-focused Brush host abstraction only if measurements show necessary file/stdio host traffic still dominates after batching, or a required browser filesystem contract cannot fit the existing `std` calls. Record the maintenance cost and upstream direction first.
- Redesign Brush scheduling if the next milestone requires concurrent bounded pipeline streaming, jobs, or child programs. A WASI-host swap cannot solve those constraints in the current shell scheduler.
- Trial Wasmer/WASIX only when that process-runtime requirement exists. Run one raw, local package first with the same terminal and no networking, then measure added startup, memory, and semantic behavior. Do not treat its own terminal UI or advertised shell as proof for our Ghostty integration.
- Retain just-bash if its inspected best adapter meets the needed persistence, interruption, live-input, and streaming contract with acceptable complexity. If it cannot, document that requirement gap independently of speed.

Possible UX budgets should be chosen before the next run and labeled as acceptance targets, not published results. For a desktop 60 Hz test, one or two frames of visible input delay and a bounded interruption time are understandable targets. Cross-device requirements need separate budgets because CPU scheduling and mobile keyboards differ.

### Gaps

- The owner has not specified a throughput target or a maximum fork-maintenance budget. The next experiment should use finite workloads and record the practical decision those results support.
- Full just-bash source/API research is assigned elsewhere. This lane does not claim its public API can or cannot support all interactive requirements.
- No source files, forks, packages, runtimes, processes, or hosted resources were created by this research. Primary pages were read into process memory; only this note is retained.
