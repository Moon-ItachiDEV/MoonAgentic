import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  askCodex,
  parseClaudeUsage,
  parseCodexLimits,
  parseRetryAfterMs,
  type QuotaReader,
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

  it("ignores non-finite values and says when nothing came back", () => {
    expect(parseClaudeUsage({}).state).toBe("unreadable");
    const reading = parseClaudeUsage({
      five_hour: { utilization: Number.NaN },
      seven_day: { utilization: Number.POSITIVE_INFINITY },
      seven_day_opus: { utilization: 12 },
      extra_usage: { is_enabled: true, utilization: Number.NaN },
    });
    expect(reading.state).toBe("ok");
    expect(reading.windows).toHaveLength(1);
    expect(reading.extras).toEqual([{ label: "Crédits en plus", value: "Activés" }]);
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
    const reading = await readClaudeQuota(file, fetcher, 1e12, undefined, {});
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
      undefined,
      {},
    );
    expect(called).toBe(false);
    expect(reading.state).toBe("unreadable");
    expect(reading.transient).toBeUndefined();
    expect(reading.note).toMatch(/expiré/);
  });

  it("tells 401, 403, 429, 5xx, missing sign-in, and ANTHROPIC_API_KEY apart", async () => {
    const file = credentials({ accessToken: "tok" });
    const withStatus = (status: number, headers?: Record<string, string>) =>
      (async () => new Response("", { status, headers })) as unknown as typeof fetch;

    const r401 = await readClaudeQuota(file, withStatus(401), 1, undefined, {});
    expect(r401).toMatchObject({ state: "unreadable", note: expect.stringMatching(/expiré/) });
    expect(r401.transient).toBeUndefined();

    const r403 = await readClaudeQuota(file, withStatus(403), 1, undefined, {});
    expect(r403).toMatchObject({ state: "unreadable", note: expect.stringMatching(/403/) });
    expect(r403.transient).toBeUndefined();

    const r429 = await readClaudeQuota(
      file,
      withStatus(429, { "retry-after": "180" }),
      1,
      undefined,
      {},
    );
    expect(r429).toMatchObject({ state: "unreadable", transient: true, retryAfterMs: 180_000 });

    const r429Zero = await readClaudeQuota(
      file,
      withStatus(429, { "retry-after": "0" }),
      1,
      undefined,
      {},
    );
    expect(r429Zero).toMatchObject({ state: "unreadable", transient: true });
    expect(r429Zero.retryAfterMs).toBeGreaterThan(0);

    const r503 = await readClaudeQuota(file, withStatus(503), 1, undefined, {});
    expect(r503).toMatchObject({ state: "unreadable", transient: true });

    const rMissing = await readClaudeQuota(
      path.join(tmp(), "none.json"),
      withStatus(401),
      1,
      undefined,
      {},
    );
    expect(rMissing.state).toBe("unreadable");

    const rNoOauth = await readClaudeQuota(
      credentials(undefined),
      withStatus(401),
      1,
      undefined,
      {},
    );
    expect(rNoOauth.state).toBe("unreadable");

    const rApiKey = await readClaudeQuota(
      path.join(tmp(), "none.json"),
      withStatus(401),
      1,
      undefined,
      { ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    expect(rApiKey.state).toBe("none");
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

  it("prefers Codex's own limit, formats sub-hour windows, and spots API key or signed-out account", () => {
    const byId = {
      rateLimits: limits.rateLimits,
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 3, windowDurationMins: 1440 },
          secondary: { usedPercent: 12, windowDurationMins: 30 },
        },
      },
    };
    expect(parseCodexLimits(byId).windows).toEqual([
      { label: "Fenêtre de 1 j", short: "1 j", usedPercent: 3 },
      { label: "Fenêtre de 30 min", short: "30 min", usedPercent: 12 },
    ]);
    expect(parseCodexLimits(limits, { account: { type: "apiKey" } }).state).toBe("none");
    expect(parseCodexLimits({}, { account: null })).toMatchObject({
      state: "unreadable",
      note: expect.stringMatching(/codex login/),
    });
    expect(parseCodexLimits({ rateLimits: { primary: { usedPercent: Number.NaN } } }).state).toBe(
      "unreadable",
    );
  });

  it("waits for initialize before sending initialized and requests, and closes stdin cleanly", async () => {
    // Enforces strict codex app-server handshake order: rejects requests before initialize + initialized.
    const script = path.join(tmp(), "codex.mjs");
    writeFileSync(
      script,
      `import readline from "node:readline";
if (process.argv[2] !== "app-server") process.exit(2);
let phase = "init";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (phase === "init") {
    if (m.method !== "initialize") {
      process.stdout.write(JSON.stringify({ id: m.id, error: { message: "Not initialized" } }) + "\\n");
      return;
    }
    phase = "ack";
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n");
    return;
  }
  if (phase === "ack") {
    if (m.method === "initialized") {
      phase = "ready";
      return;
    }
    process.stdout.write(JSON.stringify({ id: m.id, error: { message: "Not initialized" } }) + "\\n");
    return;
  }
  if (m.id === undefined) return;
  const result = m.method === "account/read" ? { account: { type: "chatgpt", planType: "pro" } }
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

  it("reports initialize errors immediately, captures stderr on crash, and marks timeouts transient", async () => {
    expect((await readCodexQuota(undefined)).note).toMatch(/introuvable/);

    const badInit = path.join(tmp(), "bad-init.mjs");
    writeFileSync(
      badInit,
      `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const m = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: m.id, error: { message: "bad protocol" } }) + "\\n");
});`,
    );
    await expect(
      askCodex({ command: process.execPath, args: [badInit] }, ["account/read"], 5_000),
    ).rejects.toThrow(/bad protocol/);

    const crashing = path.join(tmp(), "crash.mjs");
    writeFileSync(crashing, `console.error("fatal boom"); process.exit(1);`);
    await expect(
      askCodex({ command: process.execPath, args: [crashing] }, ["account/read"], 5_000),
    ).rejects.toThrow(/fatal boom/);

    const silent = path.join(tmp(), "silent.mjs");
    writeFileSync(silent, "setTimeout(() => {}, 60_000);");
    const timedOut = await readCodexQuota(
      { command: process.execPath, args: [silent] },
      (c, m, _t, s) => askCodex(c, m, 300, s),
    );
    expect(timedOut).toMatchObject({
      state: "unreadable",
      transient: true,
      note: expect.stringMatching(/à temps/),
    });
  });
});

describe("Quotas", () => {
  const setup = (
    available: string[],
    options?: {
      active?: () => boolean;
      extraReaders?: Record<string, QuotaReader>;
    },
  ) => {
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
        ...options?.extraReaders,
      },
      available: () => available,
      broadcast: (m) => sent.push(m),
      active: options?.active,
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

  it("turns a failed read into an unreadable card without a misleading readAt", async () => {
    const { quotas } = setup(["b"]);
    await quotas.refresh();
    expect(quotas.list()[0]).toMatchObject({
      state: "unreadable",
      note: expect.stringMatching(/panne/),
    });
    expect(quotas.list()[0]?.readAt).toBeUndefined();
  });

  it("keeps the last valid figures on transient failures, backs off 429, and clears the note on recovery", async () => {
    let phase: "ok" | "429" | "ok2" = "ok";
    let calls = 0;
    const { quotas, tick } = setup(["c"], {
      extraReaders: {
        c: async () => {
          calls++;
          if (phase === "ok") {
            return {
              state: "ok",
              windows: [{ label: "5 h", short: "5 h", usedPercent: 40 }],
              extras: [],
            };
          }
          if (phase === "429") {
            return {
              state: "unreadable",
              windows: [],
              extras: [],
              note: "Limite 429.",
              transient: true,
              retryAfterMs: 120_000,
            };
          }
          return {
            state: "ok",
            windows: [{ label: "5 h", short: "5 h", usedPercent: 45 }],
            extras: [],
          };
        },
      },
    });
    await quotas.refresh();
    expect(quotas.list()[0]).toMatchObject({ state: "ok", readAt: 0 });

    tick(60_000);
    phase = "429";
    await quotas.refresh();
    expect(quotas.list()[0]).toMatchObject({
      state: "ok",
      readAt: 0,
      note: "Limite 429.",
      windows: [{ usedPercent: 40 }],
    });

    // Automatic refresh respects backoff until retryAt elapses.
    tick(60_000);
    await quotas.refresh();
    expect(calls).toBe(2);

    // Manual asked() bypasses automatic backoff once ASKED_GAP_MS has passed.
    phase = "ok2";
    await quotas.asked("c");
    expect(calls).toBe(3);
    expect(quotas.list()[0]).toMatchObject({
      state: "ok",
      readAt: 120_000,
      windows: [{ usedPercent: 45 }],
    });
    expect(quotas.list()[0]?.note).toBeUndefined();
  });

  it("shows loading while the first read is in flight, and never re-reads fixed cards", async () => {
    let release!: () => void;
    let fixedCalls = 0;
    const { quotas, sent, tick } = setup(["slow", "fixed"], {
      extraReaders: {
        slow: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                state: "ok",
                windows: [{ label: "5 h", short: "5 h", usedPercent: 10 }],
                extras: [],
              });
          }),
        fixed: async () => {
          fixedCalls++;
          return { state: "unreadable", windows: [], extras: [], fixed: true, note: "Fixe." };
        },
      },
    });
    const pending = quotas.refresh();
    expect(quotas.list().find((q) => q.agentId === "slow")?.state).toBe("loading");
    release();
    await pending;
    const broadcastsAfterFirst = sent.length;
    tick(1_000);
    const pending2 = quotas.refresh();
    release();
    await pending2;
    expect(fixedCalls).toBe(1);
    expect(sent.length).toBe(broadcastsAfterFirst + 1);
  });

  it("re-reads immediately after a turn when the previous reading was unreadable", async () => {
    let expired = true;
    let calls = 0;
    const { quotas, tick } = setup(["claude"], {
      extraReaders: {
        claude: async () => {
          calls++;
          return expired
            ? { state: "unreadable", windows: [], extras: [], note: "Expiré." }
            : {
                state: "ok",
                windows: [{ label: "5 h", short: "5 h", usedPercent: 25 }],
                extras: [],
              };
        },
      },
    });
    await quotas.refresh();
    expect(quotas.list()[0]?.state).toBe("unreadable");
    tick(10_000);
    expired = false;
    quotas.afterTurn("claude");
    // Wait for the in-flight refresh triggered by afterTurn.
    await quotas.refresh("claude", 60_000);
    expect(calls).toBe(2);
    expect(quotas.list()[0]?.state).toBe("ok");
  });

  it("does not poll on start when inactive, and reads when a client connects", async () => {
    let hasClient = false;
    const { quotas, reads } = setup(["a"], { active: () => hasClient });
    quotas.start(60_000);
    expect(reads()).toBe(0);
    hasClient = true;
    quotas.onClientConnect();
    await quotas.refresh("a", 60_000);
    expect(reads()).toBe(1);
    quotas.close();
  });

  it("aborts in-flight readers on close", async () => {
    let aborted = false;
    const { quotas } = setup(["c"], {
      extraReaders: {
        c: (signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              resolve({ state: "unreadable", windows: [], extras: [], note: "Annulé." });
            });
          }),
      },
    });
    const pending = quotas.refresh();
    quotas.close();
    await pending;
    expect(aborted).toBe(true);
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

describe("toTime and parseRetryAfterMs", () => {
  it("takes seconds, milliseconds and ISO dates", () => {
    expect(toTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toTime(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toTime("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(toTime(null)).toBeUndefined();
  });

  it("parses positive Retry-After delays and ignores zero", () => {
    const now = Date.parse("2026-11-23T10:00:00Z");
    expect(parseRetryAfterMs("0", now)).toBeUndefined();
    expect(parseRetryAfterMs("90", now)).toBe(90_000);
    expect(parseRetryAfterMs("Mon, 23 Nov 2026 10:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfterMs("invalid", now)).toBeUndefined();
  });
});
