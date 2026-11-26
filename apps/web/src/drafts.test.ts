// Audit of 2026-11-25, N26: what was typed in a thread was lost on opening another one,
// reloading the page or going back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDrafts,
  forgetDrafts,
  forgetDraftsInMemory,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  readDraft,
  writeDraft,
} from "./drafts.ts";

let kept: Map<string, string>;
beforeEach(() => {
  kept = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  });
  forgetDraftsInMemory();
});
afterEach(() => vi.unstubAllGlobals());

describe("a thread's draft", () => {
  it("is kept for that thread alone, through a reload", () => {
    writeDraft("a", "Moitié d'une");
    writeDraft("b", "Autre chose");
    forgetDraftsInMemory();
    expect(readDraft("a")).toBe("Moitié d'une");
    expect(readDraft("b")).toBe("Autre chose");
    expect(readDraft("c")).toBe("");
  });

  it("is forgotten once nothing is typed, as after sending it", () => {
    writeDraft("a", "Envoyé");
    writeDraft("a", "");
    forgetDraftsInMemory();
    expect(readDraft("a")).toBe("");
  });

  it("keeps the most recent threads' only, and a bounded length", () => {
    vi.useFakeTimers();
    for (let n = 0; n <= MAX_DRAFTS; n++) {
      vi.setSystemTime(1_000 + n);
      writeDraft(`t${n}`, `texte ${n}`);
    }
    vi.useRealTimers();
    forgetDraftsInMemory();
    expect(readDraft("t0")).toBe("");
    expect(readDraft(`t${MAX_DRAFTS}`)).toBe(`texte ${MAX_DRAFTS}`);
    writeDraft("long", "x".repeat(MAX_DRAFT_CHARS + 10));
    expect(readDraft("long")).toHaveLength(MAX_DRAFT_CHARS);
  });

  it("never drops the draft just written on a same-millisecond tie at MAX_DRAFTS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    writeDraft("0", "numeric-key-oldest");
    for (let n = 1; n < MAX_DRAFTS; n++) {
      writeDraft(`t${n}`, `texte ${n}`);
    }
    writeDraft("latest", "tout frais");
    vi.useRealTimers();
    forgetDraftsInMemory();
    expect(readDraft("latest")).toBe("tout frais");
  });

  it("preserves drafts written concurrently in another tab", () => {
    writeDraft("tab1", "Depuis onglet 1");
    // Simulate another tab updating localStorage directly without touching this tab's memory.
    const raw = JSON.parse(kept.get("moonagentic.drafts") ?? "{}") as Record<
      string,
      { text: string; at: number }
    >;
    raw["tab2"] = { text: "Depuis onglet 2", at: Date.now() + 10 };
    kept.set("moonagentic.drafts", JSON.stringify(raw));

    writeDraft("tab1-other", "Encore onglet 1");
    forgetDraftsInMemory();
    expect(readDraft("tab1")).toBe("Depuis onglet 1");
    expect(readDraft("tab2")).toBe("Depuis onglet 2");
    expect(readDraft("tab1-other")).toBe("Encore onglet 1");
  });

  it("evicts oldest drafts when localStorage hits quota so the latest still persists", () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 180) throw new Error("QuotaExceededError");
        kept.set(k, v);
      },
      removeItem: (k: string) => void kept.delete(k),
    });
    vi.setSystemTime(1_000);
    writeDraft("old-1", "a".repeat(60));
    vi.setSystemTime(2_000);
    writeDraft("old-2", "b".repeat(60));
    vi.setSystemTime(3_000);
    writeDraft("newest", "c".repeat(80));
    vi.useRealTimers();

    forgetDraftsInMemory();
    expect(readDraft("newest")).toBe("c".repeat(80));
    expect(readDraft("old-1")).toBe("");
  });

  it("forgets drafts for removed threads and clears all drafts on demand", () => {
    writeDraft("t1", "Un");
    writeDraft("t2", "Deux");
    writeDraft("t3", "Trois");
    forgetDrafts(["t1", "t3"]);
    expect(readDraft("t1")).toBe("");
    expect(readDraft("t2")).toBe("Deux");
    expect(readDraft("t3")).toBe("");

    clearAllDrafts();
    expect(kept.has("moonagentic.drafts")).toBe(false);
    expect(readDraft("t2")).toBe("");
  });

  it("stays in the page when the device keeps nothing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private");
      },
      setItem: () => {
        throw new Error("private");
      },
    });
    forgetDraftsInMemory();
    writeDraft("a", "Gardé ici");
    expect(readDraft("a")).toBe("Gardé ici");
  });

  it("ignores what it cannot read", () => {
    kept.set("moonagentic.drafts", '{"a":{"text":3},"b":{"text":"ok","at":1},"c":null}');
    expect(readDraft("a")).toBe("");
    expect(readDraft("b")).toBe("ok");
  });
});
