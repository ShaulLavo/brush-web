# Shell word fuzzer

`npm run fuzz:shell-words` runs a deterministic differential fuzzer against GNU Bash
5.3.15 and the native `shell-engine` binary. Each generated template is run as a pair,
once at top level and once inside double quotes; `--count` is the total generated cases
(the fixed regressions are additional). It generates scalar parameter defaults,
assignments, alternatives, errors, indirection, length, trim, replacement, and case
operators at the top level and inside double quotes. Operands cover nested expansions,
quote boundaries, escaped and literal braces, raw `${`/`$(` text in single quotes,
slashes, patterns, spaces, empty text, and following words. Seven fixed regressions from
the parameter-boundary review are included in every run. Field capture uses the shell's
registered `argv.py` compatibility helper because native `printf` currently consumes only
one argument; Bash is given an equivalent function.

The command builds the native binary through the shared heavy-job queue, using a temporary
`CARGO_TARGET_DIR`, unless `--shell PATH` (or `FUZZ_SHELL_BIN`) supplies an existing
binary. Build scratch is removed on exit. Useful options are:

```sh
npm run fuzz:shell-words -- --count 3000 --seed 42 --timeout-ms 2000 \
  --output /work/tmp/brush-web-fuzz-seed-42.json
npm run fuzz:shell-words -- --shell /work/tmp/brush-web-climb-parameter-replace-target/debug/shell-engine \
  --count 3000 --seed 42
```

Python 3 supplies Bash's argv dumper; the native compatibility host provides `argv.py`.
This temporarily avoids the known native `printf` format-reuse bug recorded in plan
004 step 3.6, and can be removed when that builtin is fixed.

The summary and full JSON report are printed. `--output` writes the same report to a
persistent file. Each case is `MATCH`, `UNSUPPORTED` (a known unsupported feature exits
2 with a diagnostic while Bash succeeds), or `MISMATCH`; the command exits non-zero when
a mismatch is found. Reports include counts by class, operator and quote/operand feature,
plus minimized mismatches with Bash and shell stdout as both text and base64 bytes.
