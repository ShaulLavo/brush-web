# Third-party notices

Brush is MIT licensed and retained as a pinned source submodule with its license. Ghostty WebGPU is MIT licensed; its source archive and included Ghostty WASM notices are pinned by revision and checksum. Remix 3 is MIT licensed. Comlink is Apache-2.0 licensed. browser_wasi_shim is MIT OR Apache-2.0 licensed. just-bash is Apache-2.0 licensed.

`scripts/notices.mjs` copies the license and notice text from the exact Rust and npm dependencies and the terminal source into `public/THIRD_PARTY_NOTICES.txt`. The production build includes that generated file as `dist/THIRD_PARTY_NOTICES.txt`. Distribution must retain it.

The source-built Bashkit Terminal is MIT licensed and pinned separately from the published npm package. Its build gathers license files from Cargo's actual compiler artifacts, including the vt100 and vte dependencies, and includes them in the generated distribution notices.

The new shell's parser is vendored byte-for-byte from Bashkit's `crates/bashkit/src/parser/` at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns), including its upstream unit tests. `shell/parser/LICENSE` retains the upstream license; `sources.lock.json` records every parser file's SHA-256 and the license checksum. The notices script includes that license and the parser workspace's Rust dependency licenses. The error, parser-only limits and monotonic-clock adapters outside the vendored directory are original implementations, not copies of Bashkit's interpreter or the spike's shims. See [the parser workspace](shell/README.md) for the boundary and checks.

The terminal's historical notice names an older Ghostty revision. The actual included `ghostty-vt.wasm` provenance names `7b11f3dca034d8d24369ad3856afe57946d7902a`, and the build records that correction while preserving the original notice text.

The fixed compatibility oracle at `docs/evidence/own-shell-oracle.json` contains
upstream test scripts, not production interpreter code. The corpus source paths,
revisions and license checksums are pinned under `shellScoreboard.corpora` in
`sources.lock.json`; the fixture also records each input file's SHA-256.
Oils `spec/*.test.sh` at `bdc8364c253ce921e033bbc2399ea2ce0be41825` is covered by
its retained [Apache 2.0 license](docs/evidence/licenses/oils-LICENSE.txt).
Brush `brush-shell/tests/cases/compat/**/*.yaml` at
`4cfba081f2f8bcda8150010a57203d020f14f0cc` is covered by the retained
[MIT license, Copyright 2024 reuben olinsky](docs/evidence/licenses/brush-MIT.txt).
Bashkit `crates/bashkit/tests/spec_cases/bash/*.test.sh` at
`491c3281f668b76d64b15210b8f5d7bf97244be0`, excluding the Oils and just-bash ports,
is covered by its [retained MIT license](shell/parser/LICENSE), Copyright
2024–2026 Everruns. GNU bash observations were captured by running those scripts;
GNU bash executable code is not included. Keep these notices and licenses with
copies of the fixture. The new CLI's fixture helpers and replay/comparison scripts
are original code; no additional upstream implementation is ported.
