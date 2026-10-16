# Shell word fuzzer

`npm run fuzz:shell-words` runs a deterministic differential fuzzer against GNU Bash
5.3.15 and the native `shell-engine` binary. Each generated template is run as a pair,
once at top level and once inside double quotes; `--count` is the total generated cases
(the fixed regressions are additional). It generates scalar parameter defaults,
assignments, alternatives, errors, indirection, length, trim, replacement, and case
operators at the top level and inside double quotes. Operands cover nested expansions,
quote boundaries, escaped and literal braces, raw `${`/`$(` text in single quotes,
slashes, patterns, spaces, empty text, and following words. Seven fixed regressions from
the parameter-boundary review are included in every run. Field capture uses a repeating
`printf '<%s>\\n'` format so every post-expansion field is observed without a helper.

The command builds the native binary through the shared heavy-job queue, using a temporary
`CARGO_TARGET_DIR`, unless `--shell PATH` (or `FUZZ_SHELL_BIN`) supplies an existing
binary. Build scratch is removed on exit. Useful options are:

```sh
npm run fuzz:shell-words -- --count 3000 --seed 42 --timeout-ms 2000 \
  --output /work/tmp/brush-web-fuzz-seed-42.json
npm run fuzz:shell-words -- --shell /work/tmp/brush-web-climb-parameter-replace-target/debug/shell-engine \
  --count 3000 --seed 42
```

The summary and full JSON report are printed. `--output` writes the same report to a
persistent file. Each case is `MATCH`, `UNSUPPORTED` (a known unsupported feature exits
2 with a diagnostic while Bash succeeds), or `MISMATCH`; the command exits non-zero when
a mismatch is found. Reports include counts by class, operator and quote/operand feature,
plus minimized mismatches with Bash and shell stdout as both text and base64 bytes.

## Recorded CI gate

Bash 5.3.15 is not available on every CI runner, so the two checked-in fixtures under
`scripts/fixtures/` contain the Bash stdout/status oracle for 3,000 generated cases plus
fixed regressions at seeds 1 and 42. Recording rejects any Bash version other than 5.3.15
and requires a clean native run:

```sh
npm run fuzz:shell-words -- --count 3000 --seed 1 \
  --shell /path/to/release/shell-engine \
  --record scripts/fixtures/shell-words-seed-1.json
```

Replay never invokes Bash. It regenerates the cases and rejects a fixture whose source
hash, seed, count, operator list, quote pairing, case identity, or script differs from
this fuzzer, then compares native status and stdout bytes with the recorded oracle:

```sh
npm run fuzz:shell-words:ci -- --shell .build/shell/release/shell-engine
```

The CI replay is strict: it pins the fixture count to 3,000 generated cases and treats
both `UNSUPPORTED` and every status or byte difference as a failure, exiting non-zero.
