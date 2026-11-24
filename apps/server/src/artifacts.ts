// « Artefacts »: the pages, images and PDF documents agents made in their threads' own
// branches, found anew each time they are asked for, and shown from short-lived addresses
// that serve the files of one thread's folder alone, with no script allowed to run.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Artifact, ArtifactKind, Thread, Workspace } from "@moonagentic/protocol";
import { resolveInside } from "./files.ts";
import { changedPaths } from "./git.ts";
import { listedWorktreeFile } from "./workspace.ts";

export const ARTIFACTS_PATH = "/api/artifacts";
/** How long an address given to show an artifact works. */
export const ARTIFACT_LINK_TTL_MS = 10 * 60_000;
/** Addresses kept at once: the oldest stops working when more are asked for. */
const MAX_LINKS = 500;
/** Past this many, the list stops at the newest. */
export const MAX_ARTIFACTS = 300;
/** Threads looked at, the most recently active first: each costs two git commands. */
const MAX_THREADS = 60;
const AT_ONCE = 4;
/** A bigger file is not served. */
export const MAX_SERVED_BYTES = 50 * 1024 * 1024;

const KINDS: Record<string, ArtifactKind> = {
  ".html": "html",
  ".htm": "html",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".avif": "image",
  ".svg": "image",
  ".pdf": "pdf",
};

/**
 * What can be served from a thread's folder, with its type: the artifacts themselves, and what
 * a page loads beside it. Anything else is not served at all.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export const artifactKind = (file: string): ArtifactKind | undefined =>
  KINDS[path.extname(file).toLowerCase()];

export const servedType = (file: string): string | undefined =>
  TYPES[path.extname(file).toLowerCase()];

async function eachAtMost<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The artifacts of the threads that work on a branch of their own and are not resolved: the
 * files of a known kind that changed there since the branch started, the newest first.
 */
export async function findArtifacts(
  threads: Thread[],
): Promise<{ artifacts: Artifact[]; capped: boolean }> {
  const looked = threads
    .filter((t) => !t.archived && t.kind !== "coordinator" && t.workspace?.base)
    .filter((t) => existsSync(t.workspace!.path))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS);
  const found = await eachAtMost(looked, AT_ONCE, async (thread) => {
    const ws = thread.workspace!;
    const files = await changedPaths(ws.path, ws.base!).catch(() => []);
    const shown: Artifact[] = [];
    for (const file of files) {
      const kind = artifactKind(file);
      // A link leading out of the folder is not an artifact of this thread.
      const real = kind && resolveInside(ws.path, file);
      if (!kind || !real) continue;
      try {
        const found = await stat(real);
        if (!found.isFile()) continue;
        const { size, mtimeMs } = found;
        shown.push({
          threadId: thread.id,
          threadTitle: thread.title,
          projectId: thread.projectId,
          path: file,
          kind,
          size,
          mtime: Math.round(mtimeMs),
        });
      } catch {
        // gone since the listing
      }
    }
    return shown;
  });
  const all = found.flat().sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return { artifacts: all.slice(0, MAX_ARTIFACTS), capped: all.length > MAX_ARTIFACTS };
}

/** The address of a file under a link: each part of its path encoded on its own. */
export const artifactUrl = (ticket: string, file: string) =>
  `${ARTIFACTS_PATH}/${ticket}/${file.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The short-lived addresses artifacts are shown from. One serves the files of its thread's
 * folder that the folder's listing holds, so a page finds its images and styles beside it.
 */
export class ArtifactLinks {
  /** Each address, with the device it was given to (none for the computer itself). */
  private readonly links = new Map<
    string,
    {
      threadId: string;
      deviceId?: string;
      expiresAt: number;
      /** For an address of one file an answer names: that file alone. */
      file?: string;
    }
  >();
  private readonly workspaceOf: (threadId: string) => Workspace | undefined;
  private readonly now: () => number;
  /** Whether a thread's files may still be shown: it is there, and its project not locked. */
  private readonly shown: (threadId: string) => boolean;

  constructor(
    workspaceOf: (threadId: string) => Workspace | undefined,
    now = Date.now,
    shown: (threadId: string) => boolean = (id) => !!workspaceOf(id),
  ) {
    this.workspaceOf = workspaceOf;
    this.now = now;
    this.shown = shown;
  }

  /** A new address for the files of this thread's folder, given to that device. */
  issue(threadId: string, deviceId?: string): { ticket: string; expiresAt: number } {
    return this.add({ threadId, ...(deviceId ? { deviceId } : {}) });
  }

  /**
   * An address for one file an answer of this thread names, given to that device. One given
   * before for the same file, with more than half its time left, is given again: a thread
   * shown anew asks again for each of its images.
   */
  issueFile(
    threadId: string,
    file: string,
    deviceId?: string,
  ): { ticket: string; expiresAt: number } {
    const now = this.now();
    for (const [ticket, link] of this.links) {
      if (
        link.file === file &&
        link.threadId === threadId &&
        link.deviceId === deviceId &&
        link.expiresAt - now > ARTIFACT_LINK_TTL_MS / 2
      ) {
        return { ticket, expiresAt: link.expiresAt };
      }
    }
    return this.add({ threadId, file, ...(deviceId ? { deviceId } : {}) });
  }

  private add(link: { threadId: string; deviceId?: string; file?: string }) {
    const now = this.now();
    for (const [key, link] of this.links) if (link.expiresAt <= now) this.links.delete(key);
    while (this.links.size >= MAX_LINKS) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + ARTIFACT_LINK_TTL_MS;
    this.links.set(ticket, { ...link, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Stops at once the addresses given to the devices `whose` names: a revoked phone's, or the
   * computer's own when its token is renewed.
   */
  forget(whose: (deviceId: string | undefined) => boolean): void {
    for (const [key, link] of this.links) if (whose(link.deviceId)) this.links.delete(key);
  }

  /**
   * The file an address names, with its type, while the address works and the thread is
   * there: a file of a type that is served, listed in the thread's folder, inside it.
   */
  async resolve(
    ticket: string,
    file: string,
  ): Promise<{ file: string; type: string; size: number } | undefined> {
    const link = this.links.get(ticket);
    if (!link) return undefined;
    if (link.expiresAt <= this.now()) {
      this.links.delete(ticket);
      return undefined;
    }
    const type = servedType(file);
    if (!type) return undefined;
    if (link.file) {
      // Its own name only, while its thread may be shown.
      if (file !== path.basename(link.file) || !this.shown(link.threadId)) return undefined;
      try {
        const found = await stat(link.file);
        return found.isFile() && found.size <= MAX_SERVED_BYTES
          ? { file: link.file, type, size: found.size }
          : undefined;
      } catch {
        return undefined;
      }
    }
    const real = await listedWorktreeFile(this.workspaceOf(link.threadId), file);
    if (!real) return undefined;
    try {
      const found = await stat(real);
      return found.isFile() && found.size <= MAX_SERVED_BYTES
        ? { file: real, type, size: found.size }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
