// Worker-side startup marks. Times are worker performance.now(); add timeOrigin for wall time.
export type StartupResource = {
  name: string;
  startTime: number;
  responseStart: number;
  responseEnd: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
};
export type StartupTimeline = {
  timeOrigin: number;
  marks: Record<string, number>;
  resources: StartupResource[];
};

const marks: Record<string, number> = {};

export function markStartup(name: string) {
  marks[name] = performance.now();
}

export function startupTimeline(): StartupTimeline {
  return {
    timeOrigin: performance.timeOrigin,
    marks: { ...marks },
    resources: Array.from(
      performance.getEntriesByType("resource") as PerformanceResourceTiming[],
      (entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        responseStart: entry.responseStart,
        responseEnd: entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      }),
    ),
  };
}
