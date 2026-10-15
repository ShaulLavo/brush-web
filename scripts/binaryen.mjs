import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const platforms = {
  "linux-x64": "x86_64-linux",
  "linux-arm64": "aarch64-linux",
  "darwin-arm64": "arm64-macos",
  "darwin-x64": "x86_64-macos",
};

// Returns the pinned wasm-opt, downloading it once into .build/binaryen/<version>/.
export async function wasmOpt() {
  const pin = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8")).binaryen;
  const name = platforms[`${platform()}-${arch()}`];
  if (!name) throw new Error(`No pinned binaryen archive for ${platform()}-${arch()}`);
  const directory = resolve(root, ".build/binaryen", pin.version);
  const binary = resolve(directory, "bin/wasm-opt");
  const marker = resolve(directory, ".archive-sha256");
  const expected = pin.archiveSha256[name];
  if ((await readFile(marker, "utf8").catch(() => "")) === expected) {
    await access(binary);
    return { binary, flags: pin.flags, version: pin.version };
  }
  const prefix = `binaryen-version_${pin.version}`;
  const response = await fetch(
    `${pin.repository}/releases/download/version_${pin.version}/${prefix}-${name}.tar.gz`,
  );
  if (!response.ok) throw new Error(`binaryen download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("binaryen archive checksum mismatch");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const archive = resolve(directory, "binaryen.tar.gz");
  try {
    await writeFile(archive, bytes);
    // Linux wasm-opt is static; the macOS build links lib/libbinaryen.dylib.
    const members = [`${prefix}/bin/wasm-opt`].concat(
      platform() === "darwin" ? [`${prefix}/lib/libbinaryen.dylib`] : [],
    );
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory].concat(members));
  } finally {
    await rm(archive, { force: true });
  }
  await writeFile(marker, expected);
  return { binary, flags: pin.flags, version: pin.version };
}
