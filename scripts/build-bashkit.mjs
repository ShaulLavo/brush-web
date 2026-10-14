import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, cp, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const pin = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")).bashkitTerminal;
const source = resolve(root, ".sources/bashkit");
const output = resolve(source, "pkg");
const marker = resolve(source, ".revision");
const built = resolve(output, ".build-pin");
const buildPin = JSON.stringify(pin);
const read = (path) => readFile(path, "utf8").catch(() => "");
if ((await read(marker)) !== pin.revision) {
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  const archive = resolve(root, ".scratch/bashkit-source.tar.gz");
  try {
    const response = await fetch(
      `https://codeload.github.com/everruns/bashkit/tar.gz/${pin.revision}`,
    );
    if (!response.ok) throw new Error(`Bashkit source fetch failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== pin.archiveSha256)
      throw new Error("Bashkit source checksum mismatch");
    await writeFile(archive, bytes);
    await rm(source, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    await writeFile(marker, pin.revision);
  } finally {
    await rm(archive, { force: true });
  }
}
if ((await read(built)) === buildPin) process.exit(0);
const env = { ...process.env, CARGO_TARGET_DIR: resolve(root, ".build/bashkit") };
execFileSync(
  "rustup",
  ["toolchain", "install", pin.rust, "--profile", "minimal", "--target", "wasm32-unknown-unknown"],
  { env, stdio: "inherit" },
);
const cliRoot = resolve(root, ".build/wasm-bindgen");
const cli = resolve(cliRoot, "bin/wasm-bindgen");
let version;
try {
  version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
} catch {}
if (version !== `wasm-bindgen ${pin.wasmBindgen}`)
  execFileSync(
    "cargo",
    [
      `+${pin.rust}`,
      "install",
      "wasm-bindgen-cli",
      "--version",
      pin.wasmBindgen,
      "--locked",
      "--root",
      cliRoot,
    ],
    { cwd: root, env, stdio: "inherit" },
  );
const artifacts = execFileSync(
  "cargo",
  [
    `+${pin.rust}`,
    "build",
    "--locked",
    "-p",
    "bashkit-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--features",
    "terminal",
    "--message-format=json",
  ],
  {
    cwd: source,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  },
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
execFileSync(
  cli,
  [
    resolve(env.CARGO_TARGET_DIR, "wasm32-unknown-unknown/release/bashkit_wasm.wasm"),
    "--target",
    "web",
    "--out-dir",
    output,
    "--out-name",
    "bashkit_wasm",
    "--omit-default-module-path",
  ],
  { env, stdio: "inherit" },
);
for (const name of ["index.js", "index.d.ts"])
  await cp(resolve(source, "crates/bashkit-wasm/js", name), resolve(output, name));
await writeFile(resolve(output, "package.json"), '{"type":"module"}\n');
const manifests = new Set();
for (const line of artifacts.trim().split("\n")) {
  const message = JSON.parse(line);
  if (message.reason === "compiler-artifact") manifests.add(message.manifest_path);
}
let notices =
  `Bashkit Terminal ${pin.revision}. Built with Rust ${pin.rust}, wasm-bindgen ${pin.wasmBindgen}, terminal feature, no wasm-opt.\n` +
  (await licenses(source));
for (const manifest of manifests) notices += await licenses(dirname(manifest));
await writeFile(resolve(output, "THIRD_PARTY_NOTICES.txt"), notices);
await cp(resolve(source, "crates/bashkit-wasm/__test__"), resolve(source, "__test__"), {
  recursive: true,
});
await writeFile(built, buildPin);
process.stdout.write(
  `Bashkit Terminal built from ${pin.revision}: ${(await readdir(output)).join(", ")}\n`,
);

async function licenses(directory) {
  const names = (await readdir(directory))
    .filter((name) => /^(license|copying|notice)(\.|-|$)/i.test(name))
    .sort();
  let text = "";
  for (const name of names) {
    const content = await readFile(resolve(directory, name), "utf8").catch(() => undefined);
    if (content) text += `\n## ${directory.split("/").at(-1)} / ${name}\n\n${content}\n`;
  }
  return text;
}
