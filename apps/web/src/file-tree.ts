// The « Fichiers » tab's tree of a thread's folder, from the flat list the server gives.

export interface FileDir {
  name: string;
  /** Its path from the folder's root, `` for the root itself. */
  path: string;
  dirs: FileDir[];
  /** Its files, as full paths. */
  files: string[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Folders first then files, each by name, as file browsers show them. */
export function fileTree(paths: readonly string[]): FileDir {
  const root: FileDir = { name: "", path: "", dirs: [], files: [] };
  const dirs = new Map<string, FileDir>([["", root]]);
  const dirOf = (dirPath: string): FileDir => {
    const known = dirs.get(dirPath);
    if (known) return known;
    const cut = dirPath.lastIndexOf("/");
    const parent = dirOf(cut < 0 ? "" : dirPath.slice(0, cut));
    const dir: FileDir = { name: dirPath.slice(cut + 1), path: dirPath, dirs: [], files: [] };
    parent.dirs.push(dir);
    dirs.set(dirPath, dir);
    return dir;
  };
  for (const file of paths) {
    const cut = file.lastIndexOf("/");
    dirOf(cut < 0 ? "" : file.slice(0, cut)).files.push(file);
  }
  for (const dir of dirs.values()) {
    dir.dirs.sort((a, b) => byName(a.name, b.name));
    dir.files.sort((a, b) => byName(baseName(a), baseName(b)));
  }
  return root;
}

export const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/**
 * The files whose path holds the query, ignoring case: those whose own name holds it first,
 * then the shorter paths. At most `limit` of them.
 */
export function filterFiles(paths: readonly string[], query: string, limit = 200): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = paths.filter((p) => p.toLowerCase().includes(q));
  const named = (p: string) => (baseName(p).toLowerCase().includes(q) ? 0 : 1);
  return hits
    .sort((a, b) => named(a) - named(b) || a.length - b.length || byName(a, b))
    .slice(0, limit);
}

/** How many of `changed` sit under the folder `dir` (`` for the root). */
export function changesUnder(dir: string, changed: Iterable<string>): number {
  let n = 0;
  for (const file of changed) if (!dir || file.startsWith(`${dir}/`)) n++;
  return n;
}
