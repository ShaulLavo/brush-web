/** Original step-9 fixtures, adapted from spike 5's own loops.wat (2026-10-16).
 * No upstream code. Word 2 is an independent host-call-free rescue, NEVER cancellation.
 * It remains zero until teardown, including after a successful acknowledged trap.
 */
export const interruptShapes = ["tight-backedge", "internal-call", "unrolled-512", "direct-tail", "indirect-tail"] as const;
export type InterruptShape = typeof interruptShapes[number];
export const InterruptWord = { heartbeat: 0, interrupt: 1, rescue: 2, trapped: 3, returned: 4 } as const;

function uint(value: number): number[] {
  const bytes: number[] = [];
  do { const next = value >>> 7; bytes.push((value & 127) | (next ? 128 : 0)); value = next; } while (value);
  return bytes;
}
function text(value: string): number[] { const bytes = Array.from(new TextEncoder().encode(value)); return uint(bytes.length).concat(bytes); }
function section(id: number, bytes: number[]): number[] { return [id].concat(uint(bytes.length), bytes); }

/** Tiny readable binary assembler, not a second instrumenter. All functions are () -> (). */
export function interruptLoopFixture(): Uint8Array<ArrayBuffer> {
  const beat = [0x41, 0, 0x41, 1, 0xfe, 0x1e, 2, 0, 0x1a]; // atomic.add heartbeat
  const rescue = [0x41, 8, 0xfe, 0x10, 2, 0, 0x04, 0x40, 0x0f, 0x0b]; // if rescue: return
  const loop = (body: number[]) => [0x03, 0x40].concat(rescue, body, [0x0c, 0, 0x0b]);
  const unrolled: number[] = [];
  for (let i = 0; i < 512; i++) unrolled.push(...beat);
  const bodies = [beat, loop(beat), loop([0x10, 0, 0x10, 0]), loop(unrolled),
    rescue.concat(beat, [0x12, 5]), rescue.concat(beat, [0x12, 4]),
    rescue.concat(beat, [0x41, 1, 0x13, 0, 0]), rescue.concat(beat, [0x41, 0, 0x13, 0, 0])];
  const exports = interruptShapes.flatMap((name, index) => text(name).concat([0, [1, 2, 3, 4, 6][index]!]));
  const code = bodies.flatMap(body => { const localBody = [0].concat(body, [0x0b]); return uint(localBody.length).concat(localBody); });
  const exportCount: number[] = [interruptShapes.length];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 0]),
    section(2, [1].concat(text("env"), text("memory"), [2, 3, 2, 2])),
    section(3, [bodies.length].concat(bodies.map(() => 0))),
    section(4, [1, 0x70, 0, 2]),
    section(7, exportCount.concat(exports)),
    section(9, [1, 0, 0x41, 0, 0x0b, 2, 6, 7]),
    section(10, [bodies.length].concat(code)),
  ));
}

export function interruptFixtureMemory(): WebAssembly.Memory { return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }); }
