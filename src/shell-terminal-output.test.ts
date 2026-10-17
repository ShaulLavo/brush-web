import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalNewlines } from "./shell-terminal-output.ts";

const encoder = new TextEncoder();
function present(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new TerminalNewlines();
  const result: Uint8Array[] = [];
  for (const chunk of chunks) output.write(chunk, (bytes) => result.push(bytes));
  return Buffer.concat(result);
}

test("own-shell display puts each LF-only producer progress line at column zero", () => {
  // CI 39026428167 showed WRITTEN lines walking right by ten columns each;
  // eventually DRAINED:5242880 wrapped into two rows and disappeared as a line.
  const source = encoder.encode("WRITTEN:1\nWRITTEN:2\nWRITTEN:3\nDRAINED:5242880\n");
  assert.equal(
    Buffer.from(present([source])).toString(),
    "WRITTEN:1\r\nWRITTEN:2\r\nWRITTEN:3\r\nDRAINED:5242880\r\n",
  );
});

test("CRLF split across any bridge drain is not doubled; lone LF is normalized", () => {
  const source = encoder.encode("one\r\ntwo\nthree\rfour\r\n\n");
  const expected = encoder.encode("one\r\ntwo\r\nthree\rfour\r\n\r\n");
  for (let split = 0; split <= source.length; split++) {
    assert.deepEqual(
      present([source.subarray(0, split), new Uint8Array(), source.subarray(split)]),
      Buffer.from(expected),
      `split ${split}`,
    );
  }
  assert.deepEqual(
    present(Array.from(source, (byte) => Uint8Array.of(byte))),
    Buffer.from(expected),
  );
});

test("presentation preserves NUL, every non-LF byte and split invalid/incomplete UTF-8", () => {
  const source = Uint8Array.from({ length: 256 }, (_, byte) => byte);
  const original = source.slice();
  const expected = Buffer.concat([source.subarray(0, 10), Uint8Array.of(13), source.subarray(10)]);
  assert.deepEqual(present(Array.from(source, (byte) => Uint8Array.of(byte))), expected);
  assert.deepEqual(source, original, "the raw descriptor/bridge bytes must never be mutated");
  assert.deepEqual(
    present([Uint8Array.of(0xf0, 0x9f), Uint8Array.of(0x98, 0x80, 0xff, 0, 10)]),
    Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff, 0, 13, 10]),
  );
});

test("newline expansion uses bounded deliveries even for an all-LF large input", () => {
  const input = new Uint8Array(1024 * 1024).fill(10);
  const output = new TerminalNewlines();
  let delivered = 0;
  output.write(input, (bytes) => {
    assert.ok(bytes.length > 0 && bytes.length <= 32768);
    assert.equal(bytes.length % 2, 0);
    for (let at = 0; at < bytes.length; at += 2) {
      assert.equal(bytes[at], 13);
      assert.equal(bytes[at + 1], 10);
    }
    delivered += bytes.length;
  });
  assert.equal(delivered, input.length * 2);
  assert.ok(input.every((byte) => byte === 10));
});

test("a new terminal attachment does not inherit the preceding session's CR", () => {
  const first = new TerminalNewlines();
  first.write(Uint8Array.of(13), () => {});
  const second = new TerminalNewlines();
  const bytes: Uint8Array[] = [];
  second.write(Uint8Array.of(10), (chunk) => bytes.push(chunk));
  assert.deepEqual(Buffer.concat(bytes), Buffer.from([13, 10]));
});
