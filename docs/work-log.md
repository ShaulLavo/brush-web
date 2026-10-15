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

Verification: production-browser suite passed 18 cases; patched VT passed 112 cases; native printf and read cases and utility tests passed. Headed Chromium used the NVIDIA Ampere adapter with WebGPU and screenshots were inspected. Private disposable demo created and tested; failed first app allocation auto-deleted with cleanup complete. All test/measurement browsers and temporary servers stopped.

Fresh detached worktree: npm ci, public terminal source download/checksum, pristine Brush submodule patch application, locked WASI build, and production build passed. Root production suite passes 18 browser fixtures including wrapped prompt resizing and canonical joined-emoji deletion. Initial GitHub CI passed both push and PR workflows.

Preview updates must repeat the server command and port; omitting them changes the app to static mode and loses isolation headers. The same demo was restored and browser execution retested. Canonical input width now comes from the pinned Rust width table, with copyright/heart and joined-emoji regression checks.

Comparison completed by the agent: actual builtin/utility inventories and unsupported-name probes, plus four shared browser workloads with verified results over five warm trials per engine. All benchmark resources were removed, and raw results remain in docs/evidence.

Native Bashkit comparison owns its repository-local `.sources/bashkit`, `.build/bashkit`, and `.build/wasm-bindgen` build inputs. The first attempted 1.5 GiB build exceeded that slot's memory ceiling; the normal build slot succeeded with upstream's unchanged release profile. Its temporary target was moved into the repository build directory, leaving no target under `/work/tmp`. Existing reference source, host services, browser caches, and the existing demo route are preserved. Browser runs own their temporary server ports and contexts; any Mac run must remove its transferred bundle and profile after retaining small evidence.

Native evaluation completed with 37 browser tests on the Mac and all 47 upstream package tests. Hardware WebGPU screenshots were inspected. The workload matrices retain 960 verified samples with identical frame/immediate asset hashes; the same-module control retains 120 samples. A failed first collection lost the first immediate-mode file, so that mode was rerun with identical asset hashes. The final merged Ghostty timing API was then checked separately with 40 echo turns and ordered input/output/drawn/presented timestamps. Its source pin is separate from the earlier workload evidence.

Mac consumers stopped and all three task snapshots, transferred packages, npm caches and browser profiles were removed. Ports 4197, 4198, 4204, 4207 and 4208 had no task listeners at cleanup. Cancelled local build-queue entries were removed. Retained repository build inputs are about 101 MiB of pinned Bashkit source/package, 367 MiB of Rust target data, and 32 MiB of wasm-bindgen tooling; they serve future builds and may be removed with the project's ignored build inputs. Existing shared caches and services were preserved.

Bash compatibility (`npm run compat`): Oils spec corpus pinned in `sources.lock.json`, real bash 5.3.15 as oracle, plus Brush's and Bashkit's own suites as held-out checks. Results and the Bashkit mapfile root cause are in [bash-compatibility.md](bash-compatibility.md). The run owns a `.scratch/bash-compat-*` directory and its worker threads and removes both. Retained ignored build inputs: `.sources/oils` (spec files, 1.6 MiB) and `.build/brush-native` (native reference build, 581 MiB; remove with the other ignored build inputs).

Cold-start measurement: 300 checked trials (6 engine variants × 5 network/CPU conditions × 10, each one cold and two repeat visits) on fresh Chromium profiles behind a brotli/gzip caching server. Brotli sizes, phase marks and raw samples are in `docs/evidence/cold-start*.json`; conclusions are in `docs/cold-start.md`. DevTools CPU throttling does not reach workers, so a whole-browser cgroup condition was added. Profiles live on tmpfs because cache writes to the VDO volume limited downloads. The run owned its server, browsers, cgroup scopes and profiles; none remained afterwards. Retained build caches: `.build/binaryen/125` (19 MB, pinned wasm-opt) and `.build/cold-start` (35 MB of compressed and optimized copies), both removable with the ignored build directory.

Plan 001 step 1 adds registered WASI child commands, starting with pinned QuickJS bun.wasm. Browser acceptance checks and spawn measurements are documented in [external-commands.md](external-commands.md).
