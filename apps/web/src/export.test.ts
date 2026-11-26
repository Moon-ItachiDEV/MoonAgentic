import type { Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { exportFileName, threadMarkdown } from "./export.ts";

describe("thread export", () => {
  it("writes messages with their authors, plans and steps as Markdown", () => {
    const thread: Thread = {
      id: "t",
      projectId: "p",
      title: "Corrige l'écran",
      agentId: "b",
      status: "idle",
      permissionMode: "supervised",
      createdAt: 1,
      updatedAt: 1,
    };
    const md = threadMarkdown(
      thread,
      [
        { id: "1", kind: "user", text: "Corrige", at: 1 },
        { id: "2", kind: "thought", text: "secret", at: 1 },
        { id: "3", kind: "plan", entries: [{ content: "Lire", status: "completed" }], at: 1 },
        {
          id: "4",
          kind: "tool",
          title: "Lire a.ts",
          toolKind: "read",
          status: "completed",
          content: [],
          at: 1,
        },
        { id: "5", kind: "agent", text: "Fait.", at: 1 },
        { id: "6", kind: "handoff", from: "a", to: "b", at: 1 },
        { id: "7", kind: "agent", text: "Je reprends.", at: 1 },
        { id: "8", kind: "moved", projectId: "p", name: "Démo", at: 1 },
      ],
      [
        { id: "a", name: "Agent A", short: "A", available: true },
        { id: "b", name: "Agent B", short: "B", available: true },
      ],
    );
    expect(md).toBe(
      [
        "# Corrige l'écran",
        "",
        "## Toi",
        "",
        "Corrige",
        "",
        "**Plan**",
        "",
        "- [x] Lire",
        "",
        "> ✓ Lire a.ts",
        "",
        "## Agent A",
        "",
        "Fait.",
        "",
        "*Agent A passe le relais à Agent B.*",
        "",
        "## Agent B",
        "",
        "Je reprends.",
        "",
        "*Déplacée dans Démo.*",
        "",
      ].join("\n"),
    );
    expect(exportFileName("Corrige l'écran « Réglages »")).toBe("corrige-l-ecran-reglages.md");
  });

  it("names the images of a message, with or without text", () => {
    const image = { id: "i1", name: "maquette.png", mime: "image/png" as const, size: 12 };
    const md = threadMarkdown(
      { id: "t", title: "Image", agentId: "a" } as Thread,
      [
        { id: "1", kind: "user", text: "Regarde", images: [image], at: 1 },
        { id: "2", kind: "user", text: "", images: [image], at: 2 },
      ],
      [],
    );
    expect(md).toBe(
      [
        "# Image",
        "",
        "## Toi",
        "",
        "Regarde",
        "",
        "*Image jointe : maquette.png*",
        "",
        "## Toi",
        "",
        "*Image jointe : maquette.png*",
        "",
      ].join("\n"),
    );
  });
});
