import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const pin = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")).bunWasm;
const output = resolve(root, "public/programs/bun.wasm");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runtimePatch = await readFile(resolve(root, pin.runtimePatch));
if (hash(runtimePatch) !== pin.runtimePatchSha256)
  throw new Error("Bun runtime patch checksum mismatch");
let existing;
try {
  existing = await readFile(output);
} catch {}
if (existing && hash(existing) === pin.wasmSha256) process.exit(0);
let bytes;
if (process.env.BUN_WASM) bytes = await readFile(process.env.BUN_WASM);
else {
  const compressed = await readFile(resolve(root, pin.sourceArtifact));
  if (hash(compressed) !== pin.sourceArtifactSha256)
    throw new Error("Compressed Bun WASM checksum mismatch");
  bytes = gunzipSync(compressed, { maxOutputLength: pin.wasmBytes });
}
if (hash(bytes) !== pin.wasmSha256)
  throw new Error(
    `Bun WASM checksum mismatch. Build bun-wasm at ${pin.revision} with ${pin.runtimePatch} and set BUN_WASM to dist/bun.wasm. See docs/external-commands.md.`,
  );
await mkdir(resolve(root, "public/programs"), { recursive: true });
await writeFile(output, bytes);
process.stdout.write(`Bun WASM verified: ${bytes.length} bytes\n`);
