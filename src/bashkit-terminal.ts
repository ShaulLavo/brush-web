import init, { Terminal } from "bashkit-terminal-source";
import wasmUrl from "bashkit-terminal-source/bashkit_wasm_bg.wasm?url";
import { SharedBridge, control } from "./bridge";
import { ExecutionProfile, profileFields } from "./execution-profile";
import { markStartup } from "./startup";

function parseStatus(value: unknown): { status: "idle" } | { status: "exited"; exitCode: number } {
  if (typeof value !== "object" || value === null || !("status" in value))
    throw new Error("Bashkit Terminal returned an invalid status");
  if (value.status === "idle") return { status: "idle" };
  if (
    value.status === "exited" &&
    "exitCode" in value &&
    typeof value.exitCode === "number" &&
    Number.isInteger(value.exitCode)
  )
    return { status: "exited", exitCode: value.exitCode };
  throw new Error("Bashkit Terminal returned an invalid exit status");
}

export async function createTerminalSession(bridge: SharedBridge, profile?: ExecutionProfile) {
  if (typeof Atomics.waitAsync !== "function")
    throw new Error("Bashkit Terminal needs Atomics.waitAsync in this comparison adapter.");
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Bashkit Terminal WASM fetch failed (${response.status})`);
  markStartup("wasmResponse");
  const wasmBytes = Number(response.headers.get("content-length") ?? 0);
  // Compile separately so startup timing can split compilation from instantiation.
  const module = await WebAssembly.compileStreaming(response);
  markStartup("compiled");
  const exports = await init({ module_or_path: module });
  markStartup("instantiated");
  const terminal = new Terminal({
    rows: Atomics.load(bridge.state, control.rows),
    cols: Atomics.load(bridge.state, control.cols),
    profile: "interactive",
    cwd: "/home/user",
    env: { HOME: "/home/user", TERM: "xterm-256color" },
    files: { "/home/user/welcome.txt": "Files and commands run inside this browser.\n" },
    maxCommands: 10000000,
    maxLoopIterations: 10000000,
    maxMemory: 32 * 1024 * 1024,
    timeoutMs: 60000,
  });
  markStartup("shellCreated");
  let running: Promise<void> | undefined;
  let failure: unknown;
  let exited = false;
  let resize = Atomics.load(bridge.state, control.resize);

  function drain() {
    const started = performance.now();
    const bytes = terminal.takeOutput();
    profile?.add(profileFields.hostCopyMs, performance.now() - started);
    profile?.add(profileFields.hostCopyBytes, bytes.length);
    if (bytes.length) {
      profile?.add(profileFields.writes);
      profile?.add(profileFields.writeBytes, bytes.length);
      bridge.write(bytes);
    }
    Atomics.store(bridge.state, control.memory, exports.memory.buffer.byteLength);
  }

  function drive() {
    if (running || exited) return;
    running = terminal
      .runUntilIdle()
      .then((value: unknown) => {
        const result = parseStatus(value);
        drain();
        profile?.finish();
        exited = result.status === "exited";
        if (result.status === "exited")
          Atomics.store(bridge.state, control.status, result.exitCode);
        Atomics.store(bridge.state, control.phase, exited ? 3 : 1);
      })
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        running = undefined;
      });
  }

  function input() {
    if (bridge.cancelled()) {
      Atomics.store(
        bridge.state,
        control.inputRead,
        Atomics.load(bridge.state, control.inputWrite),
      );
      terminal.sendBytes(new Uint8Array([3]));
      Atomics.store(bridge.state, control.cancel, 0);
      drive();
      return;
    }
    if (!bridge.availableInput()) return;
    const bytes = bridge.receive(65536);
    if (bytes.includes(13) || bytes.includes(10)) {
      if (!profile?.active) profile?.start();
      Atomics.store(bridge.state, control.phase, 2);
    }
    profile?.add(profileFields.reads);
    profile?.add(profileFields.readBytes, bytes.length);
    const accepted = terminal.sendBytes(bytes);
    if (accepted !== bytes.length)
      throw new Error(`Bashkit Terminal accepted ${accepted} of ${bytes.length} input bytes.`);
    drive();
  }

  function dimensions() {
    const next = Atomics.load(bridge.state, control.resize);
    if (next === resize) return;
    resize = next;
    terminal.resize(
      Atomics.load(bridge.state, control.rows),
      Atomics.load(bridge.state, control.cols),
    );
    drive();
  }

  async function run() {
    drive();
    try {
      while (!bridge.closed() && !exited) {
        if (failure !== undefined) throw failure;
        const wake = Atomics.load(bridge.state, control.wake);
        dimensions();
        input();
        drain();
        await Atomics.waitAsync(bridge.state, control.wake, wake, 8).value;
      }
      drain();
    } finally {
      // A running promise owns the terminal until its final poll. Main-thread disposal terminates the worker.
      if (!running) terminal.free();
    }
  }
  return { wasmBytes, run };
}
