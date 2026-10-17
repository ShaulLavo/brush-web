import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compiled = await build({
  entryPoints: [
    resolve(root, "src/runtime/terminal.test.ts"),
    resolve(root, "src/runtime/browser-runtime.test.ts"),
    resolve(root, "src/runtime/subprocess-broker.test.ts"),
    resolve(root, "src/runtime/guest-imports.test.ts"),
    resolve(root, "src/shell-terminal-output.test.ts"),
  ],
  outdir: resolve(root, ".scratch/runtime-terminal-tests"),
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  // Keep assertion stacks readable without dumping the whole base64 module URL.
  footer: { js: "//# sourceURL=brush-runtime-terminal.test.mjs" },
  alias: { "@bun-wasm/runtime": resolve(root, "third-party/bun-wasm/runtime") },
  // The in-memory module has a data: URL. Give worker URL construction a file base;
  // adapter tests replace Worker before launch, so no guest module is actually loaded.
  define: {
    "import.meta.url": JSON.stringify(
      new URL("../src/runtime/subprocess-broker.ts", import.meta.url).href,
    ),
  },
});
// In-memory bundle: no copied source, temp output or background helpers to clean.
for (const file of compiled.outputFiles) {
  await import("data:text/javascript;base64," + Buffer.from(file.contents).toString("base64"));
}
