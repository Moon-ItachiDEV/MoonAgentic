import type { PullRequestCheck, PullRequestInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { checksSummary, mergeBlocker, mergeWarning, pullRequestUrl } from "./pull-request.ts";

const check = (name: string, state: PullRequestCheck["state"]): PullRequestCheck => ({
  name,
  state,
});
const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  repo: "moon/demo",
  number: 42,
  url: "https://github.com/moon/demo/pull/42",
  title: "Ajoute le suivi",
  state: "open",
  head: "a".repeat(40),
  base: "main",
  conflicts: false,
  blocked: false,
  checks: [],
  ...over,
});

describe("a pull request, as told to the user", () => {
  it("recognises the address of a pull request, and only that", () => {
    expect(pullRequestUrl("https://github.com/moon/demo/pull/42")).toEqual({
      url: "https://github.com/moon/demo/pull/42",
      number: 42,
    });
    expect(pullRequestUrl("https://github.com/moon/demo/pull/42/files#r1")?.url).toBe(
      "https://github.com/moon/demo/pull/42",
    );
    expect(pullRequestUrl("https://github.com/moon/demo/issues/42")).toBeUndefined();
    expect(pullRequestUrl("https://github.com.evil.example/moon/demo/pull/42")).toBeUndefined();
    expect(pullRequestUrl("javascript:https://github.com/moon/demo/pull/42")).toBeUndefined();
  });

  it("sums the CI up: red wins over running, running over green, skipped does not count", () => {
    expect(checksSummary([])).toMatchObject({ tone: "none" });
    expect(checksSummary([check("Docs", "skipped")])).toMatchObject({ tone: "none" });
    expect(checksSummary([check("Lint", "passed"), check("Tests", "passed")])).toMatchObject({
      tone: "ok",
      label: "CI verte · 2 checks passés",
    });
    expect(
      checksSummary([check("Lint", "passed"), check("Tests", "pending"), check("Docs", "skipped")]),
    ).toMatchObject({ tone: "warn", label: "CI en cours · 1 sur 2 terminés" });
    const red = checksSummary([
      check("Lint", "passed"),
      check("Tests", "failed"),
      check("Windows", "pending"),
    ]);
    expect(red).toMatchObject({ tone: "err", label: "CI rouge · 1 check en échec, 1 en cours" });
    expect(red.failed.map((c) => c.name)).toEqual(["Tests"]);
  });

  it("holds the merge back for conflicts and drafts only", () => {
    expect(mergeBlocker(pr())).toBeNull();
    expect(mergeBlocker(pr({ conflicts: null }))).toBeNull();
    expect(mergeBlocker(pr({ checks: [check("Tests", "failed")] }))).toBeNull();
    expect(mergeBlocker(pr({ conflicts: true }))).toContain("Conflits avec main");
    expect(mergeBlocker(pr({ state: "draft" }))).toContain("Brouillon");
    expect(mergeBlocker(pr({ state: "merged", conflicts: true }))).toBeNull();
  });

  it("says what is not green before merging", () => {
    expect(mergeWarning(pr())).toBe("« Ajoute le suivi » sera mergée dans main.");
    expect(mergeWarning(pr({ checks: [check("Tests", "failed")] }))).toContain("CI est rouge");
    expect(mergeWarning(pr({ checks: [check("Tests", "pending")] }))).toContain("tourne encore");
    expect(mergeWarning(pr({ blocked: true }))).toContain("règles du dépôt");
  });
});
