// The files an agent names in its answer: an image it made, shown in the thread, or a file it
// links to, opened from a phone. An agent writes them as paths of the computer it runs on
// (`C:\Users\…\image.png`, `file:///…`, `images/plan.png`), which no other device can read.
// Such a path is served only when it leads to a file of a kind that is shown (an image, a
// PDF, a page…), inside the thread's own folders or where agents keep what they generate.
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
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
 * followed. A relative one is looked for in `folder`.
 */
export async function resolveThreadFile(
  ref: string,
  folder: string,
  roots: string[],
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
  const insideRoots = roots.map(real).filter((r): r is string => !!r);
  for (const candidate of new Set([written, decoded])) {
    if (!servedType(candidate)) continue;
    const absolute = path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate);
    const found = real(absolute ? candidate : path.resolve(folder, candidate));
    if (!found || !insideRoots.some((root) => isInside(root, found))) continue;
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
