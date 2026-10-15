import type { DirNode } from "../third-party/bun-wasm/fs";
import type { ProcessTransport } from "./process-transport";

export type SpawnMetadata = {
  executable: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
};
export type SpawnRequest = SpawnMetadata & {
  kind: "external-spawn";
  root: DirNode;
  transport: ProcessTransport;
};
export type ChildRequest = SpawnRequest & { module: WebAssembly.Module };
export type ProcessSample = {
  kind: "external-complete";
  executable: string;
  startedAt: number;
  firstOutputAt: number;
  finishedAt: number;
};

export function decodeSpawn(bytes: Uint8Array): SpawnMetadata {
  if (bytes.length > 1048576) throw new Error("Spawn metadata exceeds 1 MiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  const number = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    if (value > bytes.length) throw new Error("Invalid spawn length");
    return value;
  };
  const text = () => {
    const length = number();
    if (offset + length > bytes.length) throw new Error("Truncated spawn metadata");
    const value = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const executable = text();
  const cwd = text();
  const argv = [text()].concat(Array.from({ length: number() }, text));
  const env = Object.fromEntries(Array.from({ length: number() }, () => [text(), text()]));
  if (offset !== bytes.length) throw new Error("Trailing spawn metadata");
  return { executable, cwd, argv, env };
}
