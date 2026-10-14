// This function is serialized into a dedicated browser worker by the cost runner.
export async function memoryAndBoundaryProbe() {
  const trials = 30;
  function section(id, payload) {
    return [id, payload.length].concat(payload);
  }
  function moduleBytes(imported) {
    const body = [
      1, 2, 0x7f, 0x02, 0x40, 0x03, 0x40, 0x20, 1, 0x20, 0, 0x4f, 0x0d, 1, 0x20, 2, 0x20, 1,
    ].concat(
      imported ? [0x10, 0] : [],
      [0x6a, 0x21, 2, 0x20, 1, 0x41, 1, 0x6a, 0x21, 1, 0x0c, 0, 0x0b, 0x0b, 0x20, 2, 0x0b],
    );
    return Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
        imported ? section(2, [1, 4, 104, 111, 115, 116, 4, 116, 105, 99, 107, 0, 0]) : [],
        section(3, [1, 0]),
        section(7, [1, 3, 114, 117, 110, 0, imported ? 1 : 0]),
        section(10, [1, body.length].concat(body)),
      ),
    );
  }
  const callback = (value) => value;
  const inline = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(false))).exports.run;
  const bridged = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(true)), {
    host: { tick: callback },
  }).exports.run;
  const iterations = 500000;
  const expected = ((iterations * (iterations - 1)) / 2) | 0;
  function call(run) {
    const start = performance.now();
    if (run(iterations) !== expected) throw new Error("Boundary checksum failed");
    return performance.now() - start;
  }
  for (let warm = 0; warm < 10; warm++) {
    call(inline);
    call(bridged);
  }
  const calls = [];
  for (let trial = 0; trial < trials; trial++) {
    const sample = { trial: trial + 1 };
    for (const [name, run] of trial % 2
      ? [
          ["bridgedMs", bridged],
          ["inlineMs", inline],
        ]
      : [
          ["inlineMs", inline],
          ["bridgedMs", bridged],
        ])
      sample[name] = call(run);
    sample.estimatedImportPlusCallbackNs =
      ((sample.bridgedMs - sample.inlineMs) * 1e6) / iterations;
    calls.push(sample);
  }
  const memory = new WebAssembly.Memory({ initial: 2 });
  const ordinary = new ArrayBuffer(memory.buffer.byteLength);
  new Uint8Array(memory.buffer).fill(1);
  new Uint8Array(ordinary).fill(1);
  function memoryBatch(buffer, size, operation, count) {
    const source = new Uint8Array(buffer, 4096, size);
    const target = new Uint8Array(size);
    const retained = new Array(16);
    let checksum = 0;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const value =
        operation === "view"
          ? new Uint8Array(buffer, 4096, size)
          : operation === "slice"
            ? source.slice()
            : target;
      if (operation === "set") target.set(source);
      retained[i % 16] = value;
      checksum += value[0] + value[size - 1];
    }
    if (checksum !== count * 2 || retained[0].length !== size)
      throw new Error("Memory checksum failed");
    return performance.now() - start;
  }
  const memorySamples = [];
  for (const size of [8192, 65536]) measureSize(size);
  function measureSize(size) {
    for (const operation of ["view", "slice", "set"]) measureOperation(size, operation);
  }
  function measureOperation(size, operation) {
    const count = operation === "view" ? 100000 : 1000;
    for (let warm = 0; warm < 5; warm++) {
      memoryBatch(memory.buffer, size, operation, count);
      memoryBatch(ordinary, size, operation, count);
    }
    const samples = [];
    for (let trial = 0; trial < trials; trial++) {
      const sample = { trial: trial + 1 };
      for (const [name, buffer] of trial % 2
        ? [
            ["ordinaryMs", ordinary],
            ["wasmMs", memory.buffer],
          ]
        : [
            ["wasmMs", memory.buffer],
            ["ordinaryMs", ordinary],
          ])
        sample[name] = memoryBatch(buffer, size, operation, count);
      samples.push(sample);
    }
    memorySamples.push({ size, operation, count, samples });
  }
  return {
    trials,
    iterations,
    calls,
    memorySamples,
    limitations: [
      "The callback differential includes callback dispatch, loop/JIT differences and bookkeeping; it is not a pure transition measurement and must not be multiplied into exact shell attribution.",
      "Memory batches use hot buffers and retained views/copies. Slice includes allocation and possible GC; set reuses a destination. View timing includes construction and two byte reads, not scanning all payload bytes.",
      "Both WASM and ordinary ArrayBuffer cases execute in the same browser worker; these microbenchmarks are not Brush versus just-bash interpreter benchmarks.",
    ],
  };
}
