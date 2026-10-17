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
