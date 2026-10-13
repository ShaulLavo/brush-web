# just-bash baseline

The baseline uses the published `just-bash@3.6.0` browser entry in the dedicated shell worker. Its npm build provenance pins source revision `7537a260e38648e8998db7a95504102ad80b0194`. Commands go through `Bash.exec()`. The terminal and shared byte bridge are the same as Brush's.

## Session differences

The package's [agent instructions](https://github.com/vercel-labs/just-bash/blob/7537a260e38648e8998db7a95504102ad80b0194/packages/just-bash/AGENTS.npm.md) and README explicitly describe isolated execution. Every `exec()` gets fresh cwd, variables, functions, aliases, and exit status. The baseline preserves the in-memory filesystem and its adapter's command history. It displays that distinction before the first prompt.

The adapter does not reconstruct shell state by matching command text. A function or export works within one submitted script. A later submission starts at `/home/web` with the configured environment. `exit` ends that submitted script. Ctrl+D on an empty editing line ends the browser session.

Brush uses its existing `VtInputBackend`. just-bash supplies command execution but no matching interactive backend, so the baseline has a small adapter editor. It supports grapheme cursor movement and deletion, Home and End, 200 entries of history, basic command and file completion, and bracketed paste. Pasted newlines stay in the editing buffer until Enter. Its approximate wide-character widths and editing buffers taller than the viewport need separate acceptance checks. These are adapter limitations.

## Scheduling and output

The editor waits with `Atomics.waitAsync()` in the worker. The browser main thread reads output and supplies input through the same bounded bridge used by Brush.

`Bash.exec()` returns completed stdout and stderr strings. The baseline sends stdout followed by stderr after the command completes. It cannot reproduce Brush's incremental output, output ordering between streams, or live terminal stdin. Pipelines and redirections still run through just-bash against its virtual filesystem.

A proxy over a real `AbortSignal` reads the shared cancellation flag in its `aborted` getter. The interpreter's statement and execution-budget checks therefore observe Ctrl+C even while a tight sequence of microtasks prevents worker message or timer callbacks. A 10 ms worker timer also dispatches the real abort event for waiting commands, such as `sleep`. Interrupting a command sets adapter status 130 and returns to the prompt. It retains filesystem changes already made by the interrupted execution.

## Limits and command coverage

The baseline caps output and strings at 4 MiB per execution, interpreter live bytes at 32 MiB, and stored file data at 16 MiB. The input editor bounds text to 65,536 UTF-16 units, which fits within 256 KiB of UTF-8. Commands have a 60 second execution deadline plus the package's work limits.

The adapter registers 45 package commands for text processing, filesystem operations, shell helpers, and basic utilities. The list is the `commands` array in [`src/baseline.ts`](../src/baseline.ts). Compression commands and SQLite remain outside this baseline's command set. Python, JavaScript execution, and network access remain disabled. `keydemo` belongs to the Brush browser command host and is not a just-bash command.

Compare command fixtures that both engines can execute within one script. Report persistent shell state, interactive stdin, live output, and line editing separately. Startup measurements include different runtime assets and should identify which assets the browser cached.
