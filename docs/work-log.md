# Execution record

Status: Approved

- [x] Inspect source revisions and terminal byte API.
- [ ] Trace Brush terminal, filesystem, process and cancellation paths.
- [ ] Build a real WASM shell and bounded worker I/O.
- [ ] Connect the Remix 3 workbench and Ghostty terminal.
- [ ] Exercise browser interaction, interruption and recovery.
- [ ] Add the just-bash baseline and measured comparison.
- [ ] Document limits, run fresh-checkout checks, merge the implementation.

Test resource ownership: this task creates repository-local build artifacts, source downloads, a static dev server, and temporary Playwright contexts. Test scripts must close their own browsers and servers in finally blocks. Existing host services and browser caches remain untouched. Generated outputs are ignored. Captured small evidence remains under docs/evidence.
