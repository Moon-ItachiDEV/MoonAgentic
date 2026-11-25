// Audit of 2026-11-25, N26: what was typed in a thread was lost on opening another one,
// reloading the page or going back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
