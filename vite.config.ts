import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};
export default defineConfig({
  base: "./",
  resolve: {
    alias: [
      {
        find: /^@bun-wasm\/runtime\/(.+)$/,
        replacement: fileURLToPath(new URL("./third-party/bun-wasm/runtime/$1", import.meta.url)),
      },
      {
        find: /^bashkit-terminal-source\/(.+)$/,
        replacement: fileURLToPath(new URL("./.sources/bashkit/pkg/$1", import.meta.url)),
      },
      {
        find: "bashkit-terminal-source",
        replacement: fileURLToPath(
          new URL("./.sources/bashkit/pkg/bashkit_wasm.js", import.meta.url),
        ),
      },
      {
        find: /^ghostty-webgpu\/(.+)$/,
        replacement: fileURLToPath(new URL("./.sources/ghostty-webgpu/$1", import.meta.url)),
      },
      {
        find: "ghostty-webgpu",
        replacement: fileURLToPath(
          new URL("./.sources/ghostty-webgpu/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  server: { headers, port: 5187, strictPort: true },
  preview: { headers, port: 4187, strictPort: true },
  worker: { format: "es" },
  build: { target: "esnext" },
});
