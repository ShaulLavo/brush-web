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
process-substitution lookalikes from unsupported substitutions. The assignment
and error follow-on is described below. List operands, arrays,
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

Scalar assignment and error operators also adapt Bashkit at
`491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns).
Sources are `crates/bashkit/src/interpreter/expansion.rs` (`ParameterExpansion`,
`resolve_param_expansion_name`, the `AssignDefault` and `Error` arms of
`apply_parameter_op`, selected operand quote removal, and deferred splitting in
`split_word_segments` and `split_marked_segments`) and
`crates/bashkit/src/interpreter/mod.rs` (`set_parameter_expansion_target`, scalar
branch, and `expansion_error_result` fatal-flow propagation). Adaptations live in
`shell/engine/src/expand.rs`, `expand/operand.rs`, `state.rs` and `interpreter.rs`.
Tests in `shell/engine/tests/words.rs` adapt the scalar assignment/error cases in
`var-op-test.test.sh`, `variables.test.sh`, `string-ops.test.sh`, quote-removal
rules in `param-operand-quotes.test.sh`, and `test_colon_variable_side_effect`.
Exact source paths and adaptations are recorded under `shellParameterEffects`
in `sources.lock.json`; the retained license is `shell/parser/LICENSE`.

Local changes retain bounded selected operands before field splitting, store
unsplit values after quote removal, and use cancellation-safe prefix frames to
preserve completed parameter writes in the caller. Original typed text,
protected-empty and list-separator segments defer field splitting until all word
expansions finish, so selected IFS assignments also govern earlier unquoted
text. List separators retain their expansion-time character and resolve their
boundaries against final IFS. Original GNU Bash adaptations protect data spaces
emitted under empty IFS and select space splitting for positional unquoted `*`
emitted under empty IFS. Literal protection uses the IFS active at emission;
a bounded cache propagates nested IFS writes and is reused for final splitting.
Only an unquoted expansion or quoted `@` requests field splitting. Quoted `@`
and unquoted lists apply Bash's leading mixed-delimiter rules. Coalesced text
stays within the intermediate byte allowance, and collection and splitting share
command work and cancellation checkpoints. Original accounting records list-word
and splitting modes in the existing part visit and uses the first character
checkpoint for nonempty emission and split entry. Empty, captured and list-separator paths keep explicit
checkpoints. Generated separators consume raw UTF-8 bytes before retention and
output bytes when emitted. Per-character work, the command ceiling and shared
argv/redirect parser allowance are unchanged. The shared redirect/argv reparse
regression remains unchanged at its 100-step ceiling and 97-step success. Independent GNU
Bash regressions cover both list orders around IFS writes, quoted/unquoted
`@` and `*`, zero/empty/multiple elements, protected delimiters, `PIPESTATUS`,
literal protection, nested writes, limits and cancellation. No upstream
sentinel strings or flattened-string re-splitting are used. Assignment result
protection,
command-word/RHS/redirect ordering, diagnostic spelling and environment-dependent
fatal statuses follow bounded GNU Bash observations and the unchanged frozen
oracle, deliberately replacing upstream's blanket status 1. Errors stop their
containing shell environment and remain isolated in subshells, pipeline stages
and background jobs. Shared command work/storage bounds and cancellation
checkpoints remain in force. This slice changes no parser files or upstream
parser tests, includes no substitution/array/pattern implementation, and adds no
whole-output buffering.

The assignment/error diagnostic follow-on extends the owned Bashkit-derived
`SimpleCommand` and `Redirect` structures in `crates/bashkit/src/parser/ast.rs`
and their grammar construction in `crates/bashkit/src/parser/mod.rs`, at the
same base revision and under the same retained MIT license. Local adaptations
in `shell/parser/src/parser/{ast.rs,mod.rs}` preserve parse-time diagnostic line
anchors before lexer lookahead, including multiline targets and stored function
bodies. Constructor metadata in `budget.rs` and upstream AST tests retains every
original assertion. The original engine adapter carries these anchors with fatal
parameter errors; it changes no exit statuses or control flow. New original
regressions in `shell/parser/tests/api.rs` and `shell/engine/tests/words.rs` use
bounded GNU Bash observations. `shellParser.changeLog` and
`shellParameterEffects` in `sources.lock.json` record the paths and reasons.

The assignment/error review corrections are original interpreter adapters in
`shell/engine/src/interpreter.rs`, rather than additional upstream implementation.
They retain the effective diagnostic stderr on redirect-target failure, preserve
the distinct prefix-RHS route, and select isolated compound body status only
after redirects succeed. Command preparation finishes diagnostics and releases
its descriptor owners before dispatch or body execution, restoring prompt EPIPE
when a child closes its input before exiting. The existing streaming regression
and all source-anchor assertions are retained. Additional original cases in
`shell/engine/tests/words.rs` follow bounded GNU Bash routing/status observations
and check frame restoration and cancellation. No parser or expansion-field
implementation is changed by these corrections.

The startup IFS follow-on is an original shell-state initialization adapter in
`shell/engine/src/state.rs`, verified against clean GNU Bash 5.3.15 startup.
It seeds nonexported IFS once with space/tab/newline. Later empty, changed and
removed values retain ordinary state representation, without expansion-time
reinitialization. Original state and scalar-operator regressions check startup,
export exclusion, lookup and local restoration. The existing seeded-IFS
cancellation regression remains unchanged. This adapter copies no additional
upstream implementation.

The escape-boundary follow-on uses original typed lexical metadata in
`shell/parser/src/parser/lexical.rs`, carried by the Bashkit-derived lexer and
parser in `shell/parser/src/parser/{lexer.rs,mod.rs}` at the same pinned revision.
It preserves escaped characters as protected literal parts, including expansion
name boundaries, while retaining existing token spellings. Quote and glob
transformations carry the metadata; assignment values retain sliced protection.
Backslash-newline remains a continuation. Indexed spellings are restored from
escape events, and grammar classification respects protected syntax. Metadata
work uses the existing parser and shared request budgets. No new in-band
protection marker or context-specific raw-source reparse is added. Original parser API and engine
regressions cover partial protection, syntax characters, quote continuations,
UTF-8, assignments and stored functions; upstream assertions remain intact.
`shellParser.changeLog` records the local paths and reason. The engine fixtures
explicitly remove startup IFS only for observations made with native `unset IFS`.
Separate controls retain Bash startup behavior and all 136 prior observations.

Scalar parameter length expansion adapts Bashkit revision
`491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns).
The scalar `Length` arms of `expand_word` and `expand_operand`, and `shell_length`
in `crates/bashkit/src/interpreter/expansion.rs`, together with `expand_variable`
in `crates/bashkit/src/interpreter/mod.rs`, inform the implementation in
`shell/engine/src/expand.rs` and `expand/operand.rs`. Tests in
`shell/engine/tests/words.rs` adapt scalar cases from `variables.test.sh`,
`string-ops.test.sh`, `unicode.test.sh`, `bashbox-utf8.test.sh` and
`c-locale-length.test.sh`. Exact source ranges and destinations are recorded
separately under `shellParameterLength` in `sources.lock.json`; the retained
license is `shell/parser/LICENSE`.

Local adaptations bound input snapshots before copying and count cooperatively
under shared command work and cancellation limits, without holding state borrows
across awaits. The decimal result uses existing quote-aware field construction.
Current nonempty `LC_ALL`, `LC_CTYPE`, then `LANG` select byte or Unicode scalar
counting. Case-insensitive `.UTF-8` and `.UTF8` suffixes select scalar counting;
C/POSIX, all-empty and unrecognized locales select bytes. The all-empty C fallback
follows native Bash, deliberately differing from Bashkit's UTF-8 default.
Only identifiers, positive positional parameters, `?` and `#` are supported.
Arrays, lists, patterns, nounset and substitutions remain outside this port.
Parser behavior and tests are unchanged.

Local length-target admission validates positive decimal syntax independently of
machine index width, including leading zeros, retaining zero exclusion and the
existing token cap. This original adapter correction leaves scalar assignment
targets and parameter lookup unchanged.

Scalar prefix/suffix pattern removal adapts Bashkit revision
`491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT, Copyright 2024–2026 Everruns).
The trim arms of `apply_parameter_op`, `expand_pattern_operand`, `remove_pattern`
and `remove_pattern_glob` in `crates/bashkit/src/interpreter/expansion.rs`, and
the basic wildcard/bracket rules in `glob_match_steps` and `match_bracket_expr`
in `crates/bashkit/src/interpreter/glob.rs`, inform the adaptations in
`shell/engine/src/expand.rs`, `expand/operand.rs` and `expand/pattern.rs`.
`shell/engine/tests/words.rs` adapts the scalar cases in
`remove-pattern-glob.test.sh`, `param-operand-quotes.test.sh` and
`variables.test.sh`. Exact paths, ranges, destinations, classification and local
divergences are recorded in `shellParameterTrim` in `sources.lock.json`.
The retained MIT license is `shell/parser/LICENSE`.

Only ordinary scalar identifier targets and literal, `*`, `?` and basic bracket
patterns are included. Empty/unset values skip pattern evaluation, as verified
with GNU Bash. Patterns keep structural quote protection independently of result
protection; pattern writes use the existing scalar effects and final IFS rules.
Selected nested scalar forms retain token, cumulative reparse and depth limits;
skipped operands remain lazy. The original iterative async matcher advances
basic-glob states over borrowed UTF-8 boundaries, reversing atoms and input
traversal for suffixes. It copies no candidate strings, has no 10,000-call cap,
and returns an explicit error on exhaustion instead of a partial result or a
false match. Input snapshots are admitted before copying, and every scan,
storage-building and matching loop uses shared command work/cancellation checks.
No state borrow crosses an await. Snapshot, character, atom and state storage
share the existing command storage ceiling, including vanished results.

Unicode scalar matching and codepoint ranges are checked against focused GNU
Bash probes under `LC_ALL=C.UTF-8`; byte-locale matching and locale collation are
deferred. Extglob, named classes and collation/equivalence constructs fail closed
when selected; quoted spellings are literal. Arrays, special/positional trim
targets, replacements, substring/arithmetic, substitutions, tilde, pathname and
brace expansion remain outside the slice. The parser correction below retains
the license and all upstream assertions. No process-host, browser transport or output buffering code
is copied or changed. Fixed oracle, scorer, cases, classifications, exclusions,
baseline and plan scores remain unchanged; runtime and corpus results await the
coordinator's CI.

The trim review repairs are original adapters in `shell/engine/src/expand.rs`
and `expand/operand.rs`, plus an original `ParameterHeader` helper in the
Bashkit-derived `shell/parser/src/parser/lexer.rs`. The upstream source is
`crates/bashkit/src/parser/lexer.rs::read_unquoted_param_body` at the same pinned
revision. No additional upstream implementation is copied. A direct pattern
source space retains protection before dynamic escape normalization; nested
selected operand results retain their expansion and IFS protection instead.
Source tabs/newlines and the existing empty-IFS space rule are unchanged.

Each nested unquoted parameter tracks its target header and actual subscripts
under the existing nesting ceiling. Basic pattern brackets now reuse ordinary
single-quote handling, preserving quoted opening/closing braces inside the
operand. Actual target subscripts retain raw quoting. Original escape metadata,
quote emission, character budgets and upstream assertions are preserved; no
sentinel or reparse path is added. The parser version is `0.0.4`; root and engine
versions are unchanged. Original regressions in `shell/engine/tests/words.rs`
and `shell/parser/tests/api.rs` use focused GNU Bash `C.UTF-8` controls for all
four trims, scalar and lazy contexts, partial protection, malformed brackets,
quoted error messages and unrelated parser paths. They also check that nested
length inputs share snapshot storage while ordinary PR20 length behavior keeps
its existing limits. `shellParser.changeLog` and
`shellParameterTrim.reviewCorrections` classify the paths and local changes.
Fresh runtime and corpus checks for these repairs remain coordinator-owned CI.

## Scalar parameter case modification

The scalar `^`, `^^`, `,` and `,,` dispatch, first-character selection and
per-character pattern rules in `shell/engine/src/expand.rs` and
`expand/pattern.rs` adapt Bashkit's `crates/bashkit/src/interpreter/expansion.rs`
(`apply_parameter_op:3238-3241`, `change_case:3250-3277` and
`expand_pattern_operand:3286-3290`) at revision
`491c3281f668b76d64b15210b8f5d7bf97244be0`, under the retained MIT license at
`shell/parser/LICENSE`. Focused examples in `shell/engine/tests/words.rs` adapt
`variables.test.sh:226-253`, `string-ops.test.sh:73-85` and
`bashbox-word-expander.test.sh:181-186` in the pinned
`crates/bashkit/tests/spec_cases/bash/` directory. Exact paths, classification,
destinations and divergences are recorded in `shellParameterCase` in
`sources.lock.json`.

The async integration, selected-token admission, quoted-empty pattern flag,
reusable matcher state and `expand/case.rs` locale table are original adapters.
The existing bounded scalar-trim matcher and structural operand scanner are
reused. Unlike upstream, quoted empty patterns match nothing, only unset targets
skip operands, and full Rust Unicode case expansion is not used. GNU Bash 5.3.15
controls check both directions for all 255 non-NUL Latin-1 characters under
`C.UTF-8` and `C`, including unchanged sharp-s and the single-character micro-sign
and y-diaeresis mappings. `C`/`POSIX` map ASCII with ASCII patterns; `C.UTF-8` and
`C.utf8` additionally map Latin-1 inputs. Other selected UTF-8 inputs, other
locales and non-ASCII byte-locale patterns fail closed. Unmatched characters and
first-form tails remain unchanged. This does not claim full Unicode or locale
collation compatibility. Pattern effects precede locale selection and final IFS
splitting; shared bounds, cooperative yields and cancellation-safe frames remain
in force. No process host, browser transport or output buffering is copied or
changed. Versions and fixed measurement metadata remain coordinator-owned.

The original integration also reserves actual matcher vector capacities and case
result String capacities before allocation, including spare slots. Exact-budget
unit controls reject before growth; this is not copied from Bashkit.

Scalar indirection adapts Bashkit's `expand_word` `IndirectExpansion` branch
(`crates/bashkit/src/interpreter/expansion.rs:655-717`), ordinary scalar checks in
`indirect_target` (`2795-2860`) and indirect field-splitting classification
(`1893-1912`) at revision `491c3281f668b76d64b15210b8f5d7bf97244be0`.
Copyright 2024-2026 Everruns; the retained MIT license applies. The four scalar
cases in `crates/bashkit/tests/spec_cases/bash/indirect-expansion.test.sh:1-31`
and plain cases in `blackbox-exploration.test.sh:434-438`,
`string-ops.test.sh:57-63` and `variables.test.sh:254-266` are adapted into
`shell/engine/tests/words/indirect.rs`. Exact sources, destinations, classification
and divergences are recorded under `shellParameterIndirect` in `sources.lock.json`.

The direct resolver in `shell/engine/src/expand/indirect.rs`, shared budget
integration in `expand.rs`/`expand/operand.rs`, fatal-error metadata in
`interpreter.rs` and GNU Bash 5.3.15/engine regression controls are original
adapters. Only identifier pointers to identifier scalars and the existing eight
scalar conditional operators are included. Snapshots are admitted before bounded
atomic copies; scans and validation share cooperative Work. Invalid indirection
has fatal status 1; selected scalar errors keep the existing environment status
and descriptor/source ownership. Nested error names are preserved separately from
the outer `!pointer` label. The upstream `desugar_indirect` target-string reparse
is inspected but not copied. No target value is parsed or evaluated. Positional
and special names, arrays/namerefs, listings/options and generic indirect suffixes
remain unsupported, including all subscript-bearing target values. Full invalid
names fit the diagnostic limit or fail explicitly, rather than being truncated
at upstream's 256-character diagnostic prefix. No parser, process, browser,
filesystem, `mapfile` or output-buffering implementation is copied or changed.
