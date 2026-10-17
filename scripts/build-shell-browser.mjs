import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = {
  ...process.env,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? "/work/tmp/brush-web-runtime-target",
};
// CI has no /work mount. Its explicit CARGO_TARGET_DIR keeps the same cache as
// the other Rust jobs; local callers use the task-owned data-volume target.
if (process.env.CI && !process.env.CARGO_TARGET_DIR)
  env.CARGO_TARGET_DIR = resolve(root, ".build/shell");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    "shell/Cargo.toml",
    "--target",
    "wasm32-wasip1",
    "--release",
    "-p",
    "shell-engine",
    "--bin",
    "shell-runtime",
    "-j2",
  ],
  { cwd: root, env, stdio: "inherit" },
);
const directory = resolve(root, "public/programs");
await mkdir(directory, { recursive: true });
await copyFile(
  resolve(env.CARGO_TARGET_DIR, "wasm32-wasip1/release/shell-runtime.wasm"),
  resolve(directory, "shell-engine.wasm"),
);
