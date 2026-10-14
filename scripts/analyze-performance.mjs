import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "docs/evidence/performance-proof.json"));
const data = JSON.parse(source);
if (data.error || data.interrupted || data.trials !== 30 || data.samples.length !== 1680)
  throw new Error("A complete 30-trial proof is required");
const quantile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
let state = 3141592653;
function random() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}
const comparisons = [];
for (const fixture of new Set(data.samples.map((sample) => sample.fixture))) {
  const samples = (engine) =>
    data.samples
      .filter(
        (sample) =>
          sample.build === "optimized" &&
          sample.engine === engine &&
          sample.fixture === fixture &&
          !sample.instrumented,
      )
      .toSorted((a, b) => a.trial - b.trial);
  const brush = samples("brush"),
    baseline = samples("just-bash");
  if (brush.length !== 30 || baseline.length !== 30) throw new Error("Missing paired samples");
  const ratios = brush.map(
    (sample, index) => sample.worker.external.elapsedMs / baseline[index].worker.external.elapsedMs,
  );
  const bootstrap = [];
  for (let iteration = 0; iteration < 2000; iteration++)
    bootstrap.push(
      quantile(
        Array.from({ length: 30 }, () => ratios[Math.floor(random() * 30)]),
        0.5,
      ),
    );
  comparisons.push({
    fixture,
    pairedWorkerRatioMedian: quantile(ratios, 0.5),
    bootstrap95Interval: [quantile(bootstrap, 0.025), quantile(bootstrap, 0.975)],
    brushWorkerMedianMs: quantile(
      brush.map((s) => s.worker.external.elapsedMs),
      0.5,
    ),
    justBashWorkerMedianMs: quantile(
      baseline.map((s) => s.worker.external.elapsedMs),
      0.5,
    ),
    brushVisibleMedianMs: quantile(
      brush.map((s) => s.visibleMs),
      0.5,
    ),
    justBashVisibleMedianMs: quantile(
      baseline.map((s) => s.visibleMs),
      0.5,
    ),
  });
}
for (const sample of data.samples.filter(
  (sample) => sample.build === "optimized" && sample.instrumented,
))
  if (sample.worker.direct.sequence !== sample.worker.external.sequence)
    throw new Error("Stale direct profile counter detected");
const analysis = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  method:
    "Paired worker-time ratios by trial; 2,000 seeded bootstrap median resamples. Ratios below 1 favor Brush. These exploratory intervals do not establish independence, universal performance, or physical display latency.",
  comparisons,
  functional: data.functional.map((run) => ({
    engine: run.engine,
    inputFrameP95Ms: quantile(run.inputFrameSamples, 0.95),
    interruptions: run.interruptions,
    matchedReplayMedianMs: run.matchedTerminalReplay.medianMs,
    memoryBytes: run.memoryBytes,
  })),
};
await writeFile(
  resolve(root, "docs/evidence/performance-analysis.json"),
  JSON.stringify(analysis, null, 2) + "\n",
);
for (const row of comparisons)
  process.stdout.write(
    `${row.fixture}: worker ${row.brushWorkerMedianMs.toFixed(2)} / ${row.justBashWorkerMedianMs.toFixed(2)} ms; paired ratio ${row.pairedWorkerRatioMedian.toFixed(2)}, interval ${row.bootstrap95Interval.map((x) => x.toFixed(2)).join("–")}\n`,
  );
