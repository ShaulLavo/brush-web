// In-memory filesystem shared by the shell, the editor and every bun.wasm run.
// Plain objects so the whole tree can be structured-cloned to and from a worker.

export interface FileNode {
  kind: "file";
  data: Uint8Array;
  mtime: number; // ms since epoch
  ino: number;
}

export interface DirNode {
  kind: "dir";
  children: Map<string, Node>;
  mtime: number;
  ino: number;
}

export type Node = FileNode | DirNode;

let nextIno = 1;

export function newIno(): number {
  return nextIno++;
}

/** Inode numbers survive a round trip through a worker; keep the counter ahead of them. */
export function adoptInodes(root: DirNode): void {
  let max = 0;
  const walk = (node: Node) => {
    if (node.ino > max) max = node.ino;
    if (node.kind === "dir") for (const child of node.children.values()) walk(child);
  };
  walk(root);
  if (max >= nextIno) nextIno = max + 1;
}

export function newDir(): DirNode {
  return { kind: "dir", children: new Map(), mtime: Date.now(), ino: newIno() };
}

export function newFile(data: Uint8Array = new Uint8Array(0)): FileNode {
  return { kind: "file", data, mtime: Date.now(), ino: newIno() };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decode(data: Uint8Array): string {
  return decoder.decode(data);
}

/** Normalize to an absolute path without `.`/`..`/empty segments. `..` above `/` stays at `/`. */
export function normalize(path: string, cwd = "/"): string {
  const parts: string[] = [];
  const full = path.startsWith("/") ? path : `${cwd}/${path}`;
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function splitPath(path: string): string[] {
  return path.split("/").filter((p) => p !== "");
}

export function dirname(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return `/${parts.join("/")}`;
}

export function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? "";
}

export class MemFS {
  constructor(public root: DirNode = newDir()) {}

  lookup(path: string): Node | undefined {
    let node: Node = this.root;
    for (const part of splitPath(path)) {
      if (node.kind !== "dir") return undefined;
      const child = node.children.get(part);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  mkdirp(path: string): DirNode {
    let node: DirNode = this.root;
    for (const part of splitPath(path)) {
      let child = node.children.get(part);
      if (!child) {
        child = newDir();
        node.children.set(part, child);
        node.mtime = Date.now();
      }
      if (child.kind !== "dir") throw new Error(`${part}: not a directory`);
      node = child;
    }
    return node;
  }

  writeFile(path: string, content: string | Uint8Array, append = false): void {
    const data = typeof content === "string" ? encode(content) : content;
    const parent = this.mkdirp(dirname(path));
    const name = basename(path);
    const existing = parent.children.get(name);
    if (existing?.kind === "dir") throw new Error(`${name}: is a directory`);
    if (existing && append) {
      const merged = new Uint8Array(existing.data.length + data.length);
      merged.set(existing.data);
      merged.set(data, existing.data.length);
      existing.data = merged;
      existing.mtime = Date.now();
      return;
    }
    if (existing) {
      existing.data = data;
      existing.mtime = Date.now();
      return;
    }
    parent.children.set(name, newFile(data));
    parent.mtime = Date.now();
  }

  readFile(path: string): Uint8Array | undefined {
    const node = this.lookup(path);
    return node?.kind === "file" ? node.data : undefined;
  }

  remove(path: string): boolean {
    const parent = this.lookup(dirname(path));
    if (parent?.kind !== "dir") return false;
    return parent.children.delete(basename(path));
  }

  /** Every regular file under `dir`, as absolute paths, sorted. */
  listFiles(dir = "/"): string[] {
    const out: string[] = [];
    const walk = (node: Node, path: string) => {
      if (node.kind === "file") {
        out.push(path);
        return;
      }
      for (const [name, child] of node.children) walk(child, path === "/" ? `/${name}` : `${path}/${name}`);
    };
    const start = this.lookup(dir);
    if (start) walk(start, normalize(dir));
    return out.sort();
  }
}
