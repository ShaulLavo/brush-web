// Standalone application entry. An embedding can import ./shell instead and supply its own peer.
export { createBrowserRuntime, BrowserRuntime } from "./runtime/browser-runtime";
export type { BrowserRuntimeOptions } from "./runtime/browser-runtime";
export { createShell } from "./shell";
export type { Shell, ShellOptions, ShellRuntimePeer, RuntimeProcess, RuntimeExit } from "./shell";
