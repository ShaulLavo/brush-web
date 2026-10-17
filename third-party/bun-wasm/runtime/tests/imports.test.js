import { expect, test } from 'bun:test';
import { Wasi } from "../core/index";
import { MemFS } from '../../web/src/fs';

const enc = new TextEncoder();
const name = (text) => [text.length].concat(Array.from(enc.encode(text)));
const section = (id, bytes) => [id, bytes.length].concat(bytes);
function guest(namespace, field, memory = false) {
  const imported = name(namespace).concat(name(field), memory ? [2, 1, 1, 2] : [0, 0]);
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 1, 0x7f]), section(2, [1].concat(imported)),
  )));
}
function host(options = {}) {
  return new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {}, ...options });
}

test('unknown namespaces fail during linking, not later as fabricated errno stubs', () => {
  expect(() => host().imports(guest('unknown', 'call'))).toThrow('unknown.call');
});
test('unknown preview1 names fail during linking', () => {
  expect(() => host().imports(guest('wasi_snapshot_preview1', 'not_a_syscall'))).toThrow('not_a_syscall');
});
test('explicit adapter namespaces supply only declared imports', () => {
  const call = () => 42;
  const h = host({ namespaces: { runtime_proc: { call } } });
  const module = guest('runtime_proc', 'call');
  expect(h.imports(module).runtime_proc.call()).toBe(42);
  expect(() => h.imports(guest('runtime_proc', 'absent'))).toThrow('runtime_proc.absent');
});
test('imported memory is explicit and is used without a memory export', () => {
  const module = guest('env', 'memory', true);
  expect(() => host().imports(module)).toThrow('env.memory');
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const h = host({ namespaces: { env: { memory } } });
  new WebAssembly.Instance(module, h.imports(module));
  h.start({ exports: { _start() {} } });
  expect(h.functions().clock_time_get(0, 0n, 0)).toBe(0);
  expect(new DataView(memory.buffer).getBigUint64(0, true)).toBeGreaterThan(0n);
});

test('namespace and import lookup ignore inherited object properties', () => {
  expect(() => host({ namespaces: {} }).imports(guest('__proto__', 'toString'))).toThrow('__proto__.toString');
  expect(() => host().imports(guest('wasi_snapshot_preview1', 'toString'))).toThrow('toString');
});
