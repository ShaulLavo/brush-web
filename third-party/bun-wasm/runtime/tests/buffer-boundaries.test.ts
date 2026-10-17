import { expect, test } from "bun:test";
import { decode, encode } from "../fs/memory";
import { pack, unpack } from "../fs/protocol";
import { bufferKinds, callerSpan, withStrictDecoder } from "./fixtures/buffer-boundaries";

for (const kind of bufferKinds) {
  test(`filesystem decode accepts only the selected ${kind} buffer span`, () => {
    const text = "日本語 café 🌍";
    const span = callerSpan(encode(text), kind);
    withStrictDecoder(backings => {
      expect(decode(span)).toBe(text);
      expect(backings).toHaveLength(1);
      if (kind.startsWith("fixed")) expect(backings[0]).toBe(span.buffer);
      else expect(backings[0]).not.toBe(span.buffer);
    });
  });

  test(`filesystem unpack preserves reviver semantics from a ${kind} buffer span`, () => {
    const value = { text: "日本語 café 🌍", entries: new Map([["clé", "値"]]), absent: undefined, array: [undefined, "é"] };
    const span = callerSpan(pack(value), kind);
    withStrictDecoder(backings => {
      const decoded = unpack(span);
      expect(decoded.text).toBe(value.text);
      expect(decoded.entries).toBeInstanceOf(Map);
      expect(decoded.entries).toEqual(value.entries);
      expect(Object.hasOwn(decoded, "absent")).toBe(false);
      expect(decoded.array).toHaveLength(2);
      expect(Object.hasOwn(decoded.array, 0)).toBe(false);
      expect(decoded.array[1]).toBe("é");
      expect(backings).toHaveLength(1);
      if (kind.startsWith("fixed")) expect(backings[0]).toBe(span.buffer);
      else expect(backings[0]).not.toBe(span.buffer);
    });
  });
}

test("strict decoder rejects resizable and growable backing and restores the native method", () => {
  const nativeDecode = TextDecoder.prototype.decode;
  withStrictDecoder(() => {
    for (const kind of bufferKinds.filter(kind => kind === "resizable" || kind === "growable")) {
      expect(() => new TextDecoder().decode(callerSpan(encode("é"), kind))).toThrow("resizable or growable BufferSource is not allowed");
    }
  });
  expect(TextDecoder.prototype.decode).toBe(nativeDecode);
});
