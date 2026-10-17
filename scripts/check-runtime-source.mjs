import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pin = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")).bunWasm;
const directory = resolve(root, pin.runtimeDirectory);
const paths = [];
async function collect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await collect(child);
    else if (entry.isFile()) paths.push(child);
    else throw new Error(`Unsupported vendored runtime entry: ${child}`);
  }
}
await collect(directory);
paths.sort();
const digest = createHash("sha256");
for (const path of paths) {
  digest.update(relative(directory, path).split(sep).join("/"));
  digest.update("\0");
  digest.update(await readFile(path));
  digest.update("\0");
}
const actual = digest.digest("hex");
if (actual !== pin.runtimeTreeSha256)
  throw new Error(`Vendored runtime tree differs from ${pin.runtimeRevision}: ${actual}`);
console.log(`Runtime source verified: ${paths.length} files at ${pin.runtimeRevision}`);
