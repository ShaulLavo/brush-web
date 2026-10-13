# Commands and measured workloads

Brush already provides a substantial shell language and native builtin set. The browser host adds a small utility set. just-bash provides more ready-made text and file tools, but the browser adapter enables only part of its catalog. Neither demo runs native executables.

## Name inventories are different from command support

The inventory comes from commands typed into the browser terminal, plus the configured source lists and the installed package's public catalog API. The [raw evidence](evidence/command-benchmarks.json) includes the actual names, help output, statuses, source pins, and artifact hashes.

| Inventory | Names | Meaning |
| --- | ---: | --- |
| Brush runtime `compgen -b` | 67 | Registered builtins, including the browser utilities |
| Brush native builtins | 56 | Runtime inventory after subtracting the 11 browser utility names |
| Brush browser utilities | 11 | `browser-help`, `cat`, `clear`, `keydemo`, `ls`, `mkdir`, `rm`, `seq`, `sleep`, `touch`, `uname` |
| just-bash `compgen -A builtin` | 61 | Names advertised by its interpreter completion table |
| just-bash adapter commands | 45 | Package command implementations enabled by `src/baseline.ts` |
| Installed just-bash browser catalog | 81 | Names returned by `getCommandNames()` in the published browser entry |

These counts overlap. Nine enabled just-bash package names also appear in its builtin completion table, including `echo`, `printf`, and `pwd`. The package catalog includes commands this adapter disables, and excludes opt-in Python, JavaScript, and network commands.

Completion and help lists overstate functional coverage in some places. just-bash advertises `bg`, `fg`, `kill`, `umask`, and `ulimit`, but each tested invocation returned status 127 and "command not found". Its `compgen -b` returned status 0 with no names; `compgen -A builtin` produced the actual completion inventory. Brush registers `bg` and `fg`, but this single-worker runtime explicitly rejects background execution and has no native job control. Grammar keywords such as `for`, `if`, and `while` are recorded separately from command names.

## What the command sets provide

| Operation | Brush demo | just-bash baseline |
| --- | --- | --- |
| Shell language | Native Brush variables, functions, aliases, arrays, tests, loops, redirection, substitution, and completion | Interpreter equivalents within one submitted script |
| Shell state | cwd, exports, functions, aliases, history, and status persist | Public `exec()` resets shell state after each submission; files persist |
| Basic files | `cat`, `ls`, `mkdir -p`, `touch`, `rm`, plus shell redirection | Those commands, plus enabled `cp`, `mv`, `rmdir`, `find`, `basename`, and `dirname` |
| Copy a file | `cat source > copy` | `cp source copy` and redirection |
| Listing options | `ls -l` fails with an explicit unsupported-option error | `ls -l` succeeded in the browser probe |
| Text tools | Native `echo` and `printf`, the host's `cat`, and shell loops | Enabled `grep`, `sed`, `awk`, `sort`, `uniq`, `tr`, `head`, `tail`, `wc`, and `tee` |
| Sequence and delay | Browser Rust `seq` and interruptible `sleep` | Package `seq` and `sleep` |
| Interactive terminal command | `keydemo` reads live keys and resize events | Public `exec()` has completed output and fixed stdin; no matching key demo |
| Native programs and packages | Unsupported | Outside this adapter's command set |

Browser probes confirmed `cp welcome.txt inventory-copy` and `grep Files welcome.txt` succeed in just-bash and return 127 in Brush. The listed enabled tools describe the configured command set; this spike does not certify every option of every command. Brush's utility options are deliberately small and documented by `browser-help`.

## Four common workloads

The same scripts run through Ghostty keyboard input on both engines. Each workload has one untimed warmup and five timed trials. Each submitted script initializes its own variables and overwrites its own files. Completion requires a standalone status marker in Ghostty's submitted viewport, status 0, and verified output from that trial.

| Workload | Verification |
| --- | --- |
| Arithmetic loop, 2,000 iterations | The computed sum is `1999000` |
| 5,000 lines through a file and `cat` pipeline into a copy | `mapfile` reports 5,000 lines, first line `1`, and last line `5000` |
| 100 command substitutions | The computed sum is `5050` |
| `seq 10000` into the terminal | The final numeric lines are `9999` and `10000` |

The file workload includes its array load and content checks in the timing. For long terminal output, bounded history can evict the start marker; verification then checks the final rows immediately before that trial's end marker. Prior trials cannot satisfy the output checks.

Recorded on 2026-10-13 with Chromium 152.0.7977.82, Linux 7.2.8, and an Intel Core i7-14700K. These runs explicitly used headless Ghostty Canvas2D. They provide no hardware WebGPU timing evidence. Times below are milliseconds.

| Workload | Brush median / p95 | just-bash median / p95 |
| --- | ---: | ---: |
| Arithmetic loop | 46.8 / 47.3 | 47.4 / 47.8 |
| Files and pipeline | 80.3 / 80.6 | 47.1 / 47.7 |
| Command substitutions | 46.8 / 47.1 | 46.7 / 47.7 |
| 10,000 terminal lines | 63.2 / 65.3 | 48.8 / 51.3 |

With five trials, the nearest-rank p95 is the slowest sample. That is a small sample, not a reliable tail-latency estimate. The arithmetic and substitution results cluster around the browser transport and polling floor near 47 ms. They cannot rank the interpreters' CPU execution speed.

The file workload was faster in this just-bash run. The terminal-output workload also includes different utility and output adapters: Brush's Rust utility writes and flushes incrementally, while just-bash collects its output and returns it as a completed string. That result does not measure native Rust versus JavaScript execution speed. Brush's visible streaming advantage remains a separate behavior, measured in [the startup and streaming comparison](comparison.md).

Timings include Enter delivery, worker transport, terminal rendering, and browser polling. They exclude physical display presentation. Brush ran first, and driver and operating-system caches were already warm. A frozen copy of the built demo served every trial, so another build could not change the artifacts during a run.

Run `npm run build`, then `node scripts/compare-commands.mjs`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only when using a system Chromium instead of Playwright's installed browser. The script owns port 4196 by default, its browser, and a temporary artifact snapshot, and removes them in `finally`. `BRUSH_COMPARE_PORT` selects another free loopback port. The raw evidence records verified cleanup.
