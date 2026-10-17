export { FilesystemClient, FilesystemCompletion } from "./client";
export { FilesystemService, installFilesystemWorker } from "./service";
export { MemoryBackend, type FilesystemBackend } from "./backend";
export { createFilesystemConnection, createFilesystemIdentity, createProcessFilesystemIdentity, releaseFilesystemReservation, connectFilesystemIdentity, revokeFilesystemService, revokeFilesystem, reapFilesystem, waitForFilesystemQuiescence, type FilesystemIdentity, type FilesystemReservation, type FilesystemConnection, FilesystemError } from "./protocol";

export { DEFAULT_SHARED_MAX_BYTES, SHARED_SEGMENT_BYTES, MissingSegmentError, MissingDataError, SharedFilesystemState, sharedRevoked, type SharedFileInfo } from "./shared";

export { PersistentBackend } from "./persistent";
export { IndexedDBStorage } from "./indexeddb";
export { OpfsStorage, type OpfsStorageOptions } from "./opfs";
export type { StorageBackend, PersistedIndex, PersistedNode, PersistenceBatch } from "./storage";
