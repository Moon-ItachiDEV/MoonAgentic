import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  askCodex,
  parseClaudeUsage,
  parseCodexLimits,
  Quotas,
  readClaudeQuota,
  readCodexQuota,
  toTime,
} from "../src/quotas.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "quotas-"));

describe("Claude Code's quotas", () => {
  const usage = {
    five_hour: { utilization: 62, resets_at: "2026-11-23T13:20:00Z" },
    seven_day: { utilization: 31.4, resets_at: "2026-11-30T08:00:00Z" },
    seven_day_opus: { utilization: 48, resets_at: null },
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false },
  };

  it("reads each window, its reset time and the extra credits", () => {
    const reading = parseClaudeUsage(usage, "Abonnement Max");
    expect(reading.state).toBe("ok");
    expect(reading.plan).toBe("Abonnement Max");
    expect(reading.windows).toEqual([
      {
        label: "Session de 5 h",
        short: "5 h",
        usedPercent: 62,
        resetsAt: Date.parse("2026-11-23T13:20:00Z"),
      },
      {
        label: "Semaine, tous modèles",
        short: "semaine",
        usedPercent: 31.4,
        resetsAt: Date.parse("2026-11-30T08:00:00Z"),
      },
      { label: "Semaine, Opus", short: "semaine Opus", usedPercent: 48 },
    ]);
    expect(reading.extras).toEqual([{ label: "Crédits en plus", value: "Désactivés" }]);
  });

  it("says when nothing came back rather than showing an empty card", () => {
    expect(parseClaudeUsage({}).state).toBe("unreadable");
  });

  const credentials = (oauth: object | undefined) => {
    const file = path.join(tmp(), ".credentials.json");
    writeFileSync(file, JSON.stringify(oauth ? { claudeAiOauth: oauth } : {}));
    return file;
  };

  it("asks Anthropic with the saved sign-in, and names the plan", async () => {
    const file = credentials({ accessToken: "tok", expiresAt: 2e12, subscriptionType: "max" });
    let asked: { url: string; headers: Record<string, string> } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      asked = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify(usage), { status: 200 });
    }) as unknown as typeof fetch;
    const reading = await readClaudeQuota(file, fetcher, 1e12);
    expect(asked?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(asked?.headers.Authorization).toBe("Bearer tok");
    expect(asked?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(reading.plan).toBe("Abonnement Max");
    expect(reading.windows).toHaveLength(3);
  });

  it("does not ask with an expired sign-in, and says why", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const reading = await readClaudeQuota(
      credentials({ accessToken: "tok", expiresAt: 1_700_000_000_000 }),
      fetcher,
      2e12,
    );
    expect(called).toBe(false);
    expect(reading.state).toBe("unreadable");
    expect(reading.note).toMatch(/expiré/);
  });

  it("says a refused sign-in, a missing one, and an API key apart", async () => {
    const refused = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const r1 = await readClaudeQuota(credentials({ accessToken: "tok" }), refused, 1);
    expect(r1).toMatchObject({ state: "unreadable", note: expect.stringMatching(/expiré/) });
    const r2 = await readClaudeQuota(path.join(tmp(), "none.json"), refused, 1);
    expect(r2.state).toBe("unreadable");
    const r3 = await readClaudeQuota(credentials(undefined), refused, 1);
    expect(r3.state).toBe("none");
  });
});

describe("Codex's quotas", () => {
  const limits = {
    rateLimits: {
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_795_000_000 },
      secondary: { usedPercent: 86, windowDurationMins: 10_080, resetsAt: 1_795_400_000 },
      planType: "plus",
    },
  };

  it("names the windows from their length and reads reset times in seconds", () => {
    const reading = parseCodexLimits(limits);
    expect(reading).toMatchObject({
      state: "ok",
      plan: "ChatGPT Plus",
      windows: [
        { label: "Session de 5 h", short: "5 h", usedPercent: 18, resetsAt: 1_795_000_000_000 },
        { label: "Semaine", short: "semaine", usedPercent: 86, resetsAt: 1_795_400_000_000 },
      ],
    });
  });

  it("prefers Codex's own limit when several are listed, and spots an API key", () => {
    const byId = {
      rateLimits: limits.rateLimits,
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 3, windowDurationMins: 1440 } } },
    };
    expect(parseCodexLimits(byId).windows).toEqual([
      { label: "Fenêtre de 1 j", short: "1 j", usedPercent: 3 },
    ]);
    expect(parseCodexLimits(limits, { account: { type: "apiKey" } }).state).toBe("none");
  });

  it("talks to codex app-server one JSON line at a time", async () => {
    // A stand-in for `codex app-server`: answers each request by its method.
    const script = path.join(tmp(), "codex.mjs");
    writeFileSync(
      script,
      `import readline from "node:readline";
if (process.argv[2] !== "app-server") process.exit(2);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? {}
    : m.method === "account/read" ? { account: { type: "chatgpt", planType: "pro" } }
    : m.method === "account/rateLimits/read" ? ${JSON.stringify(limits)}
    : null;
  process.stdout.write(JSON.stringify({ id: m.id, result }) + "\\n");
});`,
    );
    const codex = { command: process.execPath, args: [script] };
    const answers = await askCodex(codex, ["account/read", "account/rateLimits/read"]);
    expect(answers["account/read"]).toEqual({ account: { type: "chatgpt", planType: "pro" } });
    const reading = await readCodexQuota(codex);
    expect(reading.state).toBe("ok");
    expect(reading.windows.map((w) => w.usedPercent)).toEqual([18, 86]);
  });

  it("says when codex is missing or does not answer", async () => {
    expect((await readCodexQuota(undefined)).note).toMatch(/introuvable/);
    const silent = path.join(tmp(), "silent.mjs");
    writeFileSync(silent, "setTimeout(() => {}, 60_000);");
    await expect(
      askCodex({ command: process.execPath, args: [silent] }, ["account/read"], 500),
    ).rejects.toThrow(/à temps/);
  });
});

describe("Quotas", () => {
  const setup = (available: string[]) => {
    const sent: ServerMessage[] = [];
    let now = 0;
    let reads = 0;
    const quotas = new Quotas({
      readers: {
        a: async () => {
          reads++;
          return {
            state: "ok",
            windows: [{ label: "5 h", short: "5 h", usedPercent: reads }],
            extras: [],
          };
        },
        b: async () => {
          throw new Error("panne");
        },
      },
      available: () => available,
      broadcast: (m) => sent.push(m),
      now: () => now,
    });
    return { quotas, sent, reads: () => reads, tick: (ms: number) => (now += ms) };
  };

  it("reads only installed agents, and tells every client", async () => {
    const { quotas, sent } = setup(["a", "c"]);
    await quotas.refresh();
    expect(quotas.list().map((q) => q.agentId)).toEqual(["a"]);
    expect(sent.at(-1)).toMatchObject({ type: "quotas", quotas: [{ agentId: "a", readAt: 0 }] });
  });

  it("turns a failed read into an unreadable card", async () => {
    const { quotas } = setup(["b"]);
    await quotas.refresh();
    expect(quotas.list()[0]).toMatchObject({
      state: "unreadable",
      note: expect.stringMatching(/panne/),
    });
  });

  it("does not ask again too soon when the user asks", async () => {
    const { quotas, reads, tick } = setup(["a"]);
    await quotas.asked();
    await quotas.asked();
    expect(reads()).toBe(1);
    tick(20_000);
    await quotas.asked("a");
    expect(reads()).toBe(2);
  });

  it("reads one at a time per agent", async () => {
    const { quotas, reads } = setup(["a"]);
    await Promise.all([quotas.refresh(), quotas.refresh()]);
    expect(reads()).toBe(1);
  });
});

describe("toTime", () => {
  it("takes seconds, milliseconds and ISO dates", () => {
    expect(toTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toTime(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toTime("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(toTime(null)).toBeUndefined();
  });
});
