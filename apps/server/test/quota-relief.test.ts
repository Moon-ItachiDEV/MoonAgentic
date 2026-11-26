import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentQuota, type Item, RESUME_TEXT, spentUntil } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { type Client, Hub } from "../src/hub.ts";
import { nextFallback, quotaStopped, resetFromText } from "../src/quota-relief.ts";
import type { QuotaReading } from "../src/quotas.ts";
import { Store } from "../src/store.ts";

const HOUR = 3_600_000;

describe("telling a quota that ran out from any other failure", () => {
  it("knows what each agent says when its subscription stops it", () => {
    for (const said of [
      "You've hit your limit · resets 3pm (Europe/Paris)",
      "Claude AI usage limit reached|1764166800",
      "5-hour limit reached ∙ resets 11pm",
      "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 3 minutes.",
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
      "You have exhausted your capacity on this model. Your quota will reset after 2h3m.",
      "Error code: 429 - insufficient_quota",
    ]) {
      expect(quotaStopped(said), said).toBe(true);
    }
  });

  it("leaves other failures alone, and a long answer that only talks about quotas", () => {
    expect(quotaStopped("Le démo a planté exprès.")).toBe(false);
    expect(quotaStopped("connection closed")).toBe(false);
    expect(quotaStopped(undefined, "Quota exceeded")).toBe(true);
    const long = `${"J'ai corrigé la lecture des quotas. ".repeat(30)} Le cas « quota exceeded » est géré.`;
    expect(quotaStopped(undefined, long)).toBe(false);
  });

  it("reads when the quota is back from the agent's own words", () => {
    const now = new Date(2026, 10, 26, 14, 0).getTime();
    expect(resetFromText("try again in 2 hours 3 minutes", now)).toBe(now + 2 * HOUR + 3 * 60_000);
    expect(resetFromText("Your quota will reset after 2h3m.", now)).toBe(
      now + 2 * HOUR + 3 * 60_000,
    );
    expect(resetFromText("You've hit your limit · resets 3pm", now)).toBe(
      new Date(2026, 10, 26, 15, 0).getTime(),
    );
    // A time already gone today is tomorrow's.
    expect(resetFromText("resets at 9:30", now)).toBe(new Date(2026, 10, 27, 9, 30).getTime());
    expect(resetFromText("Claude AI usage limit reached|1796000000", now)).toBe(1796000000_000);
    expect(resetFromText("You've hit your limit", now)).toBeUndefined();
  });

  it("reads a time of day in the time zone the agent names", () => {
    const now = Date.UTC(2026, 10, 26, 10, 0);
    // Paris is an hour ahead of UTC in November.
    expect(resetFromText("You've hit your limit · resets 3pm (Europe/Paris)", now)).toBe(
      Date.UTC(2026, 10, 26, 14, 0),
    );
    expect(resetFromText("resets 9am (UTC)", now)).toBe(Date.UTC(2026, 10, 27, 9, 0));
    expect(resetFromText("resets 11:30 (America/New_York)", now)).toBe(
      Date.UTC(2026, 10, 26, 16, 30),
    );
  });

  it("reads from the figures whether a model has no quota left, and until when", () => {
    const now = Date.now();
    const quota = (usedPercent: number, resetsAt?: number): AgentQuota => ({
      agentId: "claude",
      state: "ok",
      windows: [{ label: "Session de 5 h", short: "5 h", usedPercent, resetsAt }],
      extras: [],
    });
    expect(spentUntil(quota(100, now + HOUR), ["opus"], now)).toEqual({ until: now + HOUR });
    expect(spentUntil(quota(40, now + HOUR), ["opus"], now)).toBe(false);
    // Figures read before the reset they announced say nothing of now.
    expect(spentUntil(quota(100, now - 1), ["opus"], now)).toBe(false);
    expect(spentUntil(undefined, ["opus"], now)).toBeUndefined();
  });

  it("picks the first fallback that may run, in the project's order", () => {
    const spent = { agentId: "claude", model: "opus" };
    const models = [
      { agentId: "claude", model: "opus" },
      { agentId: "cursor", model: "auto" },
      { agentId: "codex", model: "astra" },
      { agentId: "antigravity", model: "neon" },
    ];
    const full: AgentQuota = {
      agentId: "codex",
      state: "ok",
      windows: [{ label: "Semaine", short: "semaine", usedPercent: 100 }],
      extras: [],
    };
    const options = {
      installed: (id: string) => id !== "cursor",
      quota: (id: string) => (id === "codex" ? full : undefined),
      names: (_: string, model: string) => [model],
    };
    const rules = { fallback: { on: true, back: true, models } };
    expect(nextFallback(rules, spent, options)).toEqual({ agentId: "antigravity", model: "neon" });
    expect(
      nextFallback({ ...rules, fallback: { ...rules.fallback, on: false } }, spent, options),
    ).toBeUndefined();
    expect(
      nextFallback(rules, spent, {
        ...options,
        tried: [{ agentId: "antigravity", model: "neon" }],
      }),
    ).toBeUndefined();
  });
});

class TestClient implements Client {
  send(): void {}
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A hub on the demo agents, whose models listed in the returned file have no quota left. */
function setup(readers: Record<string, () => Promise<QuotaReading>> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-quota-"));
  mkdirSync(path.join(dir, ".home"));
  const quotaFile = path.join(dir, "spent.txt");
  process.env.MOONAGENTIC_DEMO_QUOTA_FILE = quotaFile;
  const store = new Store(path.join(dir, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(dir, ".worktrees"),
    homeDir: path.join(dir, ".home"),
    quotaReaders: readers,
    quotaEveryMs: 0,
    quotaTickMs: 0,
  });
  const client = new TestClient();
  hub.connect(client);
  const projectId = hub.createProject("demo", dir);
  cleanups.push(async () => {
    delete process.env.MOONAGENTIC_DEMO_QUOTA_FILE;
    await hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const spend = (...models: string[]) => writeFileSync(quotaFile, models.join("\n"));
  const rules = (rules: Record<string, unknown>) =>
    hub.handle(client, { type: "project.setQuotaRules", projectId, ...rules } as never);
  return { dir, store, hub, client, projectId, spend, rules };
}

const userTexts = (items: Item[]) => items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
const replies = (items: Item[]) => items.flatMap((i) => (i.kind === "agent" ? [i.text] : []));

/** Waits until the thread's turns, and the steps between them, are over. */
async function settled(hub: Hub, store: Store, threadId: string, done: () => boolean) {
  await vi.waitFor(
    async () => {
      await hub.whenIdle(threadId);
      expect(done()).toBe(true);
    },
    { timeout: 12_000, interval: 50 },
  );
  await hub.whenIdle(threadId);
  return store.getThread(threadId)!;
}

describe("a thread whose quota runs out", () => {
  it("goes on at once with the project's fallback model, and says where it came from", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    spend("rapide");
    await rules({
      fallback: { on: true, back: true, models: [{ agentId: "demo", model: "precis" }] },
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });

    const thread = await settled(hub, store, threadId, () =>
      replies(store.listItems(threadId)).some((t) => t.includes("(modèle precis)")),
    );
    expect(thread.status).toBe("idle");
    expect(thread.model).toBe("precis");
    expect(thread.quota).toMatchObject({
      state: "relief",
      from: { agentId: "demo", model: "rapide" },
      to: { agentId: "demo", model: "precis" },
    });
    // « Try again in 2 hours »: when its own model is back.
    if (thread.quota?.state === "relief") {
      expect(thread.quota.back).toBeGreaterThan(Date.now() + HOUR);
    }
    expect(userTexts(store.listItems(threadId))).toEqual(["Un", RESUME_TEXT]);
  });

  it("goes back to its own model once its quota is reset, without starting a turn", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    spend("rapide");
    await rules({
      fallback: { on: true, back: true, models: [{ agentId: "demo", model: "precis" }] },
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await settled(hub, store, threadId, () => store.getThread(threadId)?.quota?.state === "relief");
    spend();

    // Not yet: its quota is not back.
    await hub.quotaTick(Date.now() + 60_000);
    expect(store.getThread(threadId)?.model).toBe("precis");
    await hub.quotaTick(Date.now() + 3 * HOUR);
    const thread = await settled(hub, store, threadId, () => !store.getThread(threadId)?.quota);
    expect(thread.model).toBe("rapide");
    expect(userTexts(store.listItems(threadId))).toEqual(["Un", RESUME_TEXT]);
  });

  it("hands the thread to another agent when the fallback is that agent's", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    spend("rapide");
    await rules({
      fallback: { on: true, back: false, models: [{ agentId: "demo-2", model: "precis" }] },
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });

    const thread = await settled(hub, store, threadId, () =>
      replies(store.listItems(threadId)).some((t) => t.includes("(modèle precis)")),
    );
    expect(thread.agentId).toBe("demo-2");
    expect(thread.status).toBe("idle");
    expect(store.listItems(threadId).some((i) => i.kind === "handoff")).toBe(true);
    // With no going back, the turn that went through leaves it just on its new model.
    expect(thread.quota).toBeUndefined();
  });

  it("waits for the reset and starts again by itself when the project asks", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    spend("rapide");
    await rules({ resume: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });

    const waiting = await settled(
      hub,
      store,
      threadId,
      () => store.getThread(threadId)?.quota?.state === "wait",
    );
    expect(waiting.status).toBe("error");
    expect(waiting.quota).toMatchObject({ state: "wait", agentId: "demo", model: "rapide" });
    const until = waiting.quota?.state === "wait" ? waiting.quota.until : undefined;
    expect(until).toBeGreaterThan(Date.now() + HOUR);

    // Before the reset nothing starts, even with the quota given back early.
    spend();
    await hub.quotaTick(Date.now() + 60_000);
    expect(userTexts(store.listItems(threadId))).toEqual(["Un"]);
    await hub.quotaTick(until! + 2 * 60_000);
    const thread = await settled(hub, store, threadId, () =>
      replies(store.listItems(threadId)).some((t) => t.includes("(modèle rapide)")),
    );
    expect(thread.status).toBe("idle");
    expect(thread.quota).toBeUndefined();
    expect(userTexts(store.listItems(threadId))).toEqual(["Un", RESUME_TEXT]);
  });

  it("waits longer when the figures say the quota is not back yet", async () => {
    const later = Date.now() + 5 * HOUR;
    const { hub, store, projectId, spend, rules } = setup({
      demo: () =>
        Promise.resolve({
          state: "ok",
          windows: [{ label: "Session de 5 h", short: "5 h", usedPercent: 100, resetsAt: later }],
          extras: [],
        }),
    });
    spend("rapide");
    await rules({ resume: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await settled(hub, store, threadId, () => store.getThread(threadId)?.quota?.state === "wait");

    await hub.quotaTick(Date.now() + 3 * HOUR);
    const thread = store.getThread(threadId)!;
    expect(thread.quota).toMatchObject({ state: "wait", until: later });
    expect(userTexts(store.listItems(threadId))).toEqual(["Un"]);
  });

  it("never runs both: with every fallback spent too, it waits on its own model", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    spend("rapide", "precis");
    await rules({
      resume: true,
      fallback: { on: true, back: true, models: [{ agentId: "demo", model: "precis" }] },
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });

    const thread = await settled(
      hub,
      store,
      threadId,
      () => store.getThread(threadId)?.quota?.state === "wait",
    );
    expect(thread.model).toBe("rapide");
    expect(thread.quota).toMatchObject({ state: "wait", agentId: "demo", model: "rapide" });
    // The fallback was tried once, and nothing else was sent.
    expect(userTexts(store.listItems(threadId))).toEqual(["Un", RESUME_TEXT]);
  });

  it("« Attendre » leaves the fallback for its own model, to start again at the reset", async () => {
    const { hub, store, client, projectId, spend, rules } = setup();
    spend("rapide");
    await rules({
      fallback: { on: true, back: true, models: [{ agentId: "demo", model: "precis" }] },
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await settled(hub, store, threadId, () => store.getThread(threadId)?.quota?.state === "relief");

    await hub.handle(client, { type: "thread.quotaWait", threadId });
    const thread = store.getThread(threadId)!;
    expect(thread.model).toBe("rapide");
    expect(thread.quota).toMatchObject({ state: "wait", agentId: "demo", model: "rapide" });
  });

  it("stops waiting once the user writes, and leaves other failures as they were", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    spend("rapide");
    await rules({ resume: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await settled(hub, store, threadId, () => store.getThread(threadId)?.quota?.state === "wait");

    spend();
    hub.send(threadId, "boom");
    await hub.whenIdle(threadId);
    const thread = store.getThread(threadId)!;
    expect(thread.status).toBe("error");
    expect(thread.error).toContain("Le démo a planté exprès.");
    expect(thread.quota).toBeUndefined();
  });

  it("tries each fallback once, never going round them again", async () => {
    const { hub, store, projectId, spend, rules } = setup();
    // Every model spent, and no figures to tell it beforehand.
    spend("rapide", "precis");
    await rules({
      fallback: {
        on: true,
        back: true,
        models: [
          { agentId: "demo", model: "precis" },
          { agentId: "demo-2", model: "rapide" },
        ],
      },
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    // Going round them again would leave it on a fallback for ever.
    const thread = await settled(
      hub,
      store,
      threadId,
      () => userTexts(store.listItems(threadId)).length >= 3 && !store.getThread(threadId)?.quota,
    );
    // Each fallback once, then back on its own model.
    expect(userTexts(store.listItems(threadId))).toEqual(["Un", RESUME_TEXT, RESUME_TEXT]);
    expect(thread.agentId).toBe("demo");
    expect(thread.model).toBe("rapide");
  });

  it("does not start a thread the user stopped waiting while the figures were read", async () => {
    let release = () => {};
    let reads = 0;
    const { hub, store, client, projectId, spend, rules } = setup({
      demo: () => {
        reads += 1;
        // The first reading is the turn's own; the tick's one waits for the user.
        if (reads === 1) return Promise.resolve({ state: "none", windows: [], extras: [] });
        return new Promise((resolve) => {
          release = () => resolve({ state: "none", windows: [], extras: [] });
        });
      },
    });
    spend("rapide");
    await rules({ resume: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await settled(hub, store, threadId, () => store.getThread(threadId)?.quota?.state === "wait");
    spend();
    reads = 1;
    // The last reading is forgotten, so the tick reads the figures again.
    (hub as unknown as { quotas: { lastAsked: Map<string, number> } }).quotas.lastAsked.clear();
    const tick = hub.quotaTick(Date.now() + 3 * HOUR);
    await vi.waitFor(() => expect(reads).toBe(2));
    await hub.handle(client, { type: "thread.quotaCancel", threadId });
    release();
    await tick;
    await hub.whenIdle(threadId);
    expect(userTexts(store.listItems(threadId))).toEqual(["Un"]);
  });

  it("does not start at once on a restart a thread that waits with no time given", async () => {
    const { dir, hub, store, projectId, spend, rules } = setup();
    spend("rapide|You've hit your usage limit.");
    await rules({ resume: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    const waiting = await settled(
      hub,
      store,
      threadId,
      () => store.getThread(threadId)?.quota?.state === "wait",
    );
    expect(waiting.quota).not.toHaveProperty("until");
    await hub.close();
    // Started again: nothing says the quota is back, so it waits its turn to be tried.
    const again = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, ".worktrees"),
      homeDir: path.join(dir, ".home"),
      quotaEveryMs: 0,
      quotaTickMs: 0,
    });
    cleanups.unshift(() => again.close());
    const watched = (again as unknown as { quotaThreads: Set<string> }).quotaThreads;
    await vi.waitFor(() => expect(watched.has(threadId)).toBe(true));
    await again.quotaTick(Date.now() + 60_000);
    await again.whenIdle(threadId);
    expect(userTexts(store.listItems(threadId))).toEqual(["Un"]);
  });

  it("forgets a waiting thread once it is deleted", async () => {
    const { hub, store, client, projectId, spend, rules } = setup();
    spend("rapide|You've hit your usage limit.");
    await rules({ resume: true });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await settled(hub, store, threadId, () => store.getThread(threadId)?.quota?.state === "wait");
    const inner = hub as unknown as {
      quotaThreads: Set<string>;
      quotaRetryAt: Map<string, number>;
    };
    inner.quotaRetryAt.set(threadId, Date.now());
    await hub.handle(client, { type: "thread.delete", requestId: "d1", threadId });
    expect(inner.quotaThreads.has(threadId)).toBe(false);
    expect(inner.quotaRetryAt.has(threadId)).toBe(false);
  });

  it("keeps the project's rules for every device", async () => {
    const { hub, projectId, rules } = setup();
    await rules({ resume: true });
    await rules({
      fallback: { on: true, back: false, models: [{ agentId: "demo-2", model: "rapide" }] },
    });
    expect(hub.snapshot().projects.find((p) => p.id === projectId)?.quota).toEqual({
      resume: true,
      fallback: { on: true, back: false, models: [{ agentId: "demo-2", model: "rapide" }] },
    });
  });
});
