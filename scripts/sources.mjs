import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const pins = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
const destination = resolve(root, ".sources/ghostty-webgpu");
const marker = resolve(destination, ".revision");
let revision;
try {
  revision = (await readFile(marker, "utf8")).trim();
} catch {}
if (revision !== pins.terminal.revision) {
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  const archive = resolve(root, ".scratch/terminal.tar.gz");
  const response = await fetch(
    `https://codeload.github.com/ShaulLavo/ghostty-webgpu/tar.gz/${pins.terminal.revision}`,
  );
  if (!response.ok) throw new Error(`Terminal source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pins.terminal.archiveSha256)
    throw new Error("Terminal source archive checksum mismatch");
  await writeFile(archive, bytes);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const prefix = `ghostty-webgpu-${pins.terminal.revision}/`;
  const files = [
    "src",
    "ghostty-vt.wasm",
    "bridge.wasm",
    "canvas-compose.wasm",
    "ghostty-vt.provenance.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "docs",
  ];
  execFileSync(
    "tar",
    ["-xzf", archive, "--strip-components=1", "-C", destination].concat(
      files.map((file) => prefix + file),
    ),
  );
  await writeFile(marker, pins.terminal.revision);
  await rm(archive);
}
execFileSync("git", ["submodule", "update", "--init", "--depth", "1", "vendor/brush"], {
  cwd: root,
  stdio: "inherit",
});
const brushHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: resolve(root, "vendor/brush"),
  encoding: "utf8",
}).trim();
if (brushHead !== pins.brush.revision)
  throw new Error("Brush submodule revision differs from source lock");
