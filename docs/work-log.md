# Execution record

Status: Approved

- [x] Inspect source revisions and terminal byte API.
- [x] Trace Brush terminal, filesystem, process and cancellation paths.
- [x] Build a real WASM shell and bounded worker I/O.
- [x] Connect the Remix 3 workbench and Ghostty terminal.
- [x] Exercise browser interaction, interruption and recovery.
- [x] Add the just-bash baseline and measured comparison.
- [x] Document limits and run fresh-checkout build checks.
- Delivery checks and merge are recorded on [PR #1](https://github.com/ShaulLavo/brush-web/pull/1).

Test resource ownership: this task creates repository-local build artifacts, source downloads, a static dev server, and temporary Playwright contexts. Test scripts must close their own browsers and servers in finally blocks. Existing host services and browser caches remain untouched. Generated outputs are ignored. Captured small evidence remains under docs/evidence.

Verification: production-browser suite passed 17 cases; patched VT passed 112 cases; native printf and read cases and utility tests passed. Headed Chromium used the NVIDIA Ampere adapter with WebGPU and screenshots were inspected. Private disposable demo created and tested; failed first app allocation auto-deleted with cleanup complete. All test/measurement browsers and temporary servers stopped.

Fresh detached worktree: npm ci, public terminal source download/checksum, pristine Brush submodule patch application, locked WASI build, and production build passed. Root production suite passes 17 browser fixtures including wrapped prompt resizing and canonical joined-emoji deletion. Initial GitHub CI passed both push and PR workflows.
