# Browser shell transport

One Remix 3 component owns a Ghostty terminal and one `BrowserSession`. A dedicated worker owns the WASI instance and persistent Brush shell. The main thread never waits with Atomics and never executes shell commands.

Ghostty's `onData` supplies `Uint8Array`; output returns through `terminal.write(Uint8Array)`. The application forwards auto-fit resize events and disposes both terminal and worker on restart or removal. Native Ghostty handles browser keyboard encoding, composition, paste envelopes, focus, and terminal escape interpretation.

## Shared memory ownership

The worker blocks in synchronous WASM reads. Comlink initializes the worker asynchronously, before that blocking loop starts. Input, resizing, interruption, and shutdown use shared atomics directly. Queuing a Comlink input callback would deadlock while WASM waits for that callback's bytes.

The input ring has one writer on the main thread and one reader in the worker. The output ring reverses those roles. Each producer publishes a monotonic byte counter after copying bytes. The consumer advances its counter after copying. Counter differences use unsigned arithmetic, so wraparound preserves occupancy. A wake generation prevents input races between checking the queue and waiting.

The main thread pumps output in batches of at most 32 KiB. A full output ring blocks the worker until the main thread drains bytes. Cancellation also wakes this wait. Subsequent small terminal cleanup writes remain possible; a prompt boundary restores terminal modes if a full ring dropped cleanup output. A failed worker stops pumping, releases its proxy, clears pending input, and terminates its owned worker.

Ctrl+C sets a sticky flag. Brush checks it between commands and within every shell loop; browser reads and sleeps also observe it. Execution unwinds with status 130 on the existing shell. The next prompt clears the flag. Input typed during interruption stays in the main-thread queue until acknowledgment, so cleanup cannot discard the next command. Worker termination belongs to explicit failure recovery, not Ctrl+C.

## Limits

| Resource | Limit | Behavior at limit |
| --- | ---: | --- |
| Shared input ring | 64 KiB | Main-thread queue provides backpressure |
| Pending paste queue | 256 KiB | Whole incoming input is rejected with a visible warning |
| Shared output ring | 256 KiB | Worker waits; main thread remains responsive |
| Output drain batch | 32 KiB | Remaining output waits for the next pump |
| Brush pipeline buffer | 1 MiB per pipe | Command fails instead of deadlocking sequential stages |
| Browser filesystem data | 8 MiB | WASI returns a space error on growth |
| Browser filesystem objects | 1,024 | Creation returns a space error |
| Active file descriptors | 128 | Open returns a descriptor limit error; closed slots are reused |
| Brush WASM linear memory | 256 MiB | Allocation failure stops the worker and offers recovery |
| Terminal scrollback | 5,000 lines / 16 MiB | Ghostty evicts older history |
| Recorded latency samples | 256 | Old samples are removed |

File accounting includes open, unlinked files. WASI writes, positioned writes, allocation, and resizing all enforce the byte quota. `/dev/null` discards writes and reports EOF without charging discarded bytes.

## Echo, modes, and Unicode

Brush's native editor owns prompt echo and cursor drawing. Command stdin uses the worker's minimal canonical discipline, with line echo, grapheme backspace, Enter, and EOF. Canonical deletion asks the Rust `browser_scalar_width` export for the same pinned width table used by Brush. Control characters display as caret notation. The `keydemo` utility switches to raw bytes explicitly. The host converts lone LF bytes to CRLF on terminal output, retaining the previous CR across writes. File contents and pipeline bytes receive no newline translation.

Brush's patched edit buffer moves and deletes whole grapheme clusters. Ghostty mode 2027 remains off; the upstream editor's scalar width measurement follows that default convention. Complex scripts, very tall edit buffers, and OS-specific composition require the manual checklist. Incremental UTF-8 decoding occurs only in the just-bash adapter and WASI path decoding; Brush and terminal traffic stay bytes.

## Source decisions

WASI preserves Brush's standard Rust filesystem and stdio code while binding them to browser memory. The alternative `wasm32-unknown-unknown` target would require a much broader filesystem retrofit because Brush calls `std::fs` directly. A second prompt editor would discard the native completion, history, and editing behavior, so this milestone patches the existing VT backend.

The main page uses `createRoot`, `Handle`, `ref`, and `on` from `remix/component` in Remix 3.0.0. It uses neither Remix 2 nor React Router. The terminal comes from the inspected source revision rather than npm's older 0.1.2 release.

## Native Bashkit comparison

The `bashkit-terminal` worker owns Bashkit's source-tree `Terminal`. It sends raw bytes through `sendBytes`, keeps one `runUntilIdle` promise active, and drains `takeOutput` while the future yields. The byte bridge is shared with the other candidates; Comlink still controls initialization. Bashkit owns editing, echo, modes and newline conversion. Its internal vt100 model parses output before Ghostty parses it again. This is an API-level cost that the source experiment keeps rather than patching away.

Input, resize and cancellation can be delivered during asynchronous waits. CPU-bound WASM prevents this worker loop from running, so the native candidate does not meet Brush's tight-loop interruption contract. An idle result can describe a prompt, command stdin or a full-screen program. See the [native comparison](bashkit-comparison.md#source-tree-terminal-api) for tested behavior and bounded-buffer limits.

Ghostty `presentation=immediate` permits a synchronous frame callback during `write`. The session sets its pending-render flag before invoking the output callback so its latency sample is consumed by that frame. Normal frame presentation remains the default. This change affects every engine.
