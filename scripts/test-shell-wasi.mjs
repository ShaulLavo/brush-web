// Exercise the same engine/stand-in tests on WASI, then size the core embedding.
// The browser process service is deliberately not substituted by this harness.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const cargoEnv = {
  ...process.env,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? resolve(root, ".build/shell"),
};
const cargo = (args, options = {}) =>
  execFileSync("cargo", args, { cwd: root, stdio: "inherit", env: cargoEnv, ...options });
const manifest = ["--locked", "--manifest-path", "shell/Cargo.toml"];
const env = {
  ...cargoEnv,
  CARGO_TARGET_WASM32_WASIP1_RUNNER:
    process.env.CARGO_TARGET_WASM32_WASIP1_RUNNER || "wasmtime run",
};
cargo(
  ["test"].concat(manifest, [
    "--target",
    "wasm32-wasip1",
    "-p",
    "shell-engine",
    "--lib",
    "--test",
    "streaming",
    "--test",
    "words",
    "-j2",
    "--",
    "--test-threads=1",
  ]),
  { env },
);
cargo(
  ["build"].concat(manifest, [
    "--target",
    "wasm32-wasip1",
    "-p",
    "shell-engine",
    "--release",
    "-j2",
  ]),
);
const metadata = JSON.parse(
  cargo(["metadata"].concat(manifest, ["--format-version", "1", "--no-deps"]), {
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
const invoke = (script) => {
  const result = spawnSync("wasmtime", ["run", wasm, "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
};
const separate = invoke("printf out; printf err >&2; exit 7");
assert.equal(separate.status, 7);
assert.equal(separate.stdout.toString(), "out");
assert.equal(separate.stderr.toString(), "err");
const longErrors = invoke("seq 20000 >&2; printf done; exit 7");
assert.equal(longErrors.status, 7);
assert.equal(longErrors.stdout.toString(), "done");
assert.ok(longErrors.stderr.toString().endsWith("20000\n"));
const helpers = execFileSync(
  "wasmtime",
  ["run", "--env", "HOME=/home/fixture", wasm, "-c", "argv.py a 'b c'; printenv.py HOME MISSING"],
  { encoding: "utf8" },
);
assert.equal(helpers, "['a', 'b c']\n/home/fixture\nNone\n");
const bytes = readFileSync(wasm);
const compressed = brotliCompressSync(bytes, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
console.log(
  `Shell core release WASI: ${bytes.length} bytes raw; ${compressed.length} bytes brotli-11`,
);
assert.ok(compressed.length <= 1_000_000, "shell core exceeds Brush's 1.0 MB brotli guardrail");
