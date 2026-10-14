import { Bash, InMemoryFs } from "just-bash/browser";
import type { BashExecResult, CommandName } from "just-bash/browser";

export type BaselineState = "isolated" | "carry";
export interface BaselineOptions {
  state: BaselineState;
}

const HOME_DIRECTORY = "/home/web";

export function createBaselineShell(options: BaselineOptions & { commands: CommandName[] }) {
  const fs = new InMemoryFs(
    {
      "/home/web/welcome.txt":
        "Files persist between commands. Shell state depends on the selected adapter mode.\n",
    },
    { maxTotalBytes: 16 * 1024 * 1024 },
  );
  const bash = new Bash({
    fs,
    cwd: HOME_DIRECTORY,
    env: { HOME: HOME_DIRECTORY, TERM: "xterm-256color" },
    python: false,
    javascript: false,
    defenseInDepth: false,
    commands: options.commands,
    executionLimits: {
      maxOutputSize: 4 * 1024 * 1024,
      maxStringLength: 4 * 1024 * 1024,
      maxLiveBytes: 32 * 1024 * 1024,
      maxCommandCount: 10000000,
      maxLoopIterations: 10000000,
      maxWorkUnits: 100000000,
      maxExecutionTimeMs: 60000,
    },
  });
  let cwd = HOME_DIRECTORY;
  let env: Record<string, string> | undefined;

  async function carry(result: BashExecResult, signal: AbortSignal) {
    if (options.state !== "carry" || signal.aborted) return;
    env = result.env;
    const directory = env.PWD;
    if (typeof directory !== "string" || !directory.startsWith("/")) return;
    const entry = await fs.stat(directory).catch(() => undefined);
    if (entry?.isDirectory) cwd = directory;
  }

  return {
    fs,
    state: options.state,
    get cwd() {
      return cwd;
    },
    async exec(command: string, signal: AbortSignal): Promise<BashExecResult> {
      const execution =
        options.state === "carry"
          ? { signal, rawScript: true, env, cwd }
          : { signal, rawScript: true };
      const result = await bash.exec(command, execution);
      if (options.state === "carry") await carry(result, signal);
      return result;
    },
  };
}

export type BaselineShell = ReturnType<typeof createBaselineShell>;
