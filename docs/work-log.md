# Execution record

Status: Approved

- [x] Inspect source revisions and terminal byte API.
- [x] Trace Brush terminal, filesystem, process and cancellation paths.
- [x] Build a real WASM shell and bounded worker I/O.
- [x] Connect the Remix 3 workbench and Ghostty terminal.
- [x] Exercise browser interaction, interruption and recovery.
- [x] Add the just-bash baseline and measured comparison.
- [ ] Document limits, run fresh-checkout checks, merge the implementation.

Test resource ownership: this task creates repository-local build artifacts, source downloads, a static dev server, and temporary Playwright contexts. Test scripts must close their own browsers and servers in finally blocks. Existing host services and browser caches remain untouched. Generated outputs are ignored. Captured small evidence remains under docs/evidence.

Verification: production-browser suite passed 15 cases; patched VT passed 112 cases; native printf and read cases and utility tests passed. Headed Chromium used the NVIDIA Ampere adapter with WebGPU and screenshots were inspected. Private disposable demo created and tested; failed first app allocation auto-deleted with cleanup complete. All test/measurement browsers and temporary servers stopped.
