import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { DEFAULT_SHARED_MAX_BYTES, PAGE } from "../fs/protocol";

test("geometric growth reserves page tables only for storage it can allocate", () => {
  const state = new SharedFilesystemState();
  state.register(0, { kind: "file", ino: 1, size: PAGE * 8192, mtime: 1 });
  for (let handle = 1; handle <= 4093; handle++) {
    state.register(handle, { kind: "file", ino: handle + 1, size: PAGE, mtime: 1 });
  }
  state.register(4094, { kind: "file", ino: 4095, size: PAGE * 4097, mtime: 1 });
  expect(state.resources().freeBytes).toBe(PAGE * 2);
  state.grow(0, PAGE * 8193);
  expect(state.info(0)?.capacity).toBe(PAGE * 8193);
  expect(state.resources().usedBytes).toBe(DEFAULT_SHARED_MAX_BYTES - PAGE);
}, 30000);
