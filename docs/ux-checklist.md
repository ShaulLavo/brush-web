# Manual shell UX checklist

Run the production demo on a current desktop browser. Record browser version, OS, renderer label, GPU adapter, and viewport. Repeat on the owner's Mac and phone before treating this as a complete cross-device acceptance pass.

The automated suite covers actual terminal keyboard input, Home/End, backspace, history, file completion, safe multiline paste, Unicode output, grapheme editing, state retention, stdin, pipes, redirection, stdout/stderr, loop/read/sleep/TUI interruption, resizing, heavy output, EOF, and worker recovery. It uses Chromium's headless Canvas2D path. Synthetic composition events check single commitment through Ghostty. OS-level IME and clipboard workflows require the checks below.

- Click the terminal, move away to a toolbar button, and return. Confirm input focus and selection behave normally.
- Enter `echo editing`; use Left, Right, Home, End, Delete, Backspace, Ctrl+A, and Ctrl+E. Confirm one echo and one cursor.
- Run several commands, press Up/Down, and complete `cat welcome` with Tab. Check completion after changing cwd.
- Enter a multiline `if` or function definition. Navigate within the line. Paste multiple commands with the operating system clipboard and confirm nothing executes until Enter.
- Type Hebrew and CJK using the operating system IME. Composition must remain visible and commit once. Test candidate selection, cancellation, and backspace before and after commitment.
- Edit combining `é`, `世界`, `😀`, `👩‍💻`, and `👍🏽` adjacent to ASCII. Verify left/right movement, deletion, selection, and displayed cursor position.
- Set a long `PS1`, type until it wraps, resize narrower and wider, then continue editing. Also test a line taller than the viewport and repeated Home/End.
- Run `seq 1000000`, resize during output, scroll back, and press Ctrl+C. The page and toolbar must remain responsive and return to the same shell state.
- Run `read answer; echo "$answer"`, type Unicode, erase it, and enter another line. Run `cat`, send EOF, and confirm return to the prompt.
- Test `printf 'out\n'; printf 'err\n' >&2`, `echo hello | cat`, and `printf 'file\n' > note; cat note`.
- Set an export, function, and alias. Interrupt `while :; do :; done` and check `echo "$?"` is 130. Confirm the definitions and cwd remain available.
- Run `keydemo`, press arrows and Unicode keys, and resize. Leave with `q` and then Ctrl+C on a second run. Check alternate-screen and cursor restoration.
- Press Ctrl+C and immediately type another command. The next command must survive input cleanup.
- Press Ctrl+D at an empty prompt. Restart, then switch engines. Check focus, status, and the just-bash session disclosure.
- On `?test=1`, trigger `window.brushWeb.crash()` and use Restart. This deliberately terminates the worker to verify emergency recovery.

`keydemo` proves only this byte, resize, and mode bridge. It does not establish compatibility with arbitrary native TUIs. The canonical command input driver provides basic line input; mode-dependent `read` flags fail explicitly. Cancellation of a single expensive parse or regular expression remains bounded by that operation's own completion.

## Native Bashkit candidate

Select **Bashkit native terminal** to exercise the source API. Check history, cursor keys, Home/End, deletion, `read -p 'Name? ' NAME`, Unicode input, and `vi /tmp/note` while resizing. Exports, functions, aliases, arrays, cwd and exit status should carry between submissions. Interrupt `sleep 30` and verify a usable prompt and status 130. EOF and Restart should close and recover the session.

Tab completion is unavailable. The workbench rejects multiline clipboard paste; upstream raw bracketed paste can execute a line immediately. Tight CPU loops delay Ctrl+C delivery. Repeated large `mapfile` operations have a confirmed silent empty-array bug at the configured memory limit. These remain candidate limitations, not passing acceptance claims. `vi` coverage does not imply support for arbitrary native TUIs.
