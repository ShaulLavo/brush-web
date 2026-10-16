import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Read the target branch's baseline, never a path chosen by the candidate's pin.
export function baseBranchBaseline(root, ref) {
  if (!ref) return null;
  assert.match(ref, /^[a-f0-9]{40}$/, "BASH_COMPAT_BASE_REF must be a full commit SHA");
  const fromGit = (path) =>
    JSON.parse(
      execFileSync("git", ["show", `${ref}:${path}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const pins = fromGit("sources.lock.json");
  if (!pins.shellScoreboard) return null; // First baseline only. Later omissions fail closed.
  return fromGit("docs/evidence/own-shell-baseline.json");
}
