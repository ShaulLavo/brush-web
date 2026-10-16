import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
const root = resolve(import.meta.dirname, "..");
const pins = JSON.parse(await readFile(resolve(root, "sources.lock.json"), "utf8"));
let output = `# Third-party notices\n\nBrush source: ${pins.brush.revision}, patched locally. Terminal mirror: ${pins.terminal.revision}. Ghostty WASM provenance: 7b11f3dca034d8d24369ad3856afe57946d7902a. The original terminal notice below retains its historical revision text.\n`;
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
const includedRust = new Set();
for (const manifest of ["rust/brush-browser/Cargo.toml", "shell/Cargo.toml"]) {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  for (const pkg of metadata.packages.sort((a, b) => a.name.localeCompare(b.name))) {
    if (includedRust.has(pkg.manifest_path) || pkg.name === "shell-parser") continue;
    includedRust.add(pkg.manifest_path);
    await include(`${pkg.name} ${pkg.version}`, dirname(pkg.manifest_path));
  }
}
// Required vendored notice: fail the build if the pinned parser license is missing.
const parserLicense = await readFile(resolve(root, pins.shellParser.directory, "LICENSE"), "utf8");
output += `\n\n## Bashkit parser ${pins.shellParser.revision} / LICENSE\n\n${parserLicense}\n`;
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev) continue;
  await include(`${path.split("node_modules/").at(-1)} ${pkg.version}`, resolve(root, path));
}
await include("ghostty-webgpu 0.3.24", resolve(root, ".sources/ghostty-webgpu"));
for (const name of (await readdir(resolve(root, "third-party/bun-wasm"))).filter((name) =>
  name.includes("LICENSE"),
))
  output += `\n\n## bun-wasm ${pins.bunWasm.revision} / ${name}\n\n${await readFile(resolve(root, "third-party/bun-wasm", name), "utf8")}\n`;
for (const name of await readdir(resolve(root, "third-party/bashkit")))
  output += `\n\n## Bashkit 0.18.2 / ${name}\n\n${await readFile(resolve(root, "third-party/bashkit", name), "utf8")}\n`;
output +=
  "\n\n" +
  (await readFile(resolve(root, ".sources/ghostty-webgpu/THIRD_PARTY_NOTICES.md"), "utf8"));
output +=
  "\n\n" + (await readFile(resolve(root, ".sources/bashkit/pkg/THIRD_PARTY_NOTICES.txt"), "utf8"));
await writeFile(resolve(root, "public/THIRD_PARTY_NOTICES.txt"), output);
