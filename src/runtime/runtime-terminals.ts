// Adapted from bun-wasm web/src/runtime-terminals.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Replaced callback/EOF terminals with inherited bounded shared terminal endpoints.
import { OpenDescription, type DescriptorTable, type Stream } from "@bun-wasm/runtime/core";
import { ProcessError } from "@bun-wasm/runtime/proc/types";
import type { WorkerDescriptorCodec } from "@bun-wasm/runtime/proc/worker-client";
import { SharedBridge, control } from "../bridge";

type TerminalTarget = 0 | 1 | 2;
interface TerminalToken {
  kind: "web-terminal";
  target: TerminalTarget;
  buffer: SharedArrayBuffer;
}
// Descriptor remapping must preserve endpoint identity, not reinterpret its current fd number.
const targets = new WeakMap<Stream, TerminalToken>();
const AGAIN = -6;

export function createBridgeTerminal(
  buffer: SharedArrayBuffer,
  target: TerminalTarget,
  checkActive: () => void = () => {},
): Stream {
  const bridge = new SharedBridge(buffer);
  const notification = new Int32Array(buffer, control.wake * 4, 1);
  const tryRead = (chunks: readonly Uint8Array[]) => {
    checkActive();
    return target === 0 ? bridge.tryRead(chunks) : -8;
  };
  const tryWrite = (chunks: readonly Uint8Array[]) => {
    checkActive();
    return target === 0 ? -8 : bridge.tryWrite(chunks);
  };
  // Preview1 can block in a guest worker. runtime_proc uses only the immediate operations.
  const blocking = (
    operation: (chunks: readonly Uint8Array[]) => number,
    chunks: readonly Uint8Array[],
  ) => {
    for (;;) {
      const sequence = Atomics.load(notification, 0);
      const result = operation(chunks);
      if (result !== AGAIN) return result;
      Atomics.wait(notification, 0, sequence, 10);
    }
  };
  const stream: Stream = {
    kind: "terminal",
    notification,
    tryRead,
    tryWrite,
    read: (chunks) => blocking(tryRead, chunks),
    write: (chunks) => blocking(tryWrite, chunks),
    readiness() {
      checkActive();
      const pending =
        (Atomics.load(bridge.state, control.outputWrite) -
          Atomics.load(bridge.state, control.outputRead)) >>>
        0;
      return {
        readable: target === 0 && (bridge.availableInput() !== 0 || bridge.closed()),
        writable: target !== 0 && !bridge.closed() && pending < bridge.output.length,
        hangup: bridge.closed(),
        nbytes: target === 0 ? bridge.availableInput() : bridge.output.length - pending,
      };
    },
  };
  targets.set(stream, { kind: "web-terminal", target, buffer });
  return stream;
}

export interface RuntimeTerminalCodecOptions {
  fallback: WorkerDescriptorCodec;
  descriptors?: DescriptorTable;
  output?(fd: 1 | 2, data: Uint8Array): void;
  checkActive?(): void;
}
function terminalToken(value: unknown): TerminalToken | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "web-terminal"
  )
    return;
  if (
    !("target" in value) ||
    (value.target !== 0 && value.target !== 1 && value.target !== 2) ||
    !("buffer" in value) ||
    !(value.buffer instanceof SharedArrayBuffer)
  )
    throw new TypeError("invalid browser terminal endpoint");
  return value as TerminalToken;
}
export function createRuntimeTerminalCodec(
  options: RuntimeTerminalCodecOptions,
): WorkerDescriptorCodec {
  return {
    export(descriptor, pid) {
      if (descriptor.resource.kind !== "terminal") return options.fallback.export(descriptor, pid);
      const token = targets.get(descriptor.resource);
      if (!token) throw new ProcessError(52, "terminal has no transferable browser endpoint");
      return token;
    },
    import(value, pid) {
      const token = terminalToken(value);
      if (!token) return options.fallback.import(value, pid);
      return new OpenDescription(
        createBridgeTerminal(token.buffer, token.target, options.checkActive),
      );
    },
    discard(value) {
      // Closing one inherited terminal must not close other processes' terminal endpoints.
      if (!terminalToken(value)) options.fallback.discard(value);
    },
  };
}
