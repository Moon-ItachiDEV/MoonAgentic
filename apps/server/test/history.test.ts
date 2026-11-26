import type { Item } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { historyBefore, projectMemoryContext } from "../src/history.ts";

const name = (id: string) => id;

describe("historyBefore", () => {
  it("tells the agent the conversation moved into a project", () => {
    const items: Item[] = [
      { id: "u0", kind: "user", text: "Une question", at: 1 },
      { id: "m", kind: "moved", projectId: "p", name: "MoonAgentic", at: 2 },
      { id: "u1", kind: "user", text: "Suite", at: 3 },
    ];
    expect(historyBefore(items, "u1", name, undefined, { threadId: "t" })).toContain(
      "(La conversation a été déplacée dans le projet MoonAgentic.)",
    );
  });

  it("keeps the full short conversation without duplication or omission markers", () => {
    const items: Item[] = [
      { id: "u0", kind: "user", text: "Demande initiale", at: 1 },
      { id: "a0", kind: "agent", text: "Première réponse", at: 2 },
      { id: "u1", kind: "user", text: "Suite", at: 3 },
    ];
    const history = historyBefore(items, "u1", name, undefined, { threadId: "t-1" })!;
    expect(history).toContain("Utilisateur : Demande initiale");
    expect(history).toContain("Agent : Première réponse");
    expect(history).not.toContain("omis");
    expect(history).not.toContain("coupé");
    expect(history.match(/Utilisateur : Demande initiale/g)).toHaveLength(1);
  });

  it("preserves the original user request alongside the most recent messages when truncated", () => {
    const items: Item[] = [
      { id: "u0", kind: "user", text: "Refaire l'export PDF sans casser Safari", at: 0 },
      ...Array.from({ length: 40 }, (_, n): Item => ({
        id: `a:${n}`,
        kind: "agent",
        text: `Étape ${n} ${"x".repeat(2_500)}`,
        at: n + 1,
      })),
      { id: "u-now", kind: "user", text: "Et les marges ?", at: 100 },
    ];
    const history = historyBefore(items, "u-now", name, undefined, { threadId: "t-42" })!;
    // Original user goal is preserved at the top, followed by omitted count + read_thread hint, then latest messages.
    expect(history).toContain("Utilisateur : Refaire l'export PDF sans casser Safari");
    expect(history).toMatch(
      /\(\d+ messages intermédiaires omis\. Tu peux relire les messages précédents avec read_thread \(thread_id : "t-42"\)\.\)/,
    );
    expect(history).toContain("Agent : Étape 39 ");
    expect(history).not.toContain("Agent : Étape 0 ");
    expect(history).not.toContain("(Le début de la conversation est coupé.)");
    expect(history.length).toBeLessThan(45_000);
    // Original request appears once and strictly before the latest kept turn.
    expect(history.indexOf("Refaire l'export PDF")).toBeLessThan(history.indexOf("Étape 39"));
  });

  it("omits the read_thread hint when no threadId is provided", () => {
    const items: Item[] = [
      { id: "u0", kind: "user", text: "Objectif de départ", at: 0 },
      ...Array.from({ length: 30 }, (_, n): Item => ({
        id: `a:${n}`,
        kind: "agent",
        text: `Tour ${n} ${"y".repeat(2_500)}`,
        at: n + 1,
      })),
      { id: "u-now", kind: "user", text: "Suite", at: 100 },
    ];
    const history = historyBefore(items, "u-now", name)!;
    expect(history).toContain("Utilisateur : Objectif de départ");
    expect(history).toMatch(/\(\d+ messages intermédiaires omis\.\)/);
    expect(history).not.toContain("read_thread");
  });
});

describe("projectMemoryContext", () => {
  it("returns undefined for empty or whitespace memory and formats non-empty notes", () => {
    expect(projectMemoryContext("")).toBeUndefined();
    expect(projectMemoryContext("   \n\t  ")).toBeUndefined();
    const formatted = projectMemoryContext("- Toujours lancer pnpm test\n")!;
    expect(formatted).toContain("Mémoire partagée du projet");
    expect(formatted).toContain("- Toujours lancer pnpm test");
  });
});
