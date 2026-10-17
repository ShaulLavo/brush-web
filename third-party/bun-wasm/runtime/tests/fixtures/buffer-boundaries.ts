import { spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";

type MutableBuffer = ArrayBufferLike & { resizable?: boolean; growable?: boolean };
type BufferConstructor = new (length: number, options?: { maxByteLength: number }) => MutableBuffer;

const backingKinds = ["fixed", "resizable"].concat(
  typeof SharedArrayBuffer === "undefined" ? [] : ["shared"],
  typeof SharedArrayBuffer !== "undefined" && Reflect.get(new (SharedArrayBuffer as unknown as BufferConstructor)(1, { maxByteLength: 2 }), "growable") ? ["growable"] : [],
);
export const bufferKinds = backingKinds.concat(["fixed cross-realm"], backingKinds.filter(kind => kind !== "fixed").map(kind => `${kind} Buffer`));

/** Junk before and after a nonzero-offset, explicitly bounded caller view. */
export function callerSpan(bytes: Uint8Array, kind: string): Uint8Array {
  const bufferView = kind.endsWith(" Buffer");
  const foreign = kind.endsWith(" cross-realm");
  kind = kind.split(" ")[0]!;
  const length = bytes.length + 19;
  const OrdinaryBuffer = foreign ? runInNewContext("ArrayBuffer") : ArrayBuffer;
  const Constructor = (kind === "shared" || kind === "growable" ? SharedArrayBuffer : OrdinaryBuffer) as BufferConstructor;
  const storage = kind === "fixed" || kind === "shared" ? new Constructor(length)
    : new Constructor(length, { maxByteLength: length * 2 });
  new Uint8Array(storage).fill(0xff);
  const span = new Uint8Array(storage, 7, bytes.length);
  span.set(bytes);
  return bufferView ? Buffer.from(storage, span.byteOffset, span.byteLength) : span;
}

/** Enforce WebIDL's missing AllowResizable on hosts with a permissive native decoder. */
export function withStrictDecoder(run: (backings: ArrayBufferLike[]) => void): void {
  const nativeDecode = TextDecoder.prototype.decode;
  const backings: ArrayBufferLike[] = [];
  const strict = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
    const backing = ArrayBuffer.isView(input) ? input.buffer : input;
    if (backing) {
      if (Reflect.get(backing, "resizable") || Reflect.get(backing, "growable")) throw new TypeError("resizable or growable BufferSource is not allowed");
      backings.push(backing);
    }
    return nativeDecode.call(this, input, options);
  });
  try { run(backings); }
  finally { strict.mockRestore(); }
}
