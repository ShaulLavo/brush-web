import { Bash, initBashkit } from "@everruns/bashkit-wasm";
import wasmUrl from "@everruns/bashkit-wasm/bashkit_wasm_bg.wasm?url";
import type { ScriptSession } from "./baseline";

export async function createBashkitSession(): Promise<{
  shell: ScriptSession;
  wasmBytes: number;
  commands: string[];
}> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Bashkit WASM fetch failed (${response.status})`);
  const wasmBytes = Number(response.headers.get("content-length") ?? 0);
  await initBashkit(response);
  const bash = new Bash({
    profile: "interactive",
    cwd: "/home/user",
    env: { HOME: "/home/user", TERM: "xterm-256color" },
    maxCommands: 10000000,
    maxLoopIterations: 10000000,
    maxMemory: 32 * 1024 * 1024,
    timeoutMs: 60000,
    files: { "/home/user/welcome.txt": "Files and commands run inside this browser.\n" },
  });
  const inventory = await bash.execute("shopt -s expand_aliases; compgen -b");
  const commands = inventory.stdout.split(/\s+/).filter(Boolean);
  const shell: ScriptSession = {
    cwd: "/home/user",
    fs: { resolvePath: (_cwd, path) => path, readdirWithFileTypes: async () => [] },
    async exec(command, signal) {
      const cancel = () => bash.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const result = await bash.execute(command);
        if (result.stdoutTruncated || result.stderrTruncated)
          return {
            stdout: result.stdout,
            stderr: result.stderr + "\nBashkit output was truncated by execution limits.\n",
            exitCode: 1,
          };
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } finally {
        signal.removeEventListener("abort", cancel);
        bash.clearCancel();
      }
    },
  };
  return { shell, commands, wasmBytes };
}
