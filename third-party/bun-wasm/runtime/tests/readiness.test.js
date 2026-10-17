import { expect, test } from 'bun:test';
import { Wasi } from "../core/index";
import { MemFS } from '../../web/src/fs';
const ALL = (1n << 29n) - 1n;
function host(sleep = () => {}) {
  const h = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep });
  const memory = new WebAssembly.Memory({ initial: 1 });
  h.start({ exports: { memory, _start() {} } });
  const view = new DataView(memory.buffer);
  function sub(at, fd, type = 1) { view.setBigUint64(at, BigInt(fd), true); view.setUint8(at + 8, type); view.setUint32(at + 16, fd, true); }
  function poll(n) { return h.functions().poll_oneoff(0, 1024, n, 2048); }
  return { h, view, sub, poll };
}
function endpoint(state) {
  return { kind: 'pipe', read: () => 0, write: () => 0, readiness: () => state };
}
test('only ready descriptors appear and hang-up is delivered', () => {
  const { h, view, sub, poll } = host();
  const blocked = h.descriptors.open(endpoint({ readable: false, writable: false, hangup: false }), ALL, ALL);
  const ready = h.descriptors.open(endpoint({ readable: true, writable: false, hangup: true, nbytes: 12 }), ALL, ALL);
  sub(0, blocked); sub(48, ready);
  expect(poll(2)).toBe(0);
  expect(view.getUint32(2048, true)).toBe(1);
  expect(view.getBigUint64(1024, true)).toBe(BigInt(ready));
  expect(view.getUint16(1048, true)).toBe(1);
  expect(view.getBigUint64(1040, true)).toBe(12n);
});
test('blocked descriptors are checked again after waiting', () => {
  const state = { readable: false, writable: false, hangup: false };
  let waits = 0;
  const { h, view, sub, poll } = host(() => { waits++; state.readable = true; });
  const fd = h.descriptors.open(endpoint(state), ALL, ALL);
  sub(0, fd);
  expect(poll(1)).toBe(0);
  expect(waits).toBe(1);
  expect(view.getUint32(2048, true)).toBe(1);
});
test('invalid subscription types yield EINVAL and expired clocks accompany ready fds', () => {
  const { view, sub, poll } = host();
  sub(0, 1, 9);
  expect(poll(1)).toBe(0);
  expect(view.getUint16(1032, true)).toBe(28);
  sub(0, 1, 2); sub(48, 0, 0);
  expect(poll(2)).toBe(0);
  expect(view.getUint32(2048, true)).toBe(2);
});

test('poll rejects unsigned oversized counts and invalid subscription spans before sleeping', () => {
  let waits = 0;
  const { h, poll } = host(() => { waits++; throw new Error('invalid poll attempted to sleep'); });
  expect(poll(-1)).toBe(28);
  expect(poll(0xffffffff)).toBe(28);
  expect(poll(0)).toBe(28);
  expect(poll(1366)).toBe(28); // 48-byte subscriptions do not fit in one memory page.
  expect(h.functions().poll_oneoff(65520, 1024, 1, 2048)).toBe(28);
  expect(h.functions().poll_oneoff(-1, 1024, 1, 2048)).toBe(28);
  expect(waits).toBe(0);
});
