// The files an agent names in its answer: an image it made, shown in the thread, or a file it
// links to, opened from a phone. An agent writes them as paths of the computer it runs on
// (`C:\Users\…\image.png`, `file:///…`, `images/plan.png`), which no other device can read.
// Such a path is served only when it leads to a file of a kind that is shown (an image, a
// PDF, a page…), inside the thread's own folders or where agents keep what they generate.
import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SERVED_BYTES, servedType } from "./artifacts.ts";

/**
 * Where agents put the images they generate outside the project: Antigravity's conversations
 * (`brain/<id>/…`) and pages, Codex's generated images.
 */
export function generatedFolders(home: string): string[] {
  return [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity", "html_artifacts"),
    path.join(home, ".codex", "generated_images"),
  ];
}

/** The path a reference names, as written: absolute, or relative to the thread's folder. */
export function refPath(ref: string): string | undefined {
  let raw = ref.trim();
  if (!raw || raw.includes("\0")) return undefined;
  if (/^file:/i.test(raw)) {
    // A Windows file address is read the same on any system: `file:///C:/…`.
    const drive = /^file:\/*([a-zA-Z]:[\\/].*)$/i.exec(raw)?.[1];
    if (drive) {
      try {
        return path.win32.normalize(decodeURIComponent(drive.replace(/[?#].*$/, "")));
      } catch {
        return undefined;
      }
    }
    try {
      const file = fileURLToPath(raw);
      // `file://serveur/partage/…` is a network share: never looked at.
      return /^[\\/]{2}/.test(file) ? undefined : file;
    } catch {
      return undefined;
    }
  }
  // An address of the web is not a file of this computer, nor is a network share.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return undefined;
  if (raw.startsWith("//") || raw.startsWith("\\\\")) return undefined;
  // What follows a `?` or a `#` is not part of the file's name.
  raw = raw.replace(/[?#].*$/, "");
  return raw || undefined;
}

function real(file: string): string | undefined {
  try {
    return realpathSync.native(file);
  } catch {
    return undefined;
  }
}

const isInside = (root: string, file: string) => {
  const inside = path.relative(root, file);
  return !!inside && !inside.startsWith("..") && !path.isAbsolute(inside);
};

export interface ServedFile {
  /** The file itself, links followed. */
  file: string;
  name: string;
  type: string;
  size: number;
}

/**
 * The file a reference of a thread's answer leads to, when it can be served: of a kind that
 * is shown, no bigger than served files are, and inside one of `roots` once every link is
 * followed. A relative one is looked for in `folder`, then in `generated` and the folders right
 * in them: an agent names the image it made by its name alone.
 */
export async function resolveThreadFile(
  ref: string,
  folder: string,
  roots: string[],
  generated: string[] = [],
): Promise<ServedFile | undefined> {
  const written = refPath(ref);
  if (!written) return undefined;
  // An address may have its spaces and accents encoded, as Markdown wants them.
  let decoded = written;
  try {
    decoded = decodeURI(written);
  } catch {
    // kept as written
  }
  const insideRoots = [...roots, ...generated].map(real).filter((r): r is string => !!r);
  const candidates = [...new Set([written, decoded])];
  const tried: string[] = [];
  for (const candidate of candidates) {
    if (!servedType(candidate)) continue;
    tried.push(isAbsolute(candidate) ? candidate : path.resolve(folder, candidate));
  }
  const served = await firstServed(tried, insideRoots);
  if (served) return served;
  // A name alone (« naruto_1795544736202.jpg »): the agent wrote it as it sits in the folder
  // where it generates, Antigravity's conversation (`brain/<id>/`), not in the thread's own.
  const relative = candidates.filter((c) => servedType(c) && !isAbsolute(c));
  if (!relative.length || !generated.length) return undefined;
  const elsewhere: string[] = [];
  for (const dir of await generatedDirs(generated)) {
    for (const c of relative) elsewhere.push(path.resolve(dir, c));
  }
  return firstServed(elsewhere, insideRoots);
}

const isAbsolute = (file: string) => path.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file);

/** The first of `files` that can be served, once every link is followed. */
async function firstServed(files: string[], roots: string[]): Promise<ServedFile | undefined> {
  for (const candidate of files) {
    const found = real(candidate);
    if (!found || !roots.some((root) => isInside(root, found))) continue;
    // The kind is the real file's: a link named `.png` to something else is not an image.
    const type = servedType(found);
    if (!type) continue;
    try {
      const info = await stat(found);
      if (!info.isFile() || info.size > MAX_SERVED_BYTES) continue;
      return { file: found, name: path.basename(found), type, size: info.size };
    } catch {
      // gone since
    }
  }
  return undefined;
}

/** At most this many of an agent's conversations are looked in for a name alone. */
const MAX_GENERATED_DIRS = 400;

/**
 * The folders where a name alone may be: each generated folder, then the folders right in
 * it (one per conversation), the most recently changed first.
 */
async function generatedDirs(generated: string[]): Promise<string[]> {
  const dirs: string[] = [];
  const subs: { dir: string; at: number }[] = [];
  for (const root of generated) {
    dirs.push(root);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      try {
        subs.push({ dir, at: (await stat(dir)).mtimeMs });
      } catch {
        // gone since
      }
    }
  }
  subs.sort((a, b) => b.at - a.at);
  return [...dirs, ...subs.slice(0, MAX_GENERATED_DIRS).map((s) => s.dir)];
}
