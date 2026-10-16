# Bash compatibility

**Verdict.** Source-built Bashkit matches GNU bash most closely, and the gap is large. On scripts that use only shell builtins it agrees with bash on 95% of the Oils spec cases. Brush in the browser agrees on 78% and just-bash on 85%. The Oils number flatters Bashkit and just-bash, because both projects test against Oils (details below). Bashkit still leads on corpora it was not tuned for: on Brush's own test cases it scores 84%, compared with 71% for Brush in the browser and 77% for natively built Brush. This study recommended Bashkit source over its npm release, whose published 0.18.2 scores only 55% on Oils. Plan 004 now builds an original engine; its fixed scoreboard is described below. Bashkit has one serious bug to fix first: the `mapfile` budget leak described below.

Reproduce with `npm run compat`. Raw results, one line per case, are in [bash-compatibility.json](evidence/bash-compatibility.json).

## Method

- **Oracle:** GNU bash 5.3.15(1)-release, run as `bash -c` with empty stdin. Oils' own expected-output annotations are ignored.
- **Pass:** stdout bytes and exit status identical to bash. Each engine's `$TMP` and `$HOME` paths are normalized first. stderr is recorded but not scored, because error messages legitimately differ. Bash and the engines produced stderr in the same cases (both empty or both non-empty) for 97–99% of passing Oils cases.
- **Fresh shell per case,** 10-second timeout. Crashes and timeouts count as failures.
- **Interpreter score versus commands:** bash runs each case once with the full `PATH` and once with only the two test helpers on `PATH`. A case is *builtins-only* when both runs agree. Only builtins-only cases form the interpreter score. Other cases need external commands or start `$SH`. They are reported separately, and a failure is labeled *missing command* when the engine lacks a command bash needed.
- **Determinism:** bash runs each case twice, and cases with differing results are dropped (8 in total).
- **Helpers:** Oils cases call `argv.py` and `printenv.py`. Bash gets Python 3 equivalents of Oils' Python 2 scripts. The other engines get identical builtins.

| Engine | How it ran |
| --- | --- |
| Brush (browser) | Pinned Brush plus `patches/brush-browser.patch`, built for `wasm32-wasip1`. A second binary in `rust/brush-browser` (`brush-compat`) builds the same shell as the browser binary, with the same `brush-core`, Bash-mode builtins and browser utilities, but runs a script instead of the interactive editor. It runs under `node:wasi` with an in-memory-like root directory. |
| Bashkit source | WASM from `npm run build:bashkit` (the `bashkit-terminal` engine), through `Bash.execute` with the workbench options. A thrown parse error counts as status 2. |
| Bashkit 0.18.2 | Published `@everruns/bashkit-wasm`, same options. |
| just-bash 3.6.0 | `Bash.exec` with `rawScript` and the workbench's execution limits, all bundled commands. |
| Brush native | Reference only: the same pinned source built natively, run as `brush -c` with host commands. It separates Brush's interpreter from its browser port. |

## Corpora and bias

| Corpus | Written by | Used how | Bias |
| --- | --- | --- | --- |
| [Oils spec tests](https://github.com/oils-for-unix/oils/tree/bdc8364c253ce921e033bbc2399ea2ce0be41825/spec), pinned in `sources.lock.json` | Oils project | **Primary.** 120 files that compare against bash, 2,492 cases | **Not neutral.** just-bash vendors these files in its test suite. Bashkit runs this suite against real bash as a tracked metric (`just oils-spec`; nine result snapshots on 2026-10-08 and 09 alone). Only Brush is untuned. |
| Brush `brush-shell/tests/cases/compat` | Brush | Secondary. Cases defined only by a script (2,228 of 2,894) | Home suite for Brush, held out for the others. 601 cases are marked as known Brush failures. |
| Bashkit `tests/spec_cases/bash` | Bashkit | Secondary. Files ported from Oils or just-bash are dropped (3,825 scored) | Home suite for Bashkit, held out for the others. |

Excluded Oils files cover interactive editing, history, completion, prompts and bind; job control, cross-process signals, ulimit, umask and times; shell executable flags (`sh-usage`); xtrace, whose output is stderr only; and files with no bash comparison. The JSON lists each file and its reason. Also excluded: 30 Oils cases that read files from the Oils repository, and the Brush harness cases that need arguments, fixture files, a terminal or environment setup.

## Results: builtins-only (interpreter)

| Oils category | Cases | Brush (browser) | Bashkit source | Bashkit 0.18.2 | just-bash | Brush native |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Quoting and word splitting | 73 | 91.8% | 97.3% | 63% | 93.2% | 93.2% |
| Parameter expansion | 173 | 69.9% | 92.5% | 53.2% | 86.1% | 69.9% |
| Brace expansion | 53 | 96.2% | 94.3% | 56.6% | 96.2% | 98.1% |
| Arithmetic | 116 | 83.6% | 96.6% | 59.5% | 93.1% | 83.6% |
| Arrays and assoc arrays | 127 | 66.9% | 95.3% | 29.1% | 87.4% | 67.7% |
| Assignment, scope and special vars | 109 | 77.1% | 93.6% | 55% | 80.7% | 78% |
| Command substitution and subshells | 25 | 92% | 100% | 80% | 100% | 92% |
| Globbing and extglob | 76 | 92.1% | 100% | 55.3% | 77.6% | 92.1% |
| Conditionals, test, `[[ ]]` and case | 146 | 89.7% | 99.3% | 60.3% | 97.9% | 91.1% |
| Grammar, functions and control flow | 180 | 86.1% | 95% | 75.6% | 86.7% | 88.3% |
| Here-docs and redirects | 44 | 81.8% | 95.5% | 65.9% | 95.5% | 90.9% |
| Pipelines | 12 | 91.7% | 100% | 83.3% | 100% | 91.7% |
| errexit, options and traps | 164 | 61.6% | 93.9% | 44.5% | 57.3% | 67.1% |
| echo, printf, read, mapfile, getopts | 147 | 82.3% | 95.2% | 60.5% | 93.2% | 83% |
| Other builtins (cd, eval, source, type, alias…) | 155 | 65.2% | 94.8% | 47.7% | 80.6% | 71.6% |
| Real-world idioms (ble.sh, blogs, Nix) | 82 | 78% | 92.7% | 39% | 81.7% | 79.3% |
| **Oils overall** | **1,682** | **78.4%** | **95.4%** | **55.1%** | **85.3%** | **80.4%** |
| Brush suite (held out except for Brush) | 1,889 | 70.8% | 84.1% | 55.8% | 68.3% | 76.9% |
| Bashkit suite (held out except for Bashkit) | 2,223 | 82.1% | 96.2% | 70.8% | 81.3% | 84.6% |

On each engine's held-out corpora, Bashkit source scores 84.1% on the Brush suite, against Brush's own 70.8% (browser) and 76.9% (native). Brush scores 82.1% on the Bashkit suite and just-bash 81.3%. just-bash's lead over Brush on Oils mostly disappears on the two corpora it did not import.

## Results: cases needing external commands

| Corpus | Cases | Brush (browser) | Bashkit source | Bashkit 0.18.2 | just-bash | Brush native |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Oils | 779 | 47.8% | 93.2% | 43.9% | 83.3% | 80.9% |
| Brush suite | 339 | 33.3% | 72% | 40.1% | 54.6% | 83.2% |
| Bashkit suite | 1,602 | 12.6% | 94.5% | 61.7% | 59.9% | 94.4% |

Most Brush failures here are missing commands (1,623 of its failures across the three corpora). This measures the browser command set, not the interpreter.

Of the 60 common commands probed with `command -v`, the browser Brush build has 12: `cat ls mkdir rm touch seq printf echo test true false sleep`. Bashkit source has 59 (no `python3`), Bashkit 0.18.2 has 57 (no `bash`, `sh` or `python3`), and just-bash has 55 (no `realpath hexdump df curl python3`). The table also includes 23 option-level spot checks of `grep`, `sed`, `awk`, `sort`, `uniq`, `cut`, `tr`, `head`, `tail`, `wc`, `find`, `xargs` and `jq` against GNU output. Bashkit source passes 21, Bashkit 0.18.2 passes 21, just-bash passes 20, and Brush passes 0 because it has none of those commands. `grep -r --include` and `wc -l -w` padding failed in all three. `uniq -c` failed only in just-bash.

## Most consequential failures

**Brush (browser).** Namerefs (`declare -n`) are unimplemented: 24 of 29 Oils cases fail, and Brush marks 190 of its own nameref cases as known failures. Alias expansion applies to quoted words and to aliases defined on the same line (`alias`: 20 failures). `trap ERR` and `trap DEBUG` do not follow bash (46 failures across the three trap files). Several `printf` format corners fail (17), and so do `command`/`builtin` forwarding of declaration builtins and arrays with odd subscripts. Some failures come from the browser port rather than the interpreter. In this run any `$$` panicked the WASM module (`std::process::id()` is unsupported on WASI): 52 crashes across corpora. `$$` and `$BASHPID` now report PID 1, as Bashkit does. A Brush-only rerun after that fix leaves 2 crashes, in a brace sequence with a huge increment and an alias inside `PS4` (both also fail natively), and raises the builtins-only pass rates to 78.5% (Oils), 71.2% (Brush suite) and 82.3% (Bashkit suite). The tables above predate the fix. `exec` and `kill` are missing. Brush native passes 2–6 points more, which bounds this port cost.

**Bashkit source.** Few and scattered: `printf` integer overflow and `%(...)T`, nounset inside arithmetic (status 1 instead of bash's 127), tilde expansion in `[k]=v`, some `${!ref}` corners, and `trap ERR` with pipelines. Its API rejects unparsable scripts with an exception instead of a status. Its largest deficit is on the Brush suite (84%), which shows real gaps beyond its tuned corpus, in areas including nameref corners, `set -u` cases, `extdebug`/`functrace` DEBUG traps, `getopts`, and backtick escaping. It is a sandbox with resource budgets, and the mapfile bug shows that a budget failure can corrupt state silently.

**just-bash.** Traps are mostly missing or wrong (55 failures in the three Oils trap files). Glob results are wrong after variable or `$@` expansion (12), and so are alias expansion corners (13), `errexit` inside command substitution, `local`/`readonly` corners, and `type -a`. Output is UTF-16 text rather than bytes, so `printf '\xff'` does not produce byte 0xFF.

**Bashkit 0.18.2** fails broadly (arrays 29%) because the large compatibility work landed after that release.

## mapfile triage (Bashkit)

The earlier "empty after about ten 10,000-line `mapfile` runs" result is a real interpreter bug, not the 32 MiB `maxMemory` setting. Raising `maxMemory` to 256 MiB or leaving it unset changes nothing.

```bash
seq 50000 > /tmp/s
for i in 1 2 3; do mapfile -t a < /tmp/s; echo "mapfile=$? n=${#a[@]}"; done
b=(x y z); echo "b=${#b[@]}"
```

Bash prints `n=50000` three times and `b=3`. Bashkit source and 0.18.2 print `n=50000`, `n=50000`, `n=0`, `b=0`, all with status 0 and no stderr. The effect persists in later `execute()` calls on the same instance; a new instance is clean.

Cause: `mapfile` replaces the array through builtin side effects that remove the old array without releasing its entries from the memory budget. Each call therefore adds its full line count to `array_entries`. At 100,000 entries (`DEFAULT_MAX_ARRAY_ENTRIES`, which the WASM options do not expose), `insert_array_checked` refuses the insert, and callers ignore that refusal. From then on, every array assignment in the session silently produces an empty array. Ten 10,000-line reads hit exactly that threshold. The probe output is under `mapfile` in the evidence JSON. A ready-to-file upstream report, with source locations and a suggested fix, is in the owner's upstream-bug list. A fork must fix both the leak and the ignored refusal.

## Caveats

- Brush runs on `node:wasi`, not the browser's WASI shim. The interpreter is identical, but filesystem edge cases may differ slightly.
- `bash -c` differs from Oils' practice of feeding code on stdin, for example in `read` without a redirect. Every engine runs the same way.
- Category labels group Oils files by subject. Cases inside a file can touch other features.
- Bashkit and just-bash were tuned against Oils. Treat their Oils numbers as upper bounds, and use the held-out rows for the comparison.


## Own-shell fixed scoreboard

The original `shell-engine` CLI is registered as `own-shell`. Brush is still the
browser default. The first measured baseline is **288/1,682 Oils, 295/1,888 Brush-suite and
445/2,222 Bashkit-suite**. The historical engine tables above keep their original
case sets and are not a comparison under this new fixed identity.

| Corpus | Previously classified builtins-only cases | Fresh scored cases | Own-shell passes |
| --- | ---: | ---: | ---: |
| Oils | 1,682 | 1,682 | 288 |
| Brush suite | 1,889 | 1,888 | 295 |
| Bashkit suite | 2,223 | 2,222 | 445 |

Two fresh GNU bash runs disagreed on `brush-suite:options/set-e:145` and
`bashkit-suite:background:11`. Both retain the explicit exclusion
`fresh bash oracle output is not deterministic`. These account for the two
smaller denominators. Oils remains at 1,682. No existing engine was rescored on
this changed set, so the earlier percentages must not be treated as fixed-set
pass-count targets without rerunning those engines under the same identity.

The [oracle capture](https://github.com/ShaulLavo/brush-web/actions/runs/38882400825)
used source `2b27d77`, GNU bash 5.3.15 inside bubblewrap and Node v26.7.0. The
[baseline measurement](https://github.com/ShaulLavo/brush-web/actions/runs/38882791088)
used source `5489846`. Initial metadata was refined from `nodeMajor: 26` to the
exact `nodeVersion: "v26.7.0"` used by setup-node. GNU bash observations, case
classifications and source-file hashes did not change. The baseline identity
was resealed to match this metadata; no shell was rerun for that refinement.

[The committed baseline](evidence/own-shell-baseline.json) records exact counts
for all 16 Oils subject categories, 120 Brush file categories and 261 Bashkit
file categories, including categories whose cases are all skipped. Its `counts`
are recomputed from per-case outcomes when validated. Oils' first scored counts:

| Oils category | Scored cases | Passes |
| --- | ---: | ---: |
| Quoting and word splitting | 73 | 38 |
| Parameter expansion | 173 | 6 |
| Brace expansion | 53 | 5 |
| Arithmetic | 116 | 1 |
| Arrays and assoc arrays | 127 | 5 |
| Assignment, scope and special vars | 109 | 9 |
| Command substitution and subshells | 25 | 2 |
| Globbing and extglob | 76 | 24 |
| Conditionals, test, [[ ]] and case | 146 | 21 |
| Grammar, functions and control flow | 180 | 82 |
| Here-docs and redirects | 44 | 26 |
| Pipelines | 12 | 9 |
| errexit, options and traps | 164 | 19 |
| echo, printf, read, mapfile, getopts | 147 | 14 |
| Other builtins (cd, eval, source, type, alias...) | 155 | 16 |
| Real-world idioms | 82 | 11 |

The fixed set starts from the published case membership in
`docs/evidence/bash-compatibility.json`, including all excluded and external-case
classifications. It does not rediscover eligibility on each CI machine. Capture
loads scripts from the same pinned source paths and checks their IDs and names
against that classification. GNU bash 5.3.15(1)-release runs each selected case
twice, with fresh home/tmp directories, empty stdin and `LC_ALL=C.UTF-8`.
The old engines' outputs are never used as expected shell behavior. New oracle
timeouts, output-limit failures and nondeterminism become explicit exclusions,
so any difference from the historical totals must be reported in this table.

Capture runs inside bubblewrap with network namespaces disabled, a read-only
`/usr`, private home/tmp directories and the two Python fixtures. Owner files and
credentials are not mounted. The executable's SHA-256, version, capture platform,
helper hash and classification hash are recorded. Every source file's SHA-256
and upstream revision is recorded too. The source paths and retained upstream
licenses are listed in `sources.lock.json` and `THIRD_PARTY_NOTICES.md`.

`docs/evidence/own-shell-oracle.json` contains script text, category, case ID,
classification and exact normalized stdout/stderr bytes in base64 plus numeric
status. Only stdout and status decide a pass. stderr stays separate and is kept
for inspection. Oracle observations keep full bytes. Score diagnostics keep at
most 240 bytes per stream; longer streams include their full byte length and
SHA-256. Passing cases need no diagnostic copy. Compaction happens after the
exact comparison and does not affect scoring. Paths normalize to `$TMP` and `$HOME`; no UTF-8 conversion is used
for scoring. Oils keeps its subject categories; the secondary corpora use their
source file paths as categories. All skipped cases stay in the fixture and in the
result. The exact scored denominator is `total - skipped` in each count group.

CI uses Node 26.7.0 and `node:wasi` to run only those selected cases against the
release `wasm32-wasip1` CLI. Each case gets a fresh memory filesystem with no host
preopens and only the two fixture process programs. There is a 10-second timeout
and a 4 MiB combined output ceiling per case. A crash or timeout fails that case;
it never silently becomes a skip. The CLI drains both output pipes between
executor turns; it does not collect program output until exit. Browser transport,
shared filesystem behavior and cold-start measurement remain deferred until
browser integration. Plan 004 steps 2 and 3 can use the tested stand-ins, but
step 1's real browser gate must pass before step 6 replaces Brush.

```sh
# Normal fixed replay, no installed GNU bash or corpus sources required.
npm run compat:shell

# Keep exact per-case results, counts, gained/lost IDs and newly failing cases.
BASH_COMPAT_OUT=/work/tmp/brush-web-current.json npm run compat:shell

# Also compare with the baseline on the target branch, as pull-request CI does.
BASH_COMPAT_BASE_REF="$(git merge-base HEAD origin/main)" npm run compat:shell

# Cheap mutation/selection tests, independent of Rust and the corpora.
npm run test:shell:scoreboard
```

The baseline stores exact outcomes and counts per corpus and category. Replay
rejects a changed case set, oracle observations, source identity, Node version,
environment policy or skip classification. It fails if **any corpus** loses a
pass in its exact count, even if rounded percentages or an aggregate score would
hide it. Gains and losses within a corpus are reported separately, including a
newly failing list that needs a named reason in the PR.

The compatibility CI job requires the candidate's committed per-case pass
membership to equal the fresh result. Gains must update the baseline in the same
PR, so a later loss of that gain cannot go unnoticed. Failure subtypes can change
without a baseline edit. The current score artifact is written before reporting
a stale baseline, so a climb PR can fetch and commit the updated result.

CI separately checks nonregression against the target branch's baseline read
with `git show` at the pull request's base SHA. Lowering the candidate baseline
cannot hide a regression. Bootstrap is allowed
only when the target source lock has no scoreboard entry. Later missing baseline
files fail closed. New corpus/oracle/environment identities are incomparable;
recapture and rerun both base and candidate under identical inputs, then review
the baseline migration explicitly. Editing the identity alone is insufficient.

Capture and initial baseline recording are explicit maintenance operations, not
part of compatibility CI:

```sh
# Requires bubblewrap, Python 3, GNU bash 5.3.15 and pinned corpus sources.
# BASH_COMPAT_BRUSH_DIR and BASH_COMPAT_BASHKIT_DIR may select existing caches.
BASH_COMPAT_MODE=capture BASH_COMPAT_BASH=/usr/bin/bash npm run compat

# After reviewing the oracle and pinning its SHA-256 in sources.lock.json:
BASH_COMPAT_RECORD=1 BASH_COMPAT_OUT=docs/evidence/own-shell-baseline.json npm run compat:shell
```

Run builds, native/WASI tests and corpus captures through this host's heavy queue.
`BASH_COMPAT_SCRATCH` selects the scratch parent, defaulting to `/work/tmp` locally
and `RUNNER_TEMP` in Actions. Each run owns a `brush-web-compat-*` directory and
removes it, workers and child groups on completion or interruption. Keep requested
result files outside that scratch directory and remove disposable result files
after review. Frozen replay neither prepares corpora nor invokes GNU bash, probes
external commands, runs mapfile sweeps or downloads other engines. Live ad hoc
comparisons still use `BASH_COMPAT_ENGINES` and `BASH_COMPAT_CORPORA`; unselected
engines and Oils are not prepared.
