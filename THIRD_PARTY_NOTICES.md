# Third-party notices

Brush is MIT licensed and retained as a pinned source submodule with its license. Ghostty WebGPU is MIT licensed; its source archive and included Ghostty WASM notices are pinned by revision and checksum. Remix 3 is MIT licensed. Comlink is Apache-2.0 licensed. browser_wasi_shim is MIT OR Apache-2.0 licensed. just-bash is Apache-2.0 licensed.

`scripts/notices.mjs` copies the license and notice text from the exact Rust and npm dependencies and the terminal source into `public/THIRD_PARTY_NOTICES.txt`. The production build includes that generated file as `dist/THIRD_PARTY_NOTICES.txt`. Distribution must retain it.

The source-built Bashkit Terminal is MIT licensed and pinned separately from the published npm package. Its build gathers license files from Cargo's actual compiler artifacts, including the vt100 and vte dependencies, and includes them in the generated distribution notices.

The new shell's parser starts from Bashkit's `crates/bashkit/src/parser/` at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns), including its upstream unit tests. `shell/parser/LICENSE` retains the upstream license; `sources.lock.json` records the base revision, our local change log and the license checksum. The notices script includes that license and the parser workspace's Rust dependency licenses. The error, parser-only limits and monotonic-clock adapters outside the vendored directory are original implementations, not copies of Bashkit's interpreter or the spike's shims. See [the parser workspace](shell/README.md) for the boundary and checks.

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

The shell's first word-expansion area is separately adapted from Bashkit at
`491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns).
Implementation sources are `crates/bashkit/src/interpreter/expansion.rs`
(`expand_word_to_fields`, segment protection, positional fields and IFS splitting)
and `crates/bashkit/src/interpreter/mod.rs` (command-name field promotion,
declaration operands, `is_decl_keyword` and `is_decl_assignment_word`). Adaptations live in
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

The word port also corrects declaration syntax recognition and leading mixed-IFS
handling in quoted `@` words against bounded GNU Bash observations. These local
regressions extend the adapted tests; the declaration command check starts from
Bashkit's `is_decl_keyword` at the same pinned revision. Prefix quote protection
and list-word delimiter handling deliberately diverge from upstream where its
rules disagree with GNU Bash. No additional upstream code or parser changes are
included by these corrections.

Declaration spelling checks also adapt the continuation-removal rule from
`crates/bashkit/src/parser/print_cmd.rs::normalize_raw_word` at
`491c3281f668b76d64b15210b8f5d7bf97244be0`. The engine uses a lazy prefix
iterator, retaining other quotes and escapes. An original engine adapter uses
the unchanged lexer's public raw-capture API within bounded command spans when
`Word.raw` is absent outside function bodies. Escaped declaration spellings
are corrected against GNU Bash; no parser files are modified.

Scalar default and alternative parameter operators are adapted from Bashkit's
`crates/bashkit/src/interpreter/expansion.rs` at the same pinned revision
`491c3281f668b76d64b15210b8f5d7bf97244be0`, under the retained MIT license,
Copyright 2024–2026 Everruns. This takes the scalar `ParameterExpansion` dispatch,
`resolve_param_expansion_name`, the `UseDefault` and `UseReplacement` arms of
`apply_parameter_op`, and quote/operand rules from `expand_operand`,
`parse_marked_operand`, `strip_operand_quotes_with_count`, `operand_word`,
`quoted_operand_used` and `split_word_segments`. Adaptations live in
`shell/engine/src/expand.rs`, `shell/engine/src/expand/operand.rs` and
`shell/engine/src/state.rs`, with shared-work wiring in `interpreter.rs`. The
scanner follows the unchanged quote/escape contract of `read_unquoted_param_body`
and `read_param_expansion_into` in `crates/bashkit/src/parser/lexer.rs` and adapts
opaque substitution boundaries from `read_brace_operand` in
`crates/bashkit/src/parser/mod.rs`. Its `parse_word_string_with_limits` API is
called only after engine admission. Additional cases in `shell/engine/tests/words.rs`
adapt `var-op-test.test.sh`, `variables.test.sh`, `string-ops.test.sh`,
`param-operand-quotes.test.sh` and `word-split.test.sh` from
`crates/bashkit/tests/spec_cases/bash/`; exact ranges and destinations are recorded
under `shellParameterDefaults` in `sources.lock.json`.

Local operand handling streams structural protection into the existing field
splitter instead of inserting upstream quote markers. Only selected scalar
operands are scanned or reparsed. Each synchronous scalar-token reparse is
admitted at 4,096 bytes, with cumulative token-byte/work accounting, cooperative
checkpoints, a 32-level operator limit and a parsed-shape check. Local changes in
`lexer.rs` retain raw backslashes in double-quoted parameter operands and nested
scalar braces inside literal apostrophe spans. Operand matching in `mod.rs` and
the lexer's quoted-word boundary scan keep raw escapes and existing lexer
protection indivisible. The engine removes escapes once and distinguishes quoted
process-substitution lookalikes from unsupported substitutions. Assignment and
error operators, list operands, arrays,
indirection, patterns, pathname/tilde/brace expansion,
arithmetic and substitutions are not ported. The original async engine keeps
its aggregate bounds and cancellation guards; no `mapfile` or output-buffering
code is included.

The parser starts from Bashkit revision `491c3281f668b76d64b15210b8f5d7bf97244be0`
and is now maintained freely as our own code. Its base revision, local change log
and any deliberately removed upstream tests with reasons are recorded under
`shellParser` in `sources.lock.json`. The provenance check validates that record
and the retained license, not byte identity. All upstream parser tests remain in
place; the local quote and escape changes are recorded there.
