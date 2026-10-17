// Adapted from bun-wasm web/src/fs-worker.ts at 8d3d416aa9cb23718ed3487a33d0b06e8e373672.
// Local adaptations: runtime peer imports; browser-shell worker URLs and terminal transport where noted.
import {
  installFilesystemWorker,
  MemoryBackend,
  PersistentBackend,
  IndexedDBStorage,
} from "@bun-wasm/runtime/fs";
installFilesystemWorker(self, async (options) =>
  options.persistence === false
    ? new MemoryBackend()
    : PersistentBackend.open(await IndexedDBStorage.open(options.name ?? "bun-wasm-workspace")),
);
