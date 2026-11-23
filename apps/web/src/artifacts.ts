// « Artefacts »: how the list of pages, images and PDFs made by the agents is shown.
import type { Artifact, ArtifactKind, Project, Thread } from "@moonagentic/protocol";
import { fileSize } from "./file-tree.ts";
import { seenAgo } from "./remote.ts";

export type ArtifactFilter = "all" | ArtifactKind;

export const FILTERS: { id: ArtifactFilter; label: string }[] = [
  { id: "all", label: "Tout" },
  { id: "html", label: "Pages" },
  { id: "image", label: "Images" },
  { id: "pdf", label: "PDF" },
];

export const KIND_LABEL: Record<ArtifactKind, string> = {
  html: "Page HTML",
  image: "Image",
  pdf: "PDF",
};

/** The file's own name, without its folders. */
export const fileName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** The folder it sits in, or nothing at the root. */
export const folderOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

export const filtered = (artifacts: Artifact[], filter: ArtifactFilter) =>
  filter === "all" ? artifacts : artifacts.filter((a) => a.kind === filter);

/** How many there are of each kind, for the filters. */
export function counts(artifacts: Artifact[]): Record<ArtifactFilter, number> {
  const n: Record<ArtifactFilter, number> = { all: artifacts.length, html: 0, image: 0, pdf: 0 };
  for (const a of artifacts) n[a.kind] += 1;
  return n;
}

/** The line under its name: its thread, its project, when it was written and its size. */
export function artifactLine(artifact: Artifact, projects: Project[], now: number): string {
  const project = projects.find((p) => p.id === artifact.projectId)?.name;
  return [artifact.threadTitle, project, seenAgo(artifact.mtime, now), fileSize(artifact.size)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What changes when an agent may have written new files: the threads whose turn is under way.
 * The list is asked for again each time one of them ends.
 */
export const workingKey = (threads: Thread[]) =>
  threads
    .filter((t) => t.status === "running")
    .map((t) => t.id)
    .sort()
    .join(" ");
