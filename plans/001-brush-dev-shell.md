# 001: Brush as the shell for a browser dev environment

Status: Approved (owner, 2026-10-15)

## Goal

A browser dev environment in the StackBlitz mould, built on the owner's bun-wasm (`/work/projects/bun-wasm`), needs a real shell. Humans type `bun install && bun dev`; agents use `grep -rn`, `find`, `sed -i`, pipes and loops. This repository is the proving ground. The product gets its own repository later.

## Decision

Brush is the shell. Brush and bun.wasm are both `wasm32-wasip1` programs, so one WASI host can give both one filesystem, real child processes and streaming pipes. Evidence for the choice:

- `docs/bash-compatibility.md`: Brush matches bash on 71–82% of builtins-only cases, against Bashkit source's 84–96% and just-bash's 68–85%. Brush's failures are specific features (namerefs, ERR/DEBUG traps, alias placement), and upstream's own goal is bash compatibility.
- `docs/cold-start.md`: Brush is mid-pack on a cold mobile load (2.3 s on Fast 4G with 4x CPU throttling) and fastest unthrottled.
- just-bash and Bashkit both accept a host filesystem and JS commands, but those commands return buffered strings. Live `bun dev` output and `bun … | grep` would have to be built.

The terminal (xterm.js or the owner's Ghostty WebGPU) provides the line editor; the shell only answers completion requests. Shell-native editing is not a criterion.

Fallback: if step 1 fails, fork Bashkit source and make its custom builtins stream.

## Steps

1. **Brush runs bun as an external command.** Today `std::process::Command` cannot spawn on WASI, and the browser build reports no native processes. Route external commands from Brush to a host spawn slot that starts a bun.wasm child (bun-wasm's host ABI, `docs/host-abi.md` "Bun child processes", and its browser broker `web/src/subprocess-broker.ts`). Acceptance, in the browser:
   - `bun run x.ts` prints output as it is produced, not at exit;
   - `bun run x.ts | grep foo` and `grep foo <(…)`-free pipelines both ways (`echo hi | bun run read.ts`) work with correct bytes;
   - exit codes propagate (`bun run fail.ts; echo $?`), and `&&`/`||` behave;
   - Ctrl+C terminates a long-running `bun run` child and returns to the prompt with status 130;
   - files written by the child are visible to the shell after it exits, and vice versa.
   Today's copy-at-spawn filesystem is acceptable for step 1; step 2 replaces it.
2. **One virtual filesystem on OPFS.** A pool of pre-opened `FileSystemSyncAccessHandle`s, modelled on SQLite's `opfs-sahpool` VFS, owned by one worker. Path-to-slot metadata lives in the pool, so directory operations are synchronous bookkeeping. Brush, bun.wasm and the editor reach it through one WASI host via shared memory. Persists across reloads. Replaces copy-at-spawn and its 8 MiB merge limit.
3. **Commands.** Enable upstream's `brush-coreutils-builtins` (uutils coreutils as in-process builtins, `vendor/brush/brush-coreutils-builtins`). Add `grep` (ripgrep's search crates or uutils-adjacent), `sed`, `awk` and `jq` (jaq) as in-process builtins, so loops do not start a worker per command. Rare tools may be separate WASI programs through the step-1 spawn path. Measure the added binary size.
4. **Interpreter.** Fix namerefs, ERR/DEBUG traps and alias placement first, upstream where accepted. Track with `npm run compat`.

## Out of scope here

Product look and feel, the terminal choice, and the product repository. Those are decided separately with the owner.
