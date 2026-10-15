# 002: Resolve dependency audit findings

Status: Approved, scheduled follow-up under the repository's standing rule to record unrelated work.

## Evidence

On 2026-10-15, `npm ci` and `npm audit --json` reported five findings on the existing dependency graph. This feature changes only package version numbers in the lock file. The affected versions are also present on base commit `ef6c882`.

Run these commands from an exclusive worktree:

```sh
npm ci
npm audit --json
npm ls esbuild just-bash guarded-fetch sprintf-js undici --all
```

The audit reports one high, three moderate, and one low finding. The installed paths are:

- `esbuild@0.27.7`, direct dev dependency and shared by Remix's tests and Vite. The Windows dev-server file-read advisory is [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr). The audit offers 0.28.2, which exceeds a patch update from 0.27.7. The current Linux static server does not use esbuild's development server.
- `just-bash@3.6.0` depends on `guarded-fetch@0.1.3`, which depends on `undici@7.29.0`. The high finding aggregates ten Undici HTTP and WebSocket advisories, including [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) and [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3). npm reports no automatic fix for this dependency path. Browser reachability was not assessed.
- `just-bash@3.6.0` also depends on `sprintf-js@1.1.3`. [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) reports unbounded precision specifiers. npm reports no automatic fix. The separate moderate entries on just-bash and guarded-fetch reflect their affected dependencies.

The corresponding entries start at `package-lock.json:3714`, `:3881`, `:4008`, `:5126`, and `:5356` on the feature branch. No dependency upgrade or override was attempted during external-command implementation.

## Execute

Check current upstream patch releases and the advisory ranges. Trace whether the browser bundle includes the affected networking implementation. Prefer supported patch releases. If an override is necessary, exercise the just-bash adapter and Remix/Vite build against that graph before keeping it. Preserve exact dependency pins and rerun `npm run verify`. Record any remaining audit finding with its actual runtime reachability and an explicit resolution condition.
