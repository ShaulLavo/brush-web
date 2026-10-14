import type { CommandName } from "just-bash/browser";
import { control, SharedBridge } from "./bridge";
import { BaselineOutput } from "./baseline-output";
import { createBaselineShell } from "./baseline-session";
import type { BaselineOptions, BaselineShell } from "./baseline-session";
import type { ExecutionProfile } from "./execution-profile";

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LINE_LIMIT = 256 * 1024;
const commands: CommandName[] = [
  "echo",
  "printf",
  "cat",
  "ls",
  "mkdir",
  "rmdir",
  "pwd",
  "rm",
  "touch",
  "cp",
  "mv",
  "head",
  "tail",
  "wc",
  "grep",
  "sort",
  "uniq",
  "tr",
  "tee",
  "sed",
  "awk",
  "seq",
  "sleep",
  "true",
  "false",
  "yes",
  "clear",
  "help",
  "env",
  "printenv",
  "alias",
  "unalias",
  "history",
  "bash",
  "sh",
  "which",
  "find",
  "basename",
  "dirname",
  "date",
  "expr",
  "whoami",
  "hostname",
  "time",
  "timeout",
];
const commandNames: string[] = ["cd", "export", "unset", "exit"].concat(commands);

type ReadResult = { kind: "command"; command: string } | { kind: "interrupt" } | { kind: "eof" };

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (entry) => entry.segment);
}

function cellWidth(text: string): number {
  if (/\p{Extended_Pictographic}/u.test(text)) return 2;
  const code = text.codePointAt(0) ?? 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      code >= 0x20000)
  )
    return 2;
  return 1;
}

function point(text: string, columns: number) {
  let row = 0;
  let column = 0;
  for (const part of graphemes(text)) {
    if (part === "\n") {
      row++;
      column = 0;
      continue;
    }
    const width = cellWidth(part);
    if (column + width > columns) {
      row++;
      column = 0;
    }
    column += width;
  }
  return { row, column };
}

function caret(text: string, columns: number) {
  const position = point(text, columns);
  if (position.column === columns) return { row: position.row + 1, column: 0 };
  return position;
}

function terminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function write(bridge: SharedBridge, text: string) {
  bridge.write(encoder.encode(text));
}

async function waitForInput(bridge: SharedBridge): Promise<void> {
  if (bridge.availableInput() || bridge.cancelled() || bridge.closed()) return;
  const wake = Atomics.load(bridge.state, control.wake);
  if (bridge.availableInput() || bridge.cancelled() || bridge.closed()) return;
  await Atomics.waitAsync(bridge.state, control.wake, wake, 100).value;
}

function acknowledgeInterrupt(bridge: SharedBridge) {
  Atomics.store(bridge.state, control.inputRead, Atomics.load(bridge.state, control.inputWrite));
  Atomics.store(bridge.state, control.cancel, 0);
  Atomics.store(bridge.state, control.status, 130);
}

function cancellation(bridge: SharedBridge) {
  const controller = new AbortController();
  const reason = new DOMException("Shell command interrupted", "AbortError");
  const signal = new Proxy(controller.signal, {
    get(target, key) {
      if (key === "aborted") return target.aborted || bridge.cancelled() || bridge.closed();
      if (key === "reason" && (bridge.cancelled() || bridge.closed())) return reason;
      if (key === "throwIfAborted")
        return () => {
          if (target.aborted || bridge.cancelled() || bridge.closed()) throw reason;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const timer = setInterval(() => {
    if (bridge.cancelled() || bridge.closed()) controller.abort(reason);
  }, 10);
  return { signal, dispose: () => clearInterval(timer) };
}

class BaselineEditor {
  private parts: string[] = [];
  private cursor = 0;
  private cursorRow = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private savedLine = "";
  private pending = "";
  private pasting = false;
  private inputLimitReported = false;
  private resize = -1;
  private readonly decoder = new TextDecoder();

  private get prompt() {
    return `just-bash:${this.shell.cwd}$ `;
  }

  constructor(
    private readonly bridge: SharedBridge,
    private readonly shell: BaselineShell,
  ) {}

  private redraw() {
    const columns = Math.max(2, Atomics.load(this.bridge.state, control.cols));
    const text = this.parts.join("");
    const end = point(this.prompt + text + " ", columns);
    const cursor = caret(this.prompt + this.parts.slice(0, this.cursor).join(""), columns);
    const rewind = this.cursorRow ? `\x1b[${this.cursorRow}A` : "";
    const up = end.row > cursor.row ? `\x1b[${end.row - cursor.row}A` : "";
    const right = cursor.column ? `\x1b[${cursor.column}C` : "";
    write(this.bridge, `${rewind}\r\x1b[J${this.prompt}${terminalText(text)} ${up}\r${right}`);
    this.cursorRow = cursor.row;
  }

  private insert(text: string) {
    if (this.parts.join("").length + text.length > LINE_LIMIT / 4) {
      if (!this.inputLimitReported) {
        write(
          this.bridge,
          "\r\nInput exceeds the 256 KiB editor limit. Use a smaller selection.\r\n",
        );
        this.cursorRow = 0;
        this.inputLimitReported = true;
      }
      return;
    }
    const clean = text
      .replace(/\r\n|\r/g, "\n")
      .replace(/\t/g, "    ")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    const before = this.parts.slice(0, this.cursor).join("") + clean;
    this.parts = graphemes(before + this.parts.slice(this.cursor).join(""));
    this.cursor = graphemes(before).length;
  }

  private chooseHistory(delta: number) {
    if (this.historyIndex === this.history.length) this.savedLine = this.parts.join("");
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    this.parts = graphemes(this.history[this.historyIndex] ?? this.savedLine);
    this.cursor = this.parts.length;
  }

  private async complete() {
    const before = this.parts.slice(0, this.cursor).join("");
    const token = before.match(/[^\s;|&]*$/)?.[0] ?? "";
    if (!token || /['"\\$]/.test(token)) {
      write(this.bridge, "\x07");
      return;
    }
    const slash = token.lastIndexOf("/");
    const directory = slash < 0 ? "" : token.slice(0, slash + 1);
    const prefix = token.slice(slash + 1);
    const atCommand = before.trim() === token;
    const fs = this.shell.fs;
    const cwd = this.shell.cwd;
    const entries = await fs
      .readdirWithFileTypes(directory ? fs.resolvePath(cwd, directory) : cwd)
      .catch(() => []);
    const files = entries
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => `${directory}${entry.name}${entry.isDirectory ? "/" : ""}`);
    const commands =
      atCommand && slash < 0 ? commandNames.filter((name) => name.startsWith(token)) : [];
    const matches = Array.from(new Set(files.concat(commands)));
    matches.sort();
    if (matches.length === 1) {
      this.insert(matches[0].slice(token.length) + (matches[0].endsWith("/") ? "" : " "));
      return;
    }
    if (!matches.length) {
      write(this.bridge, "\x07");
      return;
    }
    write(this.bridge, `\r\n${matches.slice(0, 100).join("  ")}\r\n`);
    this.cursorRow = 0;
  }

  private editKey(key: string) {
    if (key === "\x01" || key === "\x1b[H" || key === "\x1b[1~" || key === "\x1bOH")
      this.cursor = 0;
    if (key === "\x05" || key === "\x1b[F" || key === "\x1b[4~" || key === "\x1bOF")
      this.cursor = this.parts.length;
    if (key === "\x02" || key === "\x1b[D" || key === "\x1bOD")
      this.cursor = Math.max(0, this.cursor - 1);
    if (key === "\x06" || key === "\x1b[C" || key === "\x1bOC")
      this.cursor = Math.min(this.parts.length, this.cursor + 1);
    if (key === "\x1b[A" || key === "\x1bOA") this.chooseHistory(-1);
    if (key === "\x1b[B" || key === "\x1bOB") this.chooseHistory(1);
    if (key === "\x7f" || key === "\x08") {
      if (this.cursor) this.parts.splice(--this.cursor, 1);
    }
    if (key === "\x04" || key === "\x1b[3~") this.parts.splice(this.cursor, 1);
    if (key === "\x0b") this.parts.splice(this.cursor);
    if (key === "\x15") {
      this.parts.splice(0, this.cursor);
      this.cursor = 0;
    }
  }

  private consumePaste(): boolean {
    const end = this.pending.indexOf("\x1b[201~");
    if (end >= 0) {
      this.insert(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 6);
      this.pasting = false;
      return true;
    }
    const safe = Math.max(0, this.pending.length - 5);
    this.insert(this.pending.slice(0, safe));
    this.pending = this.pending.slice(safe);
    return false;
  }

  private async consume(): Promise<ReadResult | undefined> {
    while (this.pending.length) {
      if (this.bridge.cancelled()) {
        this.pending = "";
        return { kind: "interrupt" };
      }
      const paste = this.pasting;
      if (paste && !this.consumePaste()) break;
      if (paste) continue;
      if (this.pending.startsWith("\x1b[200~")) {
        this.pending = this.pending.slice(6);
        this.pasting = true;
        continue;
      }
      const text = this.pending.match(/^[^\x00-\x1f\x7f]+/)?.[0];
      if (text) {
        this.insert(text);
        this.pending = this.pending.slice(text.length);
        continue;
      }
      const key = this.nextKey();
      if (!key) break;
      if (key === "\r" || key === "\n") return this.submit();
      if (key === "\x04" && !this.parts.length) return { kind: "eof" };
      if (key === "\x03") return { kind: "interrupt" };
      if (key === "\t") {
        await this.complete();
        continue;
      }
      this.editKey(key);
    }
    this.redraw();
    return undefined;
  }

  private nextKey(): string | undefined {
    if (this.pending[0] !== "\x1b") {
      const key = String.fromCodePoint(this.pending.codePointAt(0) ?? 0);
      this.pending = this.pending.slice(key.length);
      return key;
    }
    const key = this.pending.match(/^\x1b(?:\[[0-9;?]*[\x40-\x7e]|O.)/)?.[0];
    if (!key && this.pending.length < 32) return undefined;
    this.pending = this.pending.slice(key?.length ?? 1);
    return key ?? "\x1b";
  }

  private submit(): ReadResult {
    const command = this.parts.join("");
    this.cursor = this.parts.length;
    this.redraw();
    write(this.bridge, "\r\n");
    if (command.trim()) {
      this.history.push(command);
      if (this.history.length > 200) this.history.shift();
    }
    return { kind: "command", command };
  }

  async read(): Promise<ReadResult> {
    this.parts = [];
    this.cursor = 0;
    this.cursorRow = 0;
    this.historyIndex = this.history.length;
    this.pasting = false;
    this.inputLimitReported = false;
    this.redraw();
    while (!this.bridge.closed()) {
      if (this.bridge.cancelled()) {
        this.pending = "";
        return { kind: "interrupt" };
      }
      const resized = Atomics.load(this.bridge.state, control.resize);
      if (resized !== this.resize) {
        this.resize = resized;
        const columns = Math.max(2, Atomics.load(this.bridge.state, control.cols));
        this.cursorRow = caret(
          this.prompt + this.parts.slice(0, this.cursor).join(""),
          columns,
        ).row;
        this.redraw();
      }
      const bytes = this.bridge.receive(65536);
      this.pending += this.decoder.decode(bytes, { stream: true });
      const result = this.pending.length ? await this.consume() : undefined;
      if (result) return result;
      await waitForInput(this.bridge);
    }
    return { kind: "eof" };
  }
}

async function execute(
  shell: BaselineShell,
  bridge: SharedBridge,
  output: BaselineOutput,
  command: string,
  profile?: ExecutionProfile,
) {
  Atomics.store(bridge.state, control.phase, 2);
  const cancel = cancellation(bridge);
  profile?.start();
  try {
    const result = await shell.exec(command, cancel.signal);
    const interrupted = bridge.cancelled();
    if (!interrupted) output.result(result.stdout, result.stderr);
    Atomics.store(bridge.state, control.status, interrupted ? 130 : result.exitCode);
  } catch (cause) {
    if (!bridge.cancelled() && !bridge.closed()) {
      write(bridge, `${cause instanceof Error ? cause.message : "just-bash execution failed"}\r\n`);
      Atomics.store(bridge.state, control.status, 1);
    }
  } finally {
    cancel.dispose();
  }
  if (bridge.cancelled()) {
    acknowledgeInterrupt(bridge);
    write(bridge, "^C\r\n");
  }
  profile?.finish();
}

export async function startBaseline(
  bridge: SharedBridge,
  options: BaselineOptions = { state: "isolated" },
  profile?: ExecutionProfile,
): Promise<void> {
  const shell = createBaselineShell({ ...options, commands });
  const editor = new BaselineEditor(bridge, shell);
  const output = new BaselineOutput((bytes) => bridge.write(bytes));
  const stateNotice =
    options.state === "carry"
      ? "Scalar values, ordinary PWD-based cwd, and alias data carry between commands. Functions, arrays, options, and $? reset."
      : "Files persist; cwd, variables, functions, aliases, and $? reset per command.";
  write(
    bridge,
    `\x1b[?2004h\x1b[?2027hjust-bash ${options.state} baseline. ${stateNotice}\r\nOutput is returned after each command completes.\r\n\r\n`,
  );
  while (!bridge.closed()) {
    Atomics.store(bridge.state, control.phase, 1);
    const input = await editor.read();
    if (input.kind === "eof") break;
    if (input.kind === "interrupt") {
      acknowledgeInterrupt(bridge);
      write(bridge, "^C\r\n");
      continue;
    }
    await execute(shell, bridge, output, input.command, profile);
  }
  write(bridge, "\x1b[?2004l\x1b[?2027l\r\nSession ended.\r\n");
  Atomics.store(bridge.state, control.phase, 3);
}
