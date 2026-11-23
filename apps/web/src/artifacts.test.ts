import type { Artifact, Project, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { artifactLine, counts, fileName, filtered, folderOf, workingKey } from "./artifacts.ts";

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  threadId: "t1",
  threadTitle: "Refaire l'accueil",
  projectId: "p1",
  path: "maquettes/accueil.html",
  kind: "html",
  size: 2048,
  mtime: 0,
  ...over,
});

describe("artifacts", () => {
  it("splits a path into its name and its folder", () => {
    expect(fileName("maquettes/accueil.html")).toBe("accueil.html");
    expect(folderOf("maquettes/v2/accueil.html")).toBe("maquettes/v2");
    expect(fileName("logo.png")).toBe("logo.png");
    expect(folderOf("logo.png")).toBe("");
  });

  it("filters and counts by kind", () => {
    const list = [
      artifact(),
      artifact({ path: "a.png", kind: "image" }),
      artifact({ path: "b.svg", kind: "image" }),
    ];
    expect(counts(list)).toEqual({ all: 3, html: 1, image: 2, pdf: 0 });
    expect(filtered(list, "image").map((a) => a.path)).toEqual(["a.png", "b.svg"]);
    expect(filtered(list, "all")).toBe(list);
  });

  it("says which thread and project it comes from, when and how big", () => {
    const projects = [{ id: "p1", name: "site" } as Project];
    expect(artifactLine(artifact(), projects, 10 * 60_000)).toBe(
      "Refaire l'accueil · site · il y a 10 min · 2 Ko",
    );
    // A project gone since: left out.
    expect(artifactLine(artifact({ size: 15 }), [], 0)).toBe(
      "Refaire l'accueil · à l'instant · 15 o",
    );
  });

  it("changes its key when a turn starts or ends, not otherwise", () => {
    const t = (id: string, status: Thread["status"]) => ({ id, status }) as Thread;
    const before = workingKey([t("b", "running"), t("a", "idle")]);
    expect(workingKey([t("a", "idle"), t("b", "running")])).toBe(before);
    expect(workingKey([t("a", "running"), t("b", "running")])).not.toBe(before);
    expect(workingKey([t("a", "idle"), t("b", "idle")])).toBe("");
  });
});
