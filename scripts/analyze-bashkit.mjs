import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const read = async (name) =>
  JSON.parse(await readFile(new URL(`docs/evidence/${name}.json`, root), "utf8"));
const frame = await read("native-mac-frame");
const immediate = await read("native-mac-immediate");
const apis = await read("bashkit-same-binary-apis");
if (frame.error || immediate.error || apis.error) throw new Error("Measurement failed");
if (JSON.stringify(frame.artifacts) !== JSON.stringify(immediate.artifacts))
  throw new Error("Frame and immediate artifact hashes differ");
const median = (values) => values.toSorted((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const groups = new Map();
for (const s of apis.data.samples) {
  const key = s.fixture + " " + s.api;
  const values = groups.get(key) ?? [];
  values.push(s.elapsedMs);
  groups.set(key, values);
}
let text =
  "# Native Bashkit timings\n\nChrome " +
  frame.browser +
  ", Apple M1, macOS 26.4 / Darwin 25.4.0, headless hardware WebGPU through Metal 3. Twenty trials after one warmup, alternating engine order. All outputs were checked.\n\n| Workload | Engine | Worker, frame mode | Submitted frame, frame mode | Submitted frame, immediate mode |\n| --- | --- | ---: | ---: | ---: |\n";
for (const s of frame.summary) {
  const i = immediate.summary.find((x) => x.fixture === s.fixture && x.engine === s.engine);
  text += `| ${s.fixture} | ${s.engine} | ${s.phase.worker.elapsedMs.toFixed(2)} ms | ${s.phase.main.inputToFrameMs.toFixed(2)} ms | ${i.phase.main.inputToFrameMs.toFixed(2)} ms |\n`;
}
text +=
  "\nThe submitted-frame endpoint is Ghostty onFrame. It excludes compositor completion and physical display scanout. Worker spans are wall time through each adapter, not isolated interpreter CPU time. Cost instrumentation ran separately from the phase timings above.\n\n## Both APIs in one WASM module\n\nThis control uses one worker, one source-built WASM module and the same execution-limit options. It excludes Ghostty, the shared bridge and page frame scheduling. Terminal uses its default 24 by 80 geometry. The workbench uses 27 by 136 and has eight live sessions during its matrix. Do not subtract these control medians from the workbench medians.\n\n| Workload | Bash.execute | Terminal |\n| --- | ---: | ---: |\n";
for (const id of ["arithmetic-20000", "substitutions-1000", "terminal-10000"])
  text += `| ${id} | ${median(groups.get(id + " Bash.execute")).toFixed(2)} ms | ${median(groups.get(id + " Terminal")).toFixed(2)} ms |\n`;
text +=
  "\nThe Terminal differential includes native input editing, echo, the internal vt100 parser, transcript capture and different output extraction. It does not isolate vt100 or the WASM transition itself. The source-module SHA-256 is " +
  apis.wasmSha256 +
  ".\n";
await writeFile(new URL("docs/evidence/bashkit-native-timings.md", root), text);
console.log(text);
