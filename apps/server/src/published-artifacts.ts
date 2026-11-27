// The artifacts an agent publishes with `publish_artifact`: kept by MoonAgentic apart from any
// repository, so a thread working in no branch of its own (a conversation outside any
// project, a project without git) has them too, and publishing again keeps each version.
// One folder per thread and per artifact: what is known of it, and one file per version.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type Artifact,
  type ArtifactKind,
  type ArtifactVersion,
  MAX_ARTIFACT_VERSIONS,
  type Thread,
} from "@moonagentic/protocol";
import type { PageAsset } from "./page-assets.ts";

/** An id this store makes, or a thread's: nothing that leads out of its folder. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/** One version as kept: its file here, and where the file it was published from sat. */
export interface StoredVersion extends ArtifactVersion {
  /** Its file in the artifact's folder (`3.html`). */
  file: string;
  /** The name it is served as, so the page's relative links find what sits beside it. */
  name: string;
  /** The real path of the file it was published from; none for a page the agent gave as text. */
  from?: string;
  /**
   * Its folder here (`3`) holding what the page loads beside it, as it was when published:
   * only that is served beside it. None when it loads nothing of its own folder.
   */
  assets?: string;
}

export interface PublishedArtifact {
  id: string;
  threadId: string;
  title: string;
  kind: ArtifactKind;
  createdAt: number;
  /** The oldest first, at most `MAX_ARTIFACT_VERSIONS`. */
  versions: StoredVersion[];
}

/** Most artifacts one thread keeps: past this, it publishes new versions of them. */
export const MAX_ARTIFACTS_PER_THREAD = 100;

export class ArtifactRefused extends Error {}

export class PublishedArtifacts {
  private readonly dir: string;
  /** Each artifact's writes one after the other: two publications at once keep both. */
  private readonly writing = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private threadDir(threadId: string): string {
    if (!SAFE_NAME.test(threadId)) throw new ArtifactRefused("Fil introuvable.");
    return path.join(this.dir, threadId);
  }

  private artifactDir(threadId: string, id: string): string {
    if (!SAFE_NAME.test(id)) throw new ArtifactRefused("Cet artefact n'existe pas dans ce fil.");
    return path.join(this.threadDir(threadId), id);
  }

  /** What is known of one artifact of this thread, if it is there. */
  async get(threadId: string, id: string): Promise<PublishedArtifact | undefined> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.artifactDir(threadId, id), "artifact.json"), "utf8");
    } catch {
      return undefined;
    }
    try {
      const found = JSON.parse(raw) as PublishedArtifact;
      return found.id === id && found.threadId === threadId && found.versions?.length
        ? found
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** The threads that published something: one look at the folder, not one per thread. */
  async threads(): Promise<Set<string>> {
    try {
      return new Set((await readdir(this.dir)).filter((name) => SAFE_NAME.test(name)));
    } catch {
      return new Set();
    }
  }

  /** This thread's artifacts, the latest published first. */
  async list(threadId: string): Promise<PublishedArtifact[]> {
    let names: string[];
    try {
      names = await readdir(this.threadDir(threadId));
    } catch {
      return [];
    }
    const found = await Promise.all(names.map((name) => this.get(threadId, name)));
    return found
      .filter((a): a is PublishedArtifact => !!a)
      .sort((a, b) => latest(b).at - latest(a).at);
  }

  /**
   * Publishes a new artifact, or a new version of `id`: the bytes given are kept as they are
   * now, whatever the agent does to its own file afterwards.
   */
  publish(input: {
    threadId: string;
    id?: string | undefined;
    title: string;
    kind: ArtifactKind;
    /** The file's extension, with its dot. */
    ext: string;
    name: string;
    bytes: Buffer;
    from?: string | undefined;
    /** What the page loads beside it, copied with its version. */
    assets?: PageAsset[] | undefined;
    now?: number;
  }): Promise<{ artifact: PublishedArtifact; version: StoredVersion }> {
    const id = input.id ?? randomUUID();
    const key = `${input.threadId}/${id}`;
    const run = (this.writing.get(key) ?? Promise.resolve()).then(() => this.write(id, input));
    // What the next one waits for: this one's end, whatever it was.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.writing.set(key, settled);
    void settled.then(() => {
      if (this.writing.get(key) === settled) this.writing.delete(key);
    });
    return run;
  }

  private async write(
    id: string,
    input: Parameters<PublishedArtifacts["publish"]>[0],
  ): Promise<{ artifact: PublishedArtifact; version: StoredVersion }> {
    const folder = this.artifactDir(input.threadId, id);
    const before = input.id ? await this.get(input.threadId, input.id) : undefined;
    if (input.id && !before) throw new ArtifactRefused("Cet artefact n'existe pas dans ce fil.");
    if (!input.id) {
      const kept = await readdir(this.threadDir(input.threadId)).catch(() => []);
      if (kept.length >= MAX_ARTIFACTS_PER_THREAD) {
        throw new ArtifactRefused(
          `Ce fil garde déjà ${MAX_ARTIFACTS_PER_THREAD} artefacts : publie plutôt une nouvelle version de l'un d'eux, avec son artifact_id.`,
        );
      }
    }
    if (before && before.kind !== input.kind) {
      throw new ArtifactRefused(
        "Cet artefact n'est pas du même type : publie ce fichier comme un nouvel artefact.",
      );
    }
    const now = input.now ?? Date.now();
    const n = (before ? latest(before).n : 0) + 1;
    const version: StoredVersion = {
      n,
      at: now,
      size: input.bytes.length,
      file: `${n}${input.ext}`,
      name: input.name,
      ...(input.from ? { from: input.from } : {}),
      ...(input.assets?.length ? { assets: String(n) } : {}),
    };
    const all = [...(before?.versions ?? []), version];
    const dropped = all.slice(0, Math.max(0, all.length - MAX_ARTIFACT_VERSIONS));
    const artifact: PublishedArtifact = {
      id,
      threadId: input.threadId,
      title: input.title,
      kind: input.kind,
      createdAt: before?.createdAt ?? now,
      versions: all.slice(dropped.length),
    };
    await mkdir(folder, { recursive: true });
    if (version.assets) {
      const dir = path.join(folder, version.assets);
      // Left by a stop in the middle of an earlier try of the same version.
      await rm(dir, { recursive: true, force: true });
      for (const asset of input.assets ?? []) {
        const to = path.join(dir, ...asset.rel.split("/"));
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(asset.file, to);
      }
    }
    await writeFile(path.join(folder, version.file), input.bytes);
    // What is known of it is replaced whole: a stop in between leaves the version before.
    const about = path.join(folder, "artifact.json");
    const next = `${about}.${randomUUID()}.tmp`;
    await writeFile(next, JSON.stringify(artifact));
    await rename(next, about);
    for (const old of dropped) {
      await unlink(path.join(folder, old.file)).catch(() => undefined);
      if (old.assets && /^\d+$/.test(old.assets)) {
        await rm(path.join(folder, old.assets), { recursive: true, force: true }).catch(() => {});
      }
    }
    return { artifact, version };
  }

  /**
   * Where one version's file is, and the folder of what it loads beside it. A version no
   * longer kept (a card made before the oldest were dropped) gives the latest.
   */
  async versionFile(
    threadId: string,
    id: string,
    n?: number,
  ): Promise<
    | { artifact: PublishedArtifact; version: StoredVersion; file: string; assets?: string }
    | undefined
  > {
    const artifact = await this.get(threadId, id);
    if (!artifact) return undefined;
    const version =
      (n === undefined ? undefined : artifact.versions.find((v) => v.n === n)) ?? latest(artifact);
    if (!/^\d+\.[a-z0-9]+$/.test(version.file)) return undefined;
    const folder = this.artifactDir(threadId, id);
    const file = path.join(folder, version.file);
    const assets =
      version.assets && /^\d+$/.test(version.assets)
        ? { assets: path.join(folder, version.assets) }
        : {};
    try {
      return (await stat(file)).isFile() ? { artifact, version, file, ...assets } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Forgets every artifact of a deleted thread. */
  async forget(threadId: string): Promise<void> {
    let folder: string;
    try {
      folder = this.threadDir(threadId);
    } catch {
      return;
    }
    if (existsSync(folder)) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

export const latest = (artifact: PublishedArtifact): StoredVersion =>
  artifact.versions[artifact.versions.length - 1]!;

/** One published artifact as the screens list it. */
export function listed(artifact: PublishedArtifact, thread: Thread): Artifact {
  const last = latest(artifact);
  return {
    threadId: thread.id,
    threadTitle: thread.title,
    projectId: thread.projectId,
    path: last.name,
    kind: artifact.kind,
    size: last.size,
    mtime: last.at,
    id: artifact.id,
    title: artifact.title,
    versions: artifact.versions.map(({ n, at, size }) => ({ n, at, size })),
  };
}

/** A file name made of an artifact's title: plain letters, digits and dashes. */
export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "artefact";
}
