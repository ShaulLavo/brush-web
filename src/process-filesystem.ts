import { Directory, File } from "@bjorn3/browser_wasi_shim";
import { type DirNode, type Node, MemFS, newDir, newFile } from "../third-party/bun-wasm/fs";
import { mergeFilesystemChanges } from "../third-party/bun-wasm/subprocess-fs";

export function installProgramFiles(root: Directory, paths: readonly string[]) {
  for (const path of paths) installProgram(root, path);
}
function installProgram(root: Directory, path: string) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  if (
    !path.startsWith("/") ||
    !name ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(`Invalid registered program path: ${path}`);
  let directory = root;
  for (const part of parts) {
    const entry = directory.contents.get(part);
    if (entry && !(entry instanceof Directory))
      throw new Error(`Program directory is a file: ${part}`);
    const next = entry instanceof Directory ? entry : new Directory([]);
    directory.contents.set(part, next);
    directory = next;
  }
  directory.contents.set(name, new File([], { readonly: true }));
}

export function snapshotFilesystem(directory: Directory): DirNode {
  const root = newDir();
  for (const [name, inode] of directory.contents) {
    if (inode instanceof Directory) root.children.set(name, snapshotFilesystem(inode));
    else if (inode instanceof File) root.children.set(name, newFile(inode.data.slice()));
    else throw new Error("External commands require regular files and directories");
  }
  return root;
}
function usage(node: Node): { bytes: number; objects: number } {
  if (node.kind === "file") return { bytes: node.data.length, objects: 1 };
  const children = Array.from(node.children.values(), usage);
  return children.reduce(
    (sum, child) => ({ bytes: sum.bytes + child.bytes, objects: sum.objects + child.objects }),
    { bytes: 0, objects: 1 },
  );
}
function reconcile(directory: Directory, snapshot: DirNode) {
  for (const name of directory.contents.keys()) {
    if (!snapshot.children.has(name)) directory.contents.delete(name);
  }
  for (const [name, node] of snapshot.children) reconcileNode(directory, name, node);
}
function reconcileNode(directory: Directory, name: string, node: Node) {
  const current = directory.contents.get(name);
  if (node.kind === "dir") {
    const child = current instanceof Directory ? current : new Directory([]);
    reconcile(child, node);
    directory.contents.set(name, child);
    return;
  }
  if (current instanceof File) current.data = node.data;
  else directory.contents.set(name, new File(node.data));
}
export function applyFilesystemChanges(directory: Directory, changes: string) {
  const fs = new MemFS(snapshotFilesystem(directory));
  mergeFilesystemChanges(fs, changes);
  const size = usage(fs.root);
  if (size.bytes > 8388608 || size.objects > 1024)
    throw new Error("Child changes exceed the shell filesystem quota");
  reconcile(directory, fs.root);
}
