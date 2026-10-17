import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compiled = await build({
  entryPoints: [resolve(root, "src/runtime/terminal.test.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  alias: { "@bun-wasm/runtime": resolve(root, "third-party/bun-wasm/runtime") },
});
// In-memory bundle: no copied source, temp output or background helpers to clean.
await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].contents).toString("base64")
);
