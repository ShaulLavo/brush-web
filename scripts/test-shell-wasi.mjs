// Exercise the same engine/stand-in tests on WASI, then size the core embedding.
// The browser process service is deliberately not substituted by this harness.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const cargo = (args, options = {}) =>
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", ...options });
const manifest = ["--locked", "--manifest-path", "shell/Cargo.toml"];
const env = {
  ...process.env,
  CARGO_TARGET_WASM32_WASIP1_RUNNER:
    process.env.CARGO_TARGET_WASM32_WASIP1_RUNNER || "wasmtime run",
};
cargo(
  [
    "test",
    ...manifest,
    "--target",
    "wasm32-wasip1",
    "-p",
    "shell-engine",
    "--lib",
    "--test",
    "streaming",
    "-j2",
    "--",
    "--test-threads=1",
  ],
  { env },
);
cargo([
  "build",
  ...manifest,
  "--target",
  "wasm32-wasip1",
  "-p",
  "shell-engine",
  "--release",
  "-j2",
]);
const metadata = JSON.parse(
  cargo(["metadata", ...manifest, "--format-version", "1", "--no-deps"], {
    stdio: "pipe",
    encoding: "utf8",
  }),
);
const wasm = resolve(metadata.target_directory, "wasm32-wasip1/release/shell-engine.wasm");
const output = execFileSync(
  "wasmtime",
  ["run", wasm, "-c", 'false | true; printf \'STATUS:%s:%s\\n\' "$?" "${PIPESTATUS[*]}"'],
  { encoding: "utf8" },
);
assert.equal(output, "STATUS:0:1 0\n");
const bytes = readFileSync(wasm);
const compressed = brotliCompressSync(bytes, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
console.log(
  `Shell core release WASI: ${bytes.length} bytes raw; ${compressed.length} bytes brotli-11`,
);
assert.ok(compressed.length <= 1_000_000, "shell core exceeds Brush's 1.0 MB brotli guardrail");
