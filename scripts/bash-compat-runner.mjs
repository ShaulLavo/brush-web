// Shared by fresh captures and the frozen-observation transport audit.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:os";
import { resolve } from "node:path";
import { drainGroup, killGroup } from "./shell-process-group.mjs";

const pipeLauncher = resolve(import.meta.dirname, "bash-compat-pipe.py");
export const bashStdoutTransport =
  "Python3 subprocess stdout=PIPE forwarded byte-for-byte; explicit fd3 exit status";
export const bashStderrTransport =
  "Independent Python3 subprocess stderr=PIPE forwarded byte-for-byte";

export function createShellRunner({ scratch, timeoutMs, activeChildren = new Map() }) {
  return async function runShell(shell, code, path, sandbox = false, transport = "pipe") {
    if (!["pipe", "socket"].includes(transport)) throw new Error("Unknown stdout transport");
    const directory = await mkdtemp(resolve(scratch, "bash-"));
    const tmp = resolve(directory, "tmp");
    const home = resolve(directory, "home");
    let ownership;
    try {
      await mkdir(tmp);
      await mkdir(home);
      const sandboxArgs = [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--bind",
        directory,
        directory,
        "--ro-bind",
        resolve(scratch, "helpers"),
        resolve(scratch, "helpers"),
        "--ro-bind",
        shell,
        shell,
        "--chdir",
        tmp,
        "--",
        shell,
        "-c",
        code,
      ];
      const command = sandbox ? "bwrap" : shell;
      const args = sandbox ? sandboxArgs : ["-c", code];
      const realPipe = transport === "pipe";
      const child = spawn(
        realPipe ? "/usr/bin/python3" : command,
        realPipe ? [pipeLauncher, String(process.pid), command].concat(args) : args,
        {
          cwd: tmp,
          env: { PATH: path, HOME: home, TMP: tmp, SH: "bash", LC_ALL: "C.UTF-8" },
          stdio: realPipe ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      const kill = () => killGroup(child.pid, "SIGKILL");
      ownership = (async () => {
        try {
          return await collectShell(child, kill, tmp, home, timeoutMs, realPipe);
        } finally {
          kill();
          await drainGroup(child.pid);
          await rm(directory, { recursive: true, force: true });
          activeChildren.delete(kill);
        }
      })();
      // Teardown callers await the whole lifetime, including the termination barrier.
      activeChildren.set(kill, ownership);
      return await ownership;
    } finally {
      if (!ownership) await rm(directory, { recursive: true, force: true });
    }
  };
}

function collectShell(child, kill, tmp, home, timeoutMs, realPipe) {
  return new Promise((done, fail) => {
    const stdout = [];
    const stderr = [];
    const protocol = [];
    let protocolBytes = 0;
    let timeout = false;
    let outputLimit = false;
    let bytes = 0;
    const timer = setTimeout(() => {
      timeout = true;
      kill();
    }, timeoutMs);
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) return chunks.push(chunk);
      outputLimit = true;
      kill();
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    if (realPipe)
      child.stdio[3].on("data", (chunk) => {
        protocolBytes += chunk.length;
        if (protocolBytes <= 256) protocol.push(chunk);
        else kill();
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", kill);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      let shellStatus = status ?? 128 + (constants.signals[signal] ?? 0);
      if (realPipe && !timeout && !outputLimit) {
        try {
          const message = JSON.parse(Buffer.concat(protocol).toString("ascii"));
          if (
            status !== 0 ||
            protocolBytes > 256 ||
            !Number.isInteger(message.status) ||
            message.status < 0 ||
            message.status > 255
          )
            throw new Error("invalid launcher status");
          shellStatus = message.status;
        } catch (error) {
          fail(new Error(`Bash pipe launcher failed: ${Buffer.concat(stderr)}`, { cause: error }));
          return;
        }
      }
      done(
        normalize(
          {
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            status: shellStatus,
            timeout,
            outputLimit,
          },
          [
            [tmp, "$TMP"],
            [home, "$HOME"],
          ],
        ),
      );
    });
  });
}

export function normalize(result, paths) {
  const replace = (bytes) => {
    let text = bytes.toString("latin1");
    for (const [from, to] of paths) text = text.split(from).join(to);
    return Buffer.from(text, "latin1");
  };
  return { ...result, stdout: replace(result.stdout), stderr: replace(result.stderr) };
}
