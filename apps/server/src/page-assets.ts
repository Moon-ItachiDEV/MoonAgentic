// What a page an agent publishes from its folder loads beside it: the styles, scripts, images,
// fonts and pages it names, and what those name in turn. Only those are kept with its version,
// never the rest of the folder, never a file git ignores, never above the page's own folder.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { servedType } from "./artifacts.ts";
import { resolveInside } from "./files.ts";

/** Most files kept beside one page. */
export const MAX_PAGE_ASSETS = 200;
/** Most bytes kept beside one page, all its files together. */
export const MAX_PAGE_ASSETS_BYTES = 50 * 1024 * 1024;
/** A file bigger than this is not read for what it names. */
const MAX_READ = 2 * 1024 * 1024;

/** One file a page loads, by its path under the page's folder (`css/a.css`). */
export interface PageAsset {
  rel: string;
  file: string;
}

const HTML_REFS = [
  /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
  /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
];
const CSS_REFS = [
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi,
  /@import\s+(?:"([^"]*)"|'([^']*)')/gi,
];
const JS_REFS = [
  /\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const kindOf = (file: string) => {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".css") return "css";
  if (ext === ".js" || ext === ".mjs") return "js";
  return undefined;
};

/** What one file names, as written: each address its kind of file loads things by. */
export function namedIn(text: string, kind: "html" | "css" | "js"): string[] {
  const found: string[] = [];
  const take = (patterns: RegExp[], split = false) => {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const value = match.slice(1).find((v) => v !== undefined) ?? "";
        if (split && pattern.source.includes("srcset")) {
          for (const part of value.split(",")) found.push(part.trim().split(/\s+/)[0] ?? "");
        } else found.push(value);
      }
    }
  };
  if (kind === "html") {
    take(HTML_REFS, true);
    // Inline styles and scripts name things the same way.
    take(CSS_REFS);
    take(JS_REFS);
  } else if (kind === "css") take(CSS_REFS);
  else take(JS_REFS);
  return found;
}

/** A relative address of a local file, without its query or fragment; nothing else. */
function localPath(ref: string): string | undefined {
  const raw = ref.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("\\")) return undefined;
  // A scheme (`https:`, `data:`, `blob:`, `mailto:`) leads elsewhere; a Windows drive too.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
  const bare = raw.replace(/[?#].*$/, "");
  if (!bare) return undefined;
  try {
    return decodeURI(bare);
  } catch {
    return bare;
  }
}

/** Those of `rels` git ignores in `dir`: none when it is no repository. */
function ignored(dir: string, rels: string[]): Promise<Set<string>> {
  if (!rels.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    execFile(
      "git",
      ["check-ignore", "--", ...rels],
      { cwd: dir, timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      // Exit 1: none ignored; any other failure (no repository): nothing known to leave out.
      (error, stdout) =>
        resolve(
          new Set(
            error && error.code !== 1 && !stdout
              ? []
              : stdout
                  .split(/\r?\n/)
                  .map((line) => line.trim().replace(/\\/g, "/"))
                  .filter(Boolean),
          ),
        ),
    );
  });
}

/**
 * The files the page at `entry` loads from its own folder (`root`) and below, followed from
 * file to file, as they are now. A name leading above `root`, out of it through a link, to a
 * kind of file that is not served, or to a file git ignores, is left out.
 */
export async function pageAssets(entry: string, root: string): Promise<PageAsset[]> {
  const kept = new Map<string, string>();
  let bytes = 0;
  let level: { file: string; kind: "html" | "css" | "js" }[] = [{ file: entry, kind: "html" }];
  const seen = new Set<string>([path.resolve(entry)]);
  while (level.length && kept.size < MAX_PAGE_ASSETS) {
    const candidates = new Map<string, string>();
    for (const { file, kind } of level) {
      let text: string;
      try {
        if ((await stat(file)).size > MAX_READ) continue;
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const ref of namedIn(text, kind)) {
        const local = localPath(ref);
        if (!local) continue;
        const rel = path
          .relative(root, path.resolve(path.dirname(file), local))
          .split(path.sep)
          .join("/");
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || kept.has(rel)) continue;
        if (!servedType(rel)) continue;
        const real = resolveInside(root, rel);
        if (!real || seen.has(real)) continue;
        seen.add(real);
        candidates.set(rel, real);
      }
    }
    const left = await ignored(root, [...candidates.keys()]);
    const next: typeof level = [];
    for (const [rel, real] of candidates) {
      if (left.has(rel) || kept.size >= MAX_PAGE_ASSETS) continue;
      const size = (await stat(real)).size;
      if (bytes + size > MAX_PAGE_ASSETS_BYTES) continue;
      bytes += size;
      kept.set(rel, real);
      const kind = kindOf(rel);
      if (kind) next.push({ file: real, kind });
    }
    level = next;
  }
  return [...kept].map(([rel, file]) => ({ rel, file }));
}
