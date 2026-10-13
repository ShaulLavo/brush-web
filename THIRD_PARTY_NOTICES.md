# Third-party notices

Brush is MIT licensed and retained as a pinned source submodule with its license. Ghostty WebGPU is MIT licensed; its source archive and included Ghostty WASM notices are pinned by revision and checksum. Remix 3 is MIT licensed. Comlink is Apache-2.0 licensed. browser_wasi_shim is MIT OR Apache-2.0 licensed. just-bash is Apache-2.0 licensed.

`scripts/notices.mjs` copies the license and notice text from the exact Rust and npm dependencies and the terminal source into `public/THIRD_PARTY_NOTICES.txt`. The production build includes that generated file as `dist/THIRD_PARTY_NOTICES.txt`. Distribution must retain it.

The terminal's historical notice names an older Ghostty revision. The actual included `ghostty-vt.wasm` provenance names `7b11f3dca034d8d24369ad3856afe57946d7902a`, and the build records that correction while preserving the original notice text.
