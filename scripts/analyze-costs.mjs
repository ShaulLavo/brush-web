import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const median = (values) => values.toSorted((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const analysis = {
  runs: [],
  renderReplay: [],
  limitations: [
    "Representative critical paths use the phase trial nearest the median visible completion. Their main-thread intervals are disjoint and add to elapsed time. Worker spans overlap that timeline.",
    "Detailed timer values come from cost trials and include observer overhead. Worker outside imports is unattributed wall time, not pure Rust CPU or pure boundary time.",
    "RAF callback timing includes all observed page callbacks and instrumentation. GPU completion latency includes callback scheduling and an extra completion fence, not isolated shader time.",
  ],
};
async function read(name) {
  const bytes = await readFile(resolve(root, "docs/evidence", name));
  const data = JSON.parse(bytes);
  if (data.error || !Object.values(data.cleanup).every((value) => value === true))
    throw new Error(`Incomplete result ${name}`);
  return { data, source: name, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function criticalPath(sample) {
  const spans = sample.deliveries;
  const path = {
    beforeFirstDrainMs: spans[0].startedAt - sample.enterAt,
    ringDrainMs: sample.main.drainMs,
    terminalSubmitMs: sample.main.terminalSubmitMs,
    betweenDrainsMs: spans
      .slice(1)
      .reduce((total, span, index) => total + span.startedAt - spans[index].finishedAt, 0),
    lastDrainToFrameMs: sample.main.lastDrainToFrameMs,
  };
  const total = Object.values(path).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - sample.main.inputToFrameMs) > 0.001)
    throw new Error("Critical path does not add up");
  return {
    trial: sample.trial,
    elapsedMs: total,
    workerElapsedMs: sample.worker.elapsedMs,
    bytes: sample.main.deliveredBytes,
    drains: sample.main.drainCount,
    ...path,
  };
}
function summarizeFixture(data, fixture, engine) {
  const phase = data.samples
    .filter(
      (sample) => sample.mode === "phase" && sample.engine === engine && sample.fixture === fixture,
    )
    .toSorted((a, b) => a.main.inputToFrameMs - b.main.inputToFrameMs);
  if (phase.length !== data.trials) throw new Error("Missing phase trials");
  const representative = phase[Math.ceil(phase.length / 2) - 1];
  const cost = data.samples.filter(
    (sample) => sample.mode === "cost" && sample.engine === engine && sample.fixture === fixture,
  );
  return {
    fixture,
    engine,
    criticalPath: criticalPath(representative),
    phaseWorkerMedianMs: median(phase.map((sample) => sample.worker.elapsedMs)),
    phaseVisibleMedianMs: median(phase.map((sample) => sample.main.inputToFrameMs)),
    mainTerminalSubmitMedianMs: median(phase.map((sample) => sample.main.terminalSubmitMs)),
    costWorkerMedianMs: median(cost.map((sample) => sample.worker.elapsedMs)),
    normalizedOutputMedianMs: median(cost.map((sample) => sample.worker.normalizeMs)),
    ringCopyMedianMs: median(cost.map((sample) => sample.worker.ringCopyMs)),
    backpressureMedianMs: median(cost.map((sample) => sample.worker.backpressureMs)),
    wasiCallMedian: median(cost.map((sample) => sample.worker.wasiCalls)),
    browserCallMedian: median(cost.map((sample) => sample.worker.browserCalls)),
    baselineExecutionMedianMs:
      engine === "just-bash" ? median(cost.map((sample) => sample.worker.baselineExecMs)) : null,
    workerOutsideImportsMedianMs:
      engine === "brush" ? median(cost.map((sample) => sample.workerOutsideImportsMs)) : null,
  };
}
async function analyzeRun(renderer) {
  const { data, source, sha256 } = await read(`cost-attribution-${renderer}.json`);
  if (data.samples.length !== data.trials * 24) throw new Error("Incomplete matrix");
  const summaries = [];
  for (const fixture of new Set(data.samples.map((sample) => sample.fixture)))
    for (const engine of ["brush", "just-bash"])
      summaries.push(summarizeFixture(data, fixture, engine));
  for (const sample of data.samples.filter((sample) => sample.mode === "phase"))
    if (sample.worker.wasiCalls || sample.worker.browserCalls)
      throw new Error("Cost timers active in phase control");
  analysis.runs.push({
    source,
    sha256,
    renderer: data.renderer,
    trials: data.trials,
    gpu: data.gpu,
    summaries,
    importCallbackEstimatedMedianNs: median(
      data.probes.calls.map((sample) => sample.estimatedImportPlusCallbackNs),
    ),
    memory: data.probes.memorySamples.map((batch) => ({
      size: batch.size,
      operation: batch.operation,
      wasmMedianNsPerOperation:
        (median(batch.samples.map((sample) => sample.wasmMs)) * 1e6) / batch.count,
      ordinaryMedianNsPerOperation:
        (median(batch.samples.map((sample) => sample.ordinaryMs)) * 1e6) / batch.count,
    })),
  });
}
async function analyzeReplay(renderer) {
  const { data, source, sha256 } = await read(`cost-render-replay-${renderer}.json`);
  for (const run of data.replay) {
    if (run.samples.length !== 20) throw new Error("Incomplete render replay");
    if (run.samples.some((sample) => !sample.callbacks.length))
      throw new Error("RAF timing was not observed");
    if (
      renderer === "webgpu" &&
      run.samples.some(
        (sample) =>
          !sample.queues.length ||
          sample.queues.some((queue) => queue.completedAt <= queue.submittedAt),
      )
    )
      throw new Error("GPU completion was not observed");
  }
  analysis.renderReplay.push({
    source,
    sha256,
    renderer,
    trials: 20,
    gpu: data.gpu,
    summaries: data.replay.map((run) => ({
      engine: run.engine,
      terminalSubmitMedianMs: median(run.samples.map((sample) => sample.submitMs)),
      rafCpuMedianMs: median(run.samples.map((sample) => sample.rafCpuMs)),
      frameMedianMs: median(run.samples.map((sample) => sample.toFrameMs)),
      gpuCompletionMedianMs:
        renderer === "webgpu"
          ? median(
              run.samples.flatMap((sample) =>
                sample.queues.map((queue) => queue.completedAt - queue.submittedAt),
              ),
            )
          : null,
    })),
  });
}
for (const renderer of ["canvas", "webgpu"]) {
  await analyzeRun(renderer);
  await analyzeReplay(renderer);
}
await writeFile(
  resolve(root, "docs/evidence/cost-analysis.json"),
  JSON.stringify(analysis, null, 2) + "\n",
);
for (const run of analysis.runs)
  for (const row of run.summaries.filter((row) => row.fixture === "terminal-10000-immediate"))
    process.stdout.write(
      `${run.renderer} ${row.engine}: worker ${row.phaseWorkerMedianMs.toFixed(2)}, terminal ${row.mainTerminalSubmitMedianMs.toFixed(2)}, visible ${row.phaseVisibleMedianMs.toFixed(2)} ms\n`,
    );
