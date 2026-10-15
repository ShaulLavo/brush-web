# 003: Make the Bashkit vi browser test reliable

Status: Approved, scheduled follow-up under the repository's standing rule to record unrelated work.

## Observed failure

On 2026-10-15, [the push CI run](https://github.com/ShaulLavo/brush-web/actions/runs/38802325477) failed `tests/bashkit-terminal.spec.ts:94`, `native vi uses alternate screen, resizes and saves a VFS file`. The assertion at line 102 waited for `hello from vi` after saving and reading `/tmp/note`.

```text
Expected value: "hello from vi"
Received array: ["$ vi /tmp/note", "$ cat /tmp/note", "", "", "", "", "", "", "", "", …]
Timeout 5000ms exceeded while waiting on the predicate
55 passed (57.3s)
```

[The pull-request CI run](https://github.com/ShaulLavo/brush-web/actions/runs/38802334397) passed all 56 tests on the same head, `bc48e89a92620f318468aec6c06b0d7f20b211bc`. Both runs passed all 18 external-command tests. Both runs on the preceding code commit, `ebce347f4e17353cecc5a804f5d000f26107f1e3`, also passed. The observed rate is one failure in four full runs, not a measured failure probability.

The failing test and Bashkit implementation are unchanged by the bun-wasm re-pin. `git merge-base --is-ancestor origin/main repin-bun` passed against main `2e97365`, ruling out a stale base for this failure. The bun-wasm executable is used by Brush external commands, while this test selects the independent `bashkit-terminal` engine.

## Reproduce and investigate

Use an exclusive worktree and the fixture-only browser surface. Install dependencies, build, and repeat the focused test through the machine's resource wrapper. Export the toolchain and browser cache paths first.

```sh
export PATH=$HOME/.local/share/mise/shims:/work/cache/cargo/bin:$PATH
export CARGO_HOME=/work/cache/cargo
export RUSTUP_HOME=/work/cache/rustup
export PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright
npm ci
bash /work/tmp/wave-heavy/run.sh --class build "bashkit vi build" -- env PATH="$PATH" npm run build
bash /work/tmp/wave-heavy/run.sh --class browser "bashkit vi repeat" -- env PATH="$PATH" npx playwright test tests/bashkit-terminal.spec.ts --grep 'native vi uses alternate screen' --repeat-each=25
```

The test sends `vi /tmp/note`, immediately sends `ihello from vi`, resizes, sends Escape and `:wq`, then immediately sends `cat /tmp/note`. It does not observe editor entry or exit between those inputs. This is an investigation lead, not a confirmed cause. Capture input delivery, worker progress, terminal output, and resize timing to distinguish a test synchronization error from lost application input. Preserve the failing screenshot and trace. No timing workaround or source fix was attempted in the re-pin task.

Fix the confirmed cause and prove the original sequence fails before the fix and passes afterward. Run the focused repetition and `npm run verify`. Each run owns its browser, server, temporary files, and teardown. Remove them before reporting completion.
