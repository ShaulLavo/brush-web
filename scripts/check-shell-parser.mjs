import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { shellParser: pin } = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
assert.equal(pin.repository, "https://github.com/everruns/bashkit");
assert.equal(
  pin.revision,
  "491c3281f668b76d64b15210b8f5d7bf97244be0",
  "Keep the parser base revision recorded",
);
assert.ok(Array.isArray(pin.changeLog) && pin.changeLog.length > 0, "Record local parser changes");
for (const entry of pin.changeLog) {
  assert.ok(Array.isArray(entry.paths) && entry.paths.length > 0, "Name the changed paths");
  for (const path of entry.paths) assert.ok(typeof path === "string" && path.length > 0);
  assert.ok(typeof entry.change === "string" && entry.change.length > 0, "Describe each change");
  assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, "Explain each change");
}
assert.ok(Array.isArray(pin.removedUpstreamTests), "Record deliberate upstream test removals");
for (const entry of pin.removedUpstreamTests) {
  assert.ok(typeof entry.name === "string" && entry.name.length > 0, "Name the removed test");
  assert.ok(
    typeof entry.reason === "string" && entry.reason.length > 0,
    "Explain the behavior change",
  );
}
const license = await readFile(resolve(root, pin.directory, "LICENSE"));
assert.equal(createHash("sha256").update(license).digest("hex"), pin.licenseSha256);
console.log(
  `Owned parser: Bashkit base ${pin.revision}; ${pin.changeLog.length} recorded changes; ${pin.removedUpstreamTests.length} deliberate test removals`,
);
