// Serialized into the page. Callback and GPU completion timers are diagnostic, not shader timestamps.
export async function frameProbe() {
  window.costMarker = "";
  const terminal = window.brushWeb.terminal;
  const bytes = new TextEncoder().encode(
    Array.from({ length: 10000 }, (_, index) => String(index + 1)).join("\r\n") +
      "\r\nCOST_REPLAY\r\n",
  );
  const originalFrame = window.requestAnimationFrame;
  const originalSubmit = typeof GPUQueue === "undefined" ? undefined : GPUQueue.prototype.submit;
  let callbacks = [],
    queues = [],
    pending = [];
  window.requestAnimationFrame = (callback) =>
    originalFrame.call(window, (timestamp) => {
      const startedAt = performance.now();
      try {
        callback(timestamp);
      } finally {
        callbacks.push({ startedAt, finishedAt: performance.now() });
      }
    });
  if (originalSubmit)
    GPUQueue.prototype.submit = function (commands) {
      const point = { submittedAt: performance.now(), completedAt: 0 };
      originalSubmit.call(this, commands);
      queues.push(point);
      pending.push(
        this.onSubmittedWorkDone().then(() => {
          point.completedAt = performance.now();
        }),
      );
    };
  async function trial(index) {
    callbacks = [];
    queues = [];
    pending = [];
    const finished = new Promise((resolve) => {
      const sub = terminal.onFrame(() => {
        if (window.brushWeb.visibleLines().some((line) => line.trim() === "COST_REPLAY")) {
          sub.dispose();
          resolve(performance.now());
        }
      });
    });
    terminal.write(new TextEncoder().encode("\x1b[H\x1b[2J"));
    const startedAt = performance.now();
    let submitMs = 0;
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const before = performance.now();
      terminal.write(bytes.subarray(offset, offset + 32768));
      submitMs += performance.now() - before;
    }
    const frameAt = await finished;
    await Promise.all(pending);
    const rafCpuMs = callbacks.reduce((total, span) => total + span.finishedAt - span.startedAt, 0);
    return {
      trial: index,
      bytes: bytes.length,
      submitMs,
      toFrameMs: frameAt - startedAt,
      rafCpuMs,
      callbacks,
      queues,
    };
  }
  try {
    await trial(0);
    const samples = [];
    for (let index = 1; index <= 20; index++) samples.push(await trial(index));
    return samples;
  } finally {
    window.requestAnimationFrame = originalFrame;
    if (originalSubmit) GPUQueue.prototype.submit = originalSubmit;
  }
}
