import { copyFile } from "node:fs/promises";
await copyFile(
  new URL("./serve.mjs", import.meta.url),
  new URL("../dist/serve.mjs", import.meta.url),
);
