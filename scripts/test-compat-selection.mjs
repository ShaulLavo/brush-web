import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("unknown engines fail before source downloads or builds", () => {
  const result = spawnSync(process.execPath, ["scripts/bash-compat.mjs"], {
    encoding: "utf8",
    env: { ...process.env, BASH_COMPAT_MODE: "live", BASH_COMPAT_ENGINES: "typo" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown compatibility engines/);
  assert.doesNotMatch(result.stderr, /downloading|building/);
});

test("a selected non-Oils corpus never prepares Oils or Brush", () => {
  const result = spawnSync(process.execPath, ["scripts/bash-compat.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      BASH_COMPAT_MODE: "live",
      BASH_COMPAT_ENGINES: "own-shell",
      BASH_COMPAT_SKIP_BUILD: "1",
      BASH_COMPAT_CORPORA: "brush-suite",
      BASH_COMPAT_BRUSH_DIR: "/does-not-exist",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does-not-exist/);
  assert.doesNotMatch(result.stderr, /downloading|building/);
});
