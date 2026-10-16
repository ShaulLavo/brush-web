# Third-party notices

Brush is MIT licensed and retained as a pinned source submodule with its license. Ghostty WebGPU is MIT licensed; its source archive and included Ghostty WASM notices are pinned by revision and checksum. Remix 3 is MIT licensed. Comlink is Apache-2.0 licensed. browser_wasi_shim is MIT OR Apache-2.0 licensed. just-bash is Apache-2.0 licensed.

`scripts/notices.mjs` copies the license and notice text from the exact Rust and npm dependencies and the terminal source into `public/THIRD_PARTY_NOTICES.txt`. The production build includes that generated file as `dist/THIRD_PARTY_NOTICES.txt`. Distribution must retain it.

The source-built Bashkit Terminal is MIT licensed and pinned separately from the published npm package. Its build gathers license files from Cargo's actual compiler artifacts, including the vt100 and vte dependencies, and includes them in the generated distribution notices.

The new shell's parser is vendored byte-for-byte from Bashkit's `crates/bashkit/src/parser/` at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns), including its upstream unit tests. `shell/parser/LICENSE` retains the upstream license; `sources.lock.json` records every parser file's SHA-256 and the license checksum. The notices script includes that license and the parser workspace's Rust dependency licenses. The error, parser-only limits and monotonic-clock adapters outside the vendored directory are original implementations, not copies of Bashkit's interpreter or the spike's shims. See [the parser workspace](shell/README.md) for the boundary and checks.

The terminal's historical notice names an older Ghostty revision. The actual included `ghostty-vt.wasm` provenance names `7b11f3dca034d8d24369ad3856afe57946d7902a`, and the build records that correction while preserving the original notice text.

The shell's first word-expansion area is separately adapted from Bashkit at
`491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns).
Implementation sources are `crates/bashkit/src/interpreter/expansion.rs`
(`expand_word_to_fields`, segment protection, positional fields and IFS splitting)
and `crates/bashkit/src/interpreter/mod.rs` (command-name field promotion,
declaration operands and `is_decl_assignment_word`). Adaptations live in
`shell/engine/src/expand.rs`, `interpreter.rs`, `state.rs` and `builtins.rs`.
Tests in `shell/engine/tests/words.rs` adapt
`crates/bashkit/tests/spec_cases/bash/word-split.test.sh`,
`command-word-expansion.test.sh`, `quote.test.sh` and
`crates/bashkit/src/interpreter/mod.rs:15435–15462,18002–18062`.
`sources.lock.json` records these paths separately from the unchanged parser.
The upstream MIT license is retained at `shell/parser/LICENSE` and included by
the notices script. Structural quote protection, cooperative work bounds and
explicit overflow errors replace upstream sentinel/truncation paths; no output
buffering or `mapfile` implementation is included in this port.
