// Shell package boundary. Only the standalone host imports the browser runtime implementation.
import { SharedBridge } from "./bridge";

export interface RuntimeExit {
  code: number;
  error?: string;
}
export interface RuntimeProcess {
  readonly pid: number;
  readonly wasmBytes: number;
  readonly done: Promise<RuntimeExit>;
  signal(signal: 2 | 9): void;
  dispose(): void;
}
export interface ShellProcessOptions {
  executable: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  terminal: SharedBridge;
}
/** Supplied by the embedding page, not created or owned by the shell package. */
export interface ShellRuntimePeer {
  startProcess(options: ShellProcessOptions): Promise<RuntimeProcess>;
}
export interface ShellOptions {
  runtime: ShellRuntimePeer;
  terminal?: SharedBridge;
  cwd?: string;
  env?: Record<string, string>;
  /** Omit for the persistent interactive editor; useful for runtime-backed script execution. */
  script?: string;
}
export interface Shell {
  readonly terminal: SharedBridge;
  readonly process: RuntimeProcess;
  readonly done: Promise<RuntimeExit>;
  interrupt(): void;
  dispose(): void;
}

export async function createShell(options: ShellOptions): Promise<Shell> {
  const terminal = options.terminal ?? new SharedBridge();
  const cwd = options.cwd ?? "/home/guest";
  const process = await options.runtime.startProcess({
    executable: "/programs/shell-engine.wasm",
    argv:
      options.script === undefined
        ? ["shell-engine", "-i"]
        : ["shell-engine", "-c", options.script],
    cwd,
    env: {
      HOME: "/home/guest",
      USER: "guest",
      PATH: "/bin",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      ...options.env,
      PWD: cwd,
    },
    terminal,
  });
  return {
    terminal,
    process,
    done: process.done,
    // The shell handles SIGINT and forwards only its foreground job. Never signal all its jobs.
    interrupt: () => process.signal(2),
    dispose: () => process.dispose(),
  };
}
