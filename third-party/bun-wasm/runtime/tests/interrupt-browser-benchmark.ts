import { rewriteInterrupts } from "../interrupt/rewriter";
import { interruptWorkloadFixture } from "./fixtures/interrupt-browser-workload";
import { ownInterruptWorker, releaseInterruptWorker } from "./interrupt-browser-control";
import type { BunBuildSample, InterruptWorkerRequest } from "./fixtures/interrupt-browser-worker";

interface Arm { name: string; rewrite(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>; }
function* alternating<T>(items: readonly T[], repetition: number): Generator<T> {
  for (let offset = 0; offset < items.length; offset++) yield items[repetition % 2 ? items.length - 1 - offset : offset]!;
}
const median = (samples: number[]) => { samples.sort((a, b) => a - b); return samples[Math.floor(samples.length / 2)]!; };
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
async function artifact(name: string) {
  const response = await fetch(`/${name}.wasm`);
  if (!response.ok) throw new Error(`${name}.wasm: HTTP ${response.status}; benchmark needs explicit existing artifact paths`);
  return new Uint8Array(await response.arrayBuffer());
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function bunBuild(module: WebAssembly.Module, interrupt: Int32Array): Promise<BunBuildSample> {
  const owned = ownInterruptWorker();
  try {
    return await new Promise<BunBuildSample>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("real Bun build timed out")), 30_000);
      owned.worker.onmessage = ({ data }) => {
        clearTimeout(deadline); owned.settled = true;
        if (data.kind !== "built") reject(new Error(data.error ?? "unexpected Bun build response")); else resolve(data);
      };
      owned.worker.onerror = event => { event.preventDefault(); clearTimeout(deadline); owned.settled = true; reject(new Error(event.message)); };
      try { owned.worker.postMessage({ kind: "bun-build", module, interrupt } satisfies InterruptWorkerRequest); }
      catch (error) { clearTimeout(deadline); reject(error); }
    });
  } finally { await releaseInterruptWorker(owned); }
}

/** Existing artifact bytes only. No compiler/build/download is hidden in this browser gate. */
export async function runInterruptBenchmarks() {
  // The retained spike prototype is an explicit runner input, NOT another production rewriter.
  const prototypePath = new URL("/prototype.js", location.href).href;
  const prototype = await import(prototypePath) as { rewrite(bytes: Uint8Array<ArrayBuffer>, options: { mode: string }): { bytes: Uint8Array<ArrayBuffer> } };
  const arms: Arm[] = [
    { name: "original", rewrite: bytes => bytes },
    { name: "countdown-4096", rewrite: bytes => rewriteInterrupts(bytes) },
    { name: "countdown-256", rewrite: bytes => rewriteInterrupts(bytes, { interval: 256 }) },
    { name: "prototype-entry-loop256", rewrite: bytes => prototype.rewrite(bytes, { mode: "sampled" }).bytes },
  ];
  const flag = new Int32Array(new SharedArrayBuffer(4)), interrupted = () => Atomics.load(flag, 0);
  const rewriteRows = [], artifactBytes = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const name of ["bun", "brush"]) {
    const bytes = await artifact(name); artifactBytes.set(name, bytes);
    check(WebAssembly.validate(bytes), `${name}: invalid original`);
    const hash = await sha256(bytes);
    for (const arm of arms.slice(1)) {
      const samples = []; let rewritten = bytes;
      for (let repetition = 0; repetition < 5; repetition++) {
        const start = performance.now(); rewritten = arm.rewrite(bytes); samples.push(performance.now() - start);
      }
      const validationStart = performance.now(), valid = WebAssembly.validate(rewritten), validateMs = performance.now() - validationStart;
      check(valid, `${name}/${arm.name}: rewritten module did not validate`);
      const compileStart = performance.now(); await WebAssembly.compile(rewritten); const compileMs = performance.now() - compileStart;
      rewriteRows.push({ artifact: name, arm: arm.name, sha256: hash, inputBytes: bytes.length, outputBytes: rewritten.length, samples, medianMs: median(samples.slice()), valid, validateMs, compileMs });
    }
  }
  const workload = interruptWorkloadFixture();
  const instances = arms.map(arm => ({ name: arm.name, instance: new WebAssembly.Instance(new WebAssembly.Module(arm.rewrite(workload)), { runtime_proc: { interrupted }, __interrupt: { interrupted } }) }));
  const cpuRows: { workload: string; n: number; repetition: number; arm: string; ms: number; checksum: number }[] = [];
  for (const [workloadName, n] of [["tight", 20_000_000], ["sort", 262_144]] as const) {
    const run = (arm: typeof instances[number]) => (arm.instance.exports[workloadName] as (n: number) => number)(n);
    const expected = run(instances[0]!);
    for (const arm of instances) for (let warmup = 0; warmup < 3; warmup++) check(run(arm) === expected, `${workloadName}/${arm.name} warmup checksum`);
    for (let repetition = 0; repetition < 7; repetition++) for (const arm of alternating(instances, repetition)) {
      const started = performance.now(), checksum = run(arm), ms = performance.now() - started;
      check(checksum === expected, `${workloadName}/${arm.name} checksum differs`);
      cpuRows.push({ workload: workloadName, n, repetition, arm: arm.name, ms, checksum });
    }
  }
  const bun = artifactBytes.get("bun")!;
  const modules = await Promise.all(arms.map(async arm => ({ name: arm.name, module: await WebAssembly.compile(arm.rewrite(bun)) })));
  const bunRows: (BunBuildSample & { arm: string; repetition: number })[] = []; let expected: BunBuildSample | undefined;
  for (let repetition = -1; repetition < 7; repetition++) for (const arm of alternating(modules, repetition)) {
    const sample = await bunBuild(arm.module, flag);
    check(sample.code === 0 && sample.outputBytes > 0, `${arm.name}: Bun build failed ${JSON.stringify(sample)}`);
    expected ??= sample;
    check(sample.outputBytes === expected.outputBytes && sample.checksum === expected.checksum, `${arm.name}: Bun build output differs`);
    if (repetition >= 0) bunRows.push({ arm: arm.name, repetition, ...sample });
  }
  const summaries = ["tight", "sort", "bun-build"].flatMap(workloadName => {
    const rows = workloadName === "bun-build" ? bunRows : cpuRows.filter(row => row.workload === workloadName);
    const originalMs = median(rows.filter(row => row.arm === "original").map(row => row.ms));
    return arms.map(arm => { const ms = median(rows.filter(row => row.arm === arm.name).map(row => row.ms)); return { workload: workloadName, arm: arm.name, medianMs: ms, ratio: ms / originalMs }; });
  });
  return { rewriteRows, cpuRows, bunRows, summaries, qualifications: [
    "Seven warmed, interleaved execution repetitions; three CPU warmups and one Bun warmup per arm. All checksums and output sizes must agree.",
    "Bun times only wasi.start: compilation and instantiation are excluded. Source has 2500 typed constant exports.",
    "Prototype is the retained spike-5 external input: atomic call every entry, every 256 loop visits per activation. Countdown shares one module-global budget across entries and loops.",
    "Rewrite timings include the production rewriter's native original/output validation. Separate validation/compile samples are reported as well.",
  ] };
}
