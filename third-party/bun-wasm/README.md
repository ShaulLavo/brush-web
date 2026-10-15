# Bun WASI host source

These four source files are copied without changes from `ShaulLavo/bun-wasm` at the `bunWasm.revision` in `sources.lock.json`:

- `fs.ts`, from `web/src/fs.ts`.
- `wasi.ts`, from `web/src/wasi.ts`.
- `subprocess-fs.ts`, from `web/src/subprocess-fs.ts`.
- `net/trampoline.ts`, from `web/src/net/trampoline.ts`.

The source workspace declares the MIT license. `BUN-LICENSE.md` contains Bun's dependency license notices from that revision. The new process broker and transport are maintained in `src/`.

`bun.wasm.gz` contains the QuickJS WASI executable from the same revision. Its compressed and uncompressed hashes are pinned in `sources.lock.json`. The build expands it into ignored output.
