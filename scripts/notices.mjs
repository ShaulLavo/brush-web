import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
const root = resolve(import.meta.dirname, "..");
let output =
  "# Third-party notices\n\nBrush source: 4cfba081f2f8bcda8150010a57203d020f14f0cc, patched locally. Terminal mirror: cf0d1a0e75f61e47732648d6fba32645a4fc8de7. Ghostty WASM provenance: 7b11f3dca034d8d24369ad3856afe57946d7902a. The original terminal notice below retains its historical revision text.\n";
async function include(label, directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const licenses = names.filter((name) => /^(license|copying|notice)(\.|-|$)/i.test(name)).sort();
  for (const name of licenses) {
    const text = await readFile(resolve(directory, name), "utf8").catch(() => undefined);
    if (text) output += `\n\n## ${label} / ${name}\n\n${text}\n`;
  }
}
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      "rust/brush-browser/Cargo.toml",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ),
);
for (const pkg of metadata.packages.sort((a, b) => a.name.localeCompare(b.name)))
  await include(`${pkg.name} ${pkg.version}`, dirname(pkg.manifest_path));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev) continue;
  await include(`${path.split("node_modules/").at(-1)} ${pkg.version}`, resolve(root, path));
}
await include("ghostty-webgpu 0.3.24", resolve(root, ".sources/ghostty-webgpu"));
for (const name of await readdir(resolve(root, "third-party/bashkit")))
  output += `\n\n## Bashkit 0.18.2 / ${name}\n\n${await readFile(resolve(root, "third-party/bashkit", name), "utf8")}\n`;
output +=
  "\n\n" +
  (await readFile(resolve(root, ".sources/ghostty-webgpu/THIRD_PARTY_NOTICES.md"), "utf8"));
await writeFile(resolve(root, "public/THIRD_PARTY_NOTICES.txt"), output);
