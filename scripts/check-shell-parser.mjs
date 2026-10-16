import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { shellParser: pin } = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
const directory = resolve(root, pin.vendoredDirectory);
assert.deepEqual((await readdir(directory)).sort(), Object.keys(pin.filesSha256).sort());
for (const [name, expected] of Object.entries(pin.filesSha256)) {
  const bytes = await readFile(resolve(directory, name));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected,
    `Changed parser: ${name}`,
  );
}
const license = await readFile(resolve(root, pin.directory, "LICENSE"));
assert.equal(createHash("sha256").update(license).digest("hex"), pin.licenseSha256);
console.log(
  `Bashkit parser: ${Object.keys(pin.filesSha256).length} unchanged files at ${pin.revision}`,
);
