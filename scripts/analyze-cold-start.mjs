// Summarizes docs/evidence/cold-start.json into per-engine sizes, load times and phase attribution.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = process.env.BRUSH_COLD_PREFIX ?? "cold-start";
const bytes = await readFile(resolve(root, "docs/evidence", `${source}.json`));
const data = JSON.parse(bytes);

function quantile(values, q) {
  const sorted = values.toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
const stats = (values) =>
  values.length
    ? {
        n: values.length,
        median: quantile(values, 0.5),
        p25: quantile(values, 0.25),
        p75: quantile(values, 0.75),
        min: Math.min(...values),
        max: Math.max(...values),
      }
    : { n: 0 };

const isEngineAsset = (name) => /shell\.worker/.test(name);

// Page-relative milliseconds since navigation start for one visit.
function measure(sample) {
  const offset = sample.worker.timeOrigin - sample.timeOrigin;
  const worker = Object.fromEntries(
    Object.entries(sample.worker.marks).map(([name, value]) => [name, value + offset]),
  );
  const engineResources = sample.resources
    .filter((entry) => isEngineAsset(entry.name))
    .concat(
      sample.worker.resources.map((entry) => ({
        ...entry,
        startTime: entry.startTime + offset,
        responseEnd: entry.responseEnd + offset,
      })),
    );
  const { sessionStart, terminalOpened, ready, promptFrame } = sample.marks;
  const engineFetched = Math.max(...engineResources.map((entry) => entry.responseEnd));
  const codeReady = worker.compiled ?? worker.moduleLoaded;
  const firstCommand = sample.command.hiAt - sample.command.enterAt;
  return {
    terminalOpened,
    sessionStart,
    engineFetched,
    codeReady,
    ready,
    promptFrame,
    firstCommand,
    hiVisible: promptFrame + firstCommand,
    fromSession: {
      engineFetched: engineFetched - sessionStart,
      codeReady: codeReady - sessionStart,
      ready: ready - sessionStart,
      promptFrame: promptFrame - sessionStart,
      hiVisible: promptFrame + firstCommand - sessionStart,
    },
    // Consecutive, non-overlapping segments; they add up to navigation → "hi" visible.
    segments: {
      pageAndTerminal: sessionStart,
      engineFetch: engineFetched - sessionStart,
      compileOrEvaluate: codeReady - engineFetched,
      instantiateAndInit: ready - codeReady,
      promptPaint: promptFrame - ready,
      firstCommand,
    },
    engineTransferBytes: engineResources.reduce((total, entry) => total + entry.transferSize, 0),
    pageTransferBytes:
      sample.navigation.transferSize +
      sample.resources
        .filter((entry) => !isEngineAsset(entry.name))
        .reduce((total, entry) => total + entry.transferSize, 0),
    mainThreadSpinMs: sample.mainThreadSpinMs,
    codeCacheBytes: sample.codeCacheBytes,
  };
}

const conditions = Object.keys(data.conditions);
const variants = Object.keys(data.variants);
const visits = ["cold", "warm1", "warm2"];
const measured = data.samples.map((sample) => ({ ...sample, measured: measure(sample) }));
const pick = (path, value) => path.split(".").reduce((item, key) => item?.[key], value);

const cells = [];
for (const condition of conditions)
  for (const visit of visits)
    for (const variant of variants) {
      const rows = measured.filter(
        (sample) =>
          sample.condition === condition && sample.visit === visit && sample.variant === variant,
      );
      const summarize = (path) => stats(rows.map((sample) => pick(path, sample.measured)));
      cells.push({
        condition,
        visit,
        variant,
        n: rows.length,
        promptFrame: summarize("promptFrame"),
        hiVisible: summarize("hiVisible"),
        sessionStart: summarize("sessionStart"),
        engineFetched: summarize("engineFetched"),
        codeReady: summarize("codeReady"),
        fromSession: Object.fromEntries(
          Object.keys(rows[0]?.measured.fromSession ?? {}).map((key) => [
            key,
            summarize(`fromSession.${key}`),
          ]),
        ),
        segments: Object.fromEntries(
          Object.keys(rows[0]?.measured.segments ?? {}).map((key) => [
            key,
            summarize(`segments.${key}`),
          ]),
        ),
        engineTransferBytes: summarize("engineTransferBytes"),
        pageTransferBytes: summarize("pageTransferBytes"),
        mainThreadSpinMs: summarize("mainThreadSpinMs"),
        wasmCodeCacheBytes: summarize("codeCacheBytes.wasm"),
        jsCodeCacheBytes: summarize("codeCacheBytes.js"),
      });
    }

// Asset inventory from the unthrottled cold visits: what each engine actually fetched.
function assetSizes(variant, name) {
  const path = name === "/" ? "/index.html" : name;
  const override = data.overrides[variant];
  return override?.path === path ? override : data.files[path];
}
const inventory = {};
for (const variant of variants) {
  const names = new Set(["/"]);
  const afterPrompt = new Set();
  for (const sample of data.samples.filter(
    (item) => item.variant === variant && item.visit === "cold",
  )) {
    for (const entry of sample.resources.concat(sample.worker.resources)) names.add(entry.name);
    for (const name of sample.requestsAfterPrompt) afterPrompt.add(name);
  }
  inventory[variant] = {
    // Names without a built file (the browser's favicon probe, answered 404) carry no bytes.
    assets: Array.from(names, (name) => ({
      name: name === "/" ? "/index.html" : name,
      ...assetSizes(variant, name),
    })).filter((asset) => asset.raw !== undefined),
    requestsAfterPrompt: Array.from(afterPrompt),
  };
}
const shared = new Set(
  inventory[variants[0]].assets
    .map((asset) => asset.name)
    .filter((name) =>
      variants.every((variant) => inventory[variant].assets.some((asset) => asset.name === name)),
    ),
);
const sizes = Object.fromEntries(
  variants.map((variant) => {
    const engine = inventory[variant].assets.filter((asset) => !shared.has(asset.name));
    const total = (key, assets) => assets.reduce((sum, asset) => sum + asset[key], 0);
    return [
      variant,
      {
        engineAssets: engine,
        engine: { raw: total("raw", engine), gzip: total("gzip", engine), br: total("br", engine) },
        requestsAfterPrompt: inventory[variant].requestsAfterPrompt,
      },
    ];
  }),
);
const sharedAssets = inventory[variants[0]].assets.filter((asset) => shared.has(asset.name));

const summary = {
  source: `${source}.json`,
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  browser: data.browser,
  cpu: data.cpu,
  trials: data.trials,
  failures: data.failures,
  sharedAssets,
  sharedTotal: {
    raw: sharedAssets.reduce((sum, asset) => sum + asset.raw, 0),
    gzip: sharedAssets.reduce((sum, asset) => sum + asset.gzip, 0),
    br: sharedAssets.reduce((sum, asset) => sum + asset.br, 0),
  },
  sizes,
  cells,
};
await writeFile(
  resolve(root, "docs/evidence", `${source}-summary.json`),
  JSON.stringify(summary, null, 2) + "\n",
);

const kb = (value) => `${(value / 1000).toFixed(0)} KB`;
const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`);
const spread = (cell) => `${ms(cell.median)} (${ms(cell.p25)}–${ms(cell.p75)})`;
const cell = (condition, visit, variant) =>
  cells.find(
    (item) => item.condition === condition && item.visit === visit && item.variant === variant,
  );
let text = `Source ${source}.json (${summary.sourceSha256.slice(0, 12)}), ${data.trials} trials, ${data.failures.length} failures\n\n`;
text +=
  "| Engine | Engine assets | Raw | gzip -9 | brotli 11 | Requests after prompt |\n|---|---|--:|--:|--:|---|\n";
for (const variant of variants)
  text += `| ${variant} | ${sizes[variant].engineAssets.map((asset) => asset.name.split("/").at(-1)).join(", ")} | ${kb(sizes[variant].engine.raw)} | ${kb(sizes[variant].engine.gzip)} | ${kb(sizes[variant].engine.br)} | ${sizes[variant].requestsAfterPrompt.length || "none"} |\n`;
text += `| shared page | ${sharedAssets.map((asset) => asset.name.split("/").at(-1)).join(", ")} | ${kb(summary.sharedTotal.raw)} | ${kb(summary.sharedTotal.gzip)} | ${kb(summary.sharedTotal.br)} | |\n\n`;
for (const [title, path] of [
  ["Navigation → prompt painted, median (IQR)", "promptFrame"],
  ["Navigation → `echo hi` output painted, median (IQR)", "hiVisible"],
])
  for (const visit of visits) {
    text += `${title}, ${visit}\n\n| Condition | ${variants.join(" | ")} |\n|---|${variants.map(() => "--:").join("|")}|\n`;
    for (const condition of conditions)
      text += `| ${condition} | ${variants.map((variant) => spread(cell(condition, visit, variant)[path])).join(" | ")} |\n`;
    text += "\n";
  }
for (const condition of ["fast4g-cdp4x", "slow4g-cdp4x"].filter((name) =>
  conditions.includes(name),
)) {
  text += `Cold milestones from navigation, ${condition}, median\n\n| Engine | Engine selected | (a) Assets fetched | (b) Compiled / evaluated | (c) Prompt painted | (d) \`hi\` painted |\n|---|--:|--:|--:|--:|--:|\n`;
  for (const variant of variants) {
    const item = cell(condition, "cold", variant);
    text += `| ${variant} | ${["sessionStart", "engineFetched", "codeReady", "promptFrame", "hiVisible"].map((key) => ms(item[key].median)).join(" | ")} |\n`;
  }
  text += "\n";
}
text += `Engine selection (session start) → prompt painted, median\n\n| Condition | Visit | ${variants.join(" | ")} |\n|---|---|${variants.map(() => "--:").join("|")}|\n`;
for (const condition of conditions)
  for (const visit of visits)
    text += `| ${condition} | ${visit} | ${variants.map((variant) => ms(cell(condition, visit, variant).fromSession.promptFrame.median)).join(" | ")} |\n`;
text += "\n";
for (const [condition, visit] of conditions.flatMap((name) => [
  [name, "cold"],
  [name, "warm2"],
])) {
  text += `Segments, ${visit}, ${condition} (medians; sum of medians need not equal the median total)\n\n| Engine | Page + terminal | Engine fetch | Compile/evaluate tail | Instantiate + init | Prompt paint | First command | Engine bytes |\n|---|--:|--:|--:|--:|--:|--:|--:|\n`;
  for (const variant of variants) {
    const item = cell(condition, visit, variant);
    text += `| ${variant} | ${Object.values(item.segments)
      .map((value) => ms(value.median))
      .join(" | ")} | ${kb(item.engineTransferBytes.median)} |\n`;
  }
  text += "\n";
}
text += "Main-thread spin (2e7 iterations), median ms, by condition: ";
text += conditions
  .map(
    (condition) =>
      `${condition} ${ms(stats(measured.filter((sample) => sample.condition === condition).map((sample) => sample.measured.mainThreadSpinMs)).median)}`,
  )
  .join(", ");
text += "\n\nCode cache after visit (median bytes, unthrottled): ";
text += variants
  .map((variant) =>
    visits
      .map((visit) => {
        const item = cell("unthrottled", visit, variant);
        return `${variant}/${visit} wasm ${item.wasmCodeCacheBytes.median} js ${item.jsCodeCacheBytes.median}`;
      })
      .join("; "),
  )
  .join("; ");
process.stdout.write(text + "\n");
