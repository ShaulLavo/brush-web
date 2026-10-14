import { createRoot, on, ref } from "remix/component";
import type { Handle } from "remix/component";
import { Terminal, TERMINAL_READ_LINES_MAX_ROWS, WebGpuTerminalRenderer } from "ghostty-webgpu";
import type {
  GhosttyWebGpuTerminalOptions,
  GhosttyWebGpuTerminalSubscription,
} from "ghostty-webgpu";
import terminalWasmUrl from "ghostty-webgpu/ghostty-vt.wasm?url";
import terminalBridgeUrl from "ghostty-webgpu/bridge.wasm?url";
import { BrowserSession } from "./session";
import type { Engine } from "./session";
import "./style.css";

interface BrowserTestAccess {
  readonly terminal: Terminal | undefined;
  readLines(): string[];
  visibleLines(): readonly string[];
  snapshot(): {
    engine: Engine;
    state: string;
    error: string | undefined;
    renderer: string | undefined;
    presentation: "frame" | "immediate";
    desynchronized: boolean;
    cols: number;
    rows: number;
    firstFrameMs: number | undefined;
  };
  metrics(): BrowserSession["metrics"] | undefined;
  restart(engine?: Engine): Promise<void>;
  crash(): void;
}

declare global {
  interface Window {
    brushWeb?: BrowserTestAccess;
  }
}

const query = new URLSearchParams(location.search);
const encoder = new TextEncoder();

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "The browser session stopped unexpectedly. Restart the session to continue.";
}

function checkCapabilities(): void {
  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      "This page needs cross-origin isolation. Serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp, then reload.",
    );
  }
  if (typeof SharedArrayBuffer === "undefined" || typeof Atomics.wait !== "function") {
    throw new Error(
      "This browser cannot provide shared worker I/O. Open the demo in a current Chrome, Edge, Firefox, or Safari browser on HTTPS or localhost.",
    );
  }
}

async function openTerminal(host: HTMLElement): Promise<Terminal> {
  const options: GhosttyWebGpuTerminalOptions = {
    accessibility: { label: "Browser shell terminal" },
    appearance: {
      font: { family: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace', size: 14 },
      cursor: { blink: true },
      scrollbackLimit: 5000,
      scrollbackByteLimit: 16 * 1024 * 1024,
    },
    padding: 16,
    presentation: query.get("presentation") === "immediate" ? "immediate" : "frame",
    runtime: {
      kind: "owned",
      options: {
        wasm: new URL(terminalWasmUrl, location.href),
        bridge: new URL(terminalBridgeUrl, location.href),
      },
    },
  };
  if (query.get("renderer") === "canvas") {
    const terminal = await Terminal.create({ ...options, rendererMode: "canvas2d-fill-text" });
    await terminal.open(host);
    return terminal;
  }
  if (!navigator.gpu) {
    const terminal = await Terminal.create(options);
    await terminal.open(host);
    return terminal;
  }
  const terminal = await Terminal.create({
    ...options,
    rendererFactory: (rendererOptions) => WebGpuTerminalRenderer.create(rendererOptions),
  });
  try {
    await terminal.open(host);
    return terminal;
  } catch (cause) {
    terminal.dispose();
    if (!(cause instanceof Error) || cause.name !== "WebGpuUnavailableError") throw cause;
    const fallback = await Terminal.create(options);
    await fallback.open(host);
    return fallback;
  }
}

function Workbench(handle: Handle) {
  const requestedEngine = query.get("engine");
  let engine: Engine =
    requestedEngine === "bashkit" ||
    requestedEngine === "bashkit-terminal" ||
    requestedEngine === "just-bash"
      ? requestedEngine
      : "brush";
  let state = "starting";
  let error: string | undefined;
  let warning: string | undefined;
  let busy = true;
  let host: HTMLElement | undefined;
  let terminal: Terminal | undefined;
  let session: BrowserSession | undefined;
  let subscriptions: GhosttyWebGpuTerminalSubscription[] = [];
  let generation = 0;
  let firstFrameMs: number | undefined;
  let startedAt = 0;
  let hasOutput = false;

  const render = () => {
    if (!handle.signal.aborted) void handle.update();
  };

  function stop() {
    generation++;
    subscriptions.forEach((subscription) => subscription.dispose());
    subscriptions = [];
    session?.dispose();
    terminal?.dispose();
    session = undefined;
    terminal = undefined;
  }

  function fail(cause: unknown, expectedGeneration: number) {
    if (generation !== expectedGeneration || handle.signal.aborted) return;
    error = errorText(cause);
    state = "failed";
    busy = false;
    session?.dispose();
    session = undefined;
    if (terminal?.textarea) terminal.textarea.disabled = true;
    render();
  }

  function receiveState(nextState: string, expectedGeneration: number) {
    if (generation !== expectedGeneration || handle.signal.aborted) return;
    if (nextState.startsWith("warning:")) {
      warning = nextState.slice("warning:".length).trim();
      render();
      return;
    }
    if (!["starting", "ready", "running", "interrupting", "exited"].includes(nextState)) {
      const message = nextState.replace(/^(?:error|failed):\s*/, "");
      fail(message, expectedGeneration);
      return;
    }
    state = nextState;
    busy = nextState === "starting";
    if (terminal?.textarea) terminal.textarea.disabled = busy || nextState === "exited";
    render();
  }

  function wireTerminal(current: Terminal, expectedGeneration: number) {
    current.textarea?.addEventListener(
      "paste",
      (event) => {
        if (
          engine !== "bashkit-terminal" ||
          !/[\r\n]/.test(event.clipboardData?.getData("text/plain") ?? "")
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        warning =
          "Bashkit's native editor cannot safely paste multiple lines. Enter lines separately.";
        render();
      },
      { capture: true },
    );
    subscriptions = [
      current.onData((bytes) => session?.input(bytes)),
      current.onResize(({ cols, rows }) => {
        session?.resize(cols, rows);
        render();
      }),
      current.on("error", ({ cause }) => fail(cause, expectedGeneration)),
      current.onFrame(() => {
        session?.markRendered();
        if (!hasOutput || firstFrameMs !== undefined) return;
        firstFrameMs = performance.now() - startedAt;
        render();
      }),
    ];
  }

  async function start(nextEngine = engine) {
    if (!host || handle.signal.aborted) return;
    stop();
    const expectedGeneration = generation;
    engine = nextEngine;
    state = "starting";
    error = undefined;
    warning = undefined;
    busy = true;
    firstFrameMs = undefined;
    hasOutput = false;
    startedAt = performance.now();
    render();
    try {
      checkCapabilities();
      const current = await openTerminal(host);
      if (generation !== expectedGeneration || handle.signal.aborted) {
        current.dispose();
        return;
      }
      terminal = current;
      if (current.textarea) current.textarea.disabled = true;
      wireTerminal(current, expectedGeneration);
      await createSession(current, expectedGeneration);
    } catch (cause) {
      fail(cause, expectedGeneration);
    }
  }

  async function createSession(current: Terminal, expectedGeneration: number) {
    const grid = current.appearance.grid;
    const created = await BrowserSession.create({
      engine,
      baselineState: query.get("baselineState") === "carry" ? "carry" : "isolated",
      profile:
        query.get("profile") === "1"
          ? "cost"
          : query.get("profile") === "phase"
            ? "phase"
            : undefined,
      trace: query.get("trace") === "1",
      cols: grid.columns,
      rows: grid.rows,
      onOutput(bytes) {
        if (generation !== expectedGeneration || handle.signal.aborted) return;
        try {
          hasOutput = true;
          current.write(bytes);
        } catch (cause) {
          fail(cause, expectedGeneration);
        }
      },
      onState: (nextState) => receiveState(nextState, expectedGeneration),
    });
    if (generation !== expectedGeneration || handle.signal.aborted || state === "failed") {
      created.dispose();
      return;
    }
    session = created;
    const fitted = current.appearance.grid;
    created.resize(fitted.columns, fitted.rows);
    busy = false;
    if (current.textarea) current.textarea.disabled = state === "exited" || state === "failed";
    current.focus();
    render();
  }

  function interrupt() {
    session?.input(encoder.encode("\x03"));
    terminal?.focus();
  }

  async function selectEngine(nextEngine: Engine) {
    if (engine === nextEngine) return;
    await start(nextEngine);
  }

  function readLines() {
    if (!terminal) return [];
    let result: string[] = [];
    const count = terminal.lineCount();
    for (let start = 0; start < count; start += TERMINAL_READ_LINES_MAX_ROWS) {
      result = result.concat(
        terminal
          .readLines(start, Math.min(count, start + TERMINAL_READ_LINES_MAX_ROWS))
          .map((line) => line.text),
      );
    }
    return result;
  }

  function exposeTests() {
    if (query.get("test") !== "1") return;
    window.brushWeb = {
      get terminal() {
        return terminal;
      },
      readLines,
      visibleLines: () => terminal?.visibleLines() ?? [],
      snapshot: () => ({
        engine,
        state,
        error,
        renderer: terminal?.diagnostics.rendererBackend,
        presentation: query.get("presentation") === "immediate" ? "immediate" : "frame",
        desynchronized: terminal?.diagnostics.desynchronized ?? false,
        cols: terminal?.appearance.grid.columns ?? 0,
        rows: terminal?.appearance.grid.rows ?? 0,
        firstFrameMs,
      }),
      metrics: () => session?.metrics,
      restart: start,
      crash: () => session?.crash(),
    };
  }

  const mount = (node: Element, signal: AbortSignal) => {
    if (!(node instanceof HTMLElement)) return;
    host = node;
    exposeTests();
    signal.addEventListener("abort", stop, { once: true });
    void start();
  };

  handle.signal.addEventListener(
    "abort",
    () => {
      stop();
      delete window.brushWeb;
    },
    { once: true },
  );

  return () => (
    <main class="workbench">
      <header class="topbar">
        <a
          class="brand"
          href="https://github.com/ShaulLavo/brush-web"
          target="_blank"
          rel="noreferrer"
        >
          <span class="brand-symbol" aria-hidden="true">
            &gt;_
          </span>
          <span>
            brush<span class="brand-muted">-web</span>
          </span>
        </a>
        <span class="tagline">A shell in your browser.</span>
        <span class="browser-badge">Runs locally</span>
      </header>

      <section class="shell-panel" aria-label="Shell workbench">
        <div class="shell-toolbar">
          <div class="engine-picker" role="group" aria-label="Shell engine">
            <button
              type="button"
              aria-pressed={engine === "brush"}
              disabled={busy}
              mix={on("click", () => selectEngine("brush"))}
            >
              Brush <span class="engine-detail">Rust · WASM</span>
            </button>
            <button
              type="button"
              aria-pressed={engine === "just-bash"}
              disabled={busy}
              mix={on("click", () => selectEngine("just-bash"))}
            >
              just-bash <span class="engine-detail">baseline</span>
            </button>
            <button
              type="button"
              aria-pressed={engine === "bashkit"}
              disabled={busy}
              mix={on("click", () => selectEngine("bashkit"))}
            >
              Bashkit <span class="engine-detail">published scripts</span>
            </button>
            <button
              type="button"
              aria-pressed={engine === "bashkit-terminal"}
              disabled={busy}
              mix={on("click", () => selectEngine("bashkit-terminal"))}
            >
              Bashkit <span class="engine-detail">native terminal</span>
            </button>
          </div>
          <div class="session-actions">
            <button
              type="button"
              class="quiet-button"
              disabled={busy || !session}
              mix={on("click", interrupt)}
            >
              Interrupt <kbd>^C</kbd>
            </button>
            <button
              type="button"
              class="quiet-button"
              disabled={busy}
              title="Start a fresh session. Files and shell state are cleared."
              mix={on("click", () => start())}
            >
              Restart
            </button>
          </div>
        </div>

        {engine === "just-bash" && (
          <div class="baseline-note">
            {query.get("baselineState") === "carry"
              ? "Files, scalar values and ordinary cwd carry between commands. Functions, arrays, shell options and exit status reset."
              : "Files persist. Cwd, variables, functions, aliases, and exit status reset after each command."}
            {" Output appears when the command finishes."}
          </div>
        )}
        {engine === "bashkit" && (
          <div class="baseline-note">
            Experimental: variables, functions, arrays and cwd persist; prior exit status resets.
            Collected output. CPU loops may delay Ctrl+C. Command completion only; live stdin is
            unavailable.
          </div>
        )}
        {engine === "bashkit-terminal" && (
          <div class="baseline-note">
            Experimental source API: native editing, live input and streaming output. CPU loops may
            delay Ctrl+C. Tab completion is unavailable; multiline paste is blocked.
          </div>
        )}

        {error && (
          <div class="error-banner" role="alert">
            <strong>Session stopped</strong>
            <p>{error}</p>
            <button type="button" mix={on("click", () => start())}>
              Restart session
            </button>
          </div>
        )}

        {warning && (
          <div class="warning-banner" role="status">
            <span>{warning}</span>
            <button
              type="button"
              aria-label="Dismiss notice"
              mix={on("click", () => {
                warning = undefined;
                render();
              })}
            >
              Dismiss
            </button>
          </div>
        )}

        <div class="terminal-container">
          <div class="terminal-host" data-testid="terminal" mix={ref(mount)} />
          {busy && (
            <div class="loading-overlay" role="status">
              <span class="loading-dot" />
              Starting{" "}
              {engine === "brush" ? "Brush" : engine === "just-bash" ? "just-bash" : "Bashkit"}…
            </div>
          )}
        </div>

        <footer class="terminal-status" aria-label="Session status">
          <span class={`state-indicator ${state === "failed" ? "state-failed" : ""}`}>
            <span aria-hidden="true" />
            <span data-testid="session-state">{state}</span>
          </span>
          <span class="renderer-label" data-testid="renderer">
            {terminal?.diagnostics.rendererBackend === "webgpu"
              ? "WebGPU"
              : `${terminal?.diagnostics.rendererBackend ?? "Ghostty"}${terminal ? " · fallback renderer" : ""}`}
          </span>
          <span class="terminal-dimensions">
            {terminal
              ? `${terminal.appearance.grid.columns} × ${terminal.appearance.grid.rows}`
              : ""}
          </span>
        </footer>
      </section>

      <div class="below-terminal">
        <p class="keyboard-hint">
          <kbd>Tab</kbd> complete <span>·</span> <kbd>↑</kbd> history <span>·</span>{" "}
          <kbd>Ctrl C</kbd> interrupt <span>·</span> <kbd>Ctrl D</kbd> EOF
        </p>
        <details class="help">
          <summary>Try a few things</summary>
          <div class="help-content">
            <p>
              {engine !== "just-bash"
                ? "Shell state and files stay in this session."
                : "Files stay in this session. Each submitted command starts with fresh shell state."}{" "}
              Restarting or switching engines starts fresh.
            </p>
            <dl>
              <div>
                <dt>
                  <code>help</code>
                </dt>
                <dd>Available commands</dd>
              </div>
              <div>
                <dt>
                  <code>export NAME=world; echo "hello $NAME"</code>
                </dt>
                <dd>
                  {engine !== "just-bash"
                    ? "Persistent environment"
                    : "Environment within one command"}
                </dd>
              </div>
              <div>
                <dt>
                  <code>printf 'one\ntwo\n' &gt; notes; cat notes</code>
                </dt>
                <dd>Files and redirection</dd>
              </div>
              {engine === "brush" && (
                <div>
                  <dt>
                    <code>keydemo</code>
                  </dt>
                  <dd>Keys, terminal drawing, and live resize. Press q to exit.</dd>
                </div>
              )}
            </dl>
          </div>
        </details>
      </div>
    </main>
  );
}

const rootElement = document.getElementById("app");
if (!rootElement) throw new Error("Missing browser workbench mount");
const root = createRoot(rootElement);
root.render(<Workbench />);
window.addEventListener("pagehide", () => root.dispose(), { once: true });
