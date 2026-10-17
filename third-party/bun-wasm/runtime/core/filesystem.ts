/** Opaque filesystem-owned identity. Open handles remain valid across rename and unlink. */
export type FileHandle = number;
export interface FileStat {
  kind: "file" | "directory";
  ino: number;
  size: number;
  mtime: number;
}
export interface DirectoryEntry {
  name: string;
  ino: number;
  kind: FileStat["kind"];
}
export interface ResolvedPath {
  parent: FileHandle | undefined;
  name: string;
  node: FileHandle | undefined;
  trailingSlash: boolean;
  terminalDot: boolean;
}
/** Synchronous preview1 boundary; a worker-backed client can implement the same operations.
 * Path/status operations use positive WASI errno; I/O uses byte counts or negative errno.
 * No tree nodes or owned file buffers cross this interface.
 */
export interface FileSystem {
  preopen(path: string): FileHandle;
  /** One retain/release pair per open description; duplicates share that lifetime. */
  retain(handle: FileHandle): void;
  release(handle: FileHandle): void;
  resolve(directory: FileHandle, path: string): ResolvedPath | number;
  stat(handle: FileHandle): FileStat;
  /** Bytes transferred, or negative WASI errno; errors must not advance the open offset. */
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number;
  /** Bytes transferred, or negative WASI errno; partial success returns its byte count. */
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number;
  /** Select EOF and write all chunks atomically. Success includes the resulting description offset;
   * failure is negative WASI errno. A partial write reports only its committed bytes and offset. */
  append(handle: FileHandle, chunks: readonly Uint8Array[]): { written: number; offset: number } | number;
  /** Zero on success, positive WASI errno on failure. */
  resize(handle: FileHandle, size: number, truncate: boolean): number;
  /** Zero on success, positive WASI errno on failure. */
  setMtime(handle: FileHandle, mtime: number): number;
  /** Explicit durability barrier; pure-memory filesystems need no storage work. */
  sync?(handle: FileHandle): number;
  readdir(handle: FileHandle): DirectoryEntry[];
  /** Atomically create at parent/name; exclusive rejects existing entries. Nonexclusive file
   * creation returns the current entry, even if it appeared after resolve. */
  create(path: ResolvedPath, kind: "file" | "directory", exclusive?: boolean): FileHandle | { error: number };
  link(from: ResolvedPath, to: ResolvedPath): number;
  removePath(path: ResolvedPath, directory: boolean): number;
  rename(from: ResolvedPath, to: ResolvedPath): number;
}
