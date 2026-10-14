import { execFileSync } from "node:child_process";
import { mkdir, readdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
for (const file of (await readdir(resolve(root, "patches")))
  .filter((file) => file.endsWith(".patch"))
  .sort()) {
  const patch = resolve(root, "patches", file);
  const options = { cwd: resolve(root, "vendor/brush"), stdio: "pipe" };
  try {
    execFileSync("git", ["apply", "--reverse", "--check", patch], options);
  } catch {
    execFileSync("git", ["apply", "--check", patch], options);
    execFileSync("git", ["apply", patch], options);
  }
}
const env = { ...process.env, CARGO_TARGET_DIR: resolve(root, ".build/rust") };
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip1",
    "--manifest-path",
    "rust/brush-browser/Cargo.toml",
  ],
  { cwd: root, env, stdio: "inherit" },
);
await mkdir(resolve(root, "public/brush"), { recursive: true });
await copyFile(
  resolve(root, ".build/rust/wasm32-wasip1/release/brush-browser.wasm"),
  resolve(root, "public/brush/brush-browser.wasm"),
);
