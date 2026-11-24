import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  agyCliServers,
  agyHubServers,
  agyLogPort,
  askCodex,
  claudeReading,
  parseAntigravityQuota,
  parseClaudeUsage,
  parseCodexLimits,
  probeClaude,
  type QuotaReader,
  Quotas,
  readAntigravityQuota,
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
      { label: "Semaine, Opus", short: "semaine Opus", model: "Opus", usedPercent: 48 },
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

  it("reads Fable and other per-model weekly windows, and names their model", () => {
    const reading = parseClaudeUsage({
      ...usage,
      model_scoped: [
        { display_name: "Fable", utilization: 100, resets_at: "2026-11-28T08:00:00Z" },
        { display_name: "", utilization: 40, resets_at: null },
        { display_name: "Haiku", utilization: null, resets_at: null },
      ],
    });
    expect(reading.windows.map((w) => [w.label, w.model])).toEqual([
      ["Session de 5 h", undefined],
      ["Semaine, tous modèles", undefined],
      ["Semaine, Opus", "Opus"],
      ["Semaine, Fable", "Fable"],
    ]);
    expect(reading.windows.at(-1)).toMatchObject({
      short: "semaine Fable",
      usedPercent: 100,
      resetsAt: Date.parse("2026-11-28T08:00:00Z"),
    });
  });

  // What Claude Code 0.3.330 answers, checked against the real binary.
  const subscriber = {
    subscriptionType: "Claude Max",
    tokenSource: "claude.ai",
    apiProvider: "firstParty",
  };
  const answer = { subscription_type: "max", rate_limits_available: true, rate_limits: usage };

  it("asks Claude Code itself, and names the plan", async () => {
    let asked = 0;
    const reading = await readClaudeQuota(async () => {
      asked++;
      return { account: subscriber, usage: answer };
    });
    expect(asked).toBe(1);
    expect(reading).toMatchObject({ state: "ok", plan: "Abonnement Max" });
    expect(reading.windows).toHaveLength(3);
  });

  it("tells signed out, API key, cloud provider and a sign-in without limits apart", () => {
    const unavailable = {
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    };
    expect(
      claudeReading({ subscriptionType: "Claude API", apiProvider: "firstParty" }, unavailable),
    ).toMatchObject({
      state: "unreadable",
      note: expect.stringMatching(/pas connecté.*login/),
    });
    expect(
      claudeReading({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, unavailable),
    ).toMatchObject({ state: "none", note: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    expect(claudeReading({ apiProvider: "bedrock" }, unavailable)).toMatchObject({
      state: "none",
      note: expect.stringMatching(/Amazon Bedrock/),
    });
    expect(claudeReading({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }, unavailable)).toMatchObject({
      state: "unreadable",
      note: expect.stringMatching(/ne donne pas les limites/),
    });
  });

  it("keeps a subscription whose figures failed this time transient, with a backoff", async () => {
    const failedThisTime = claudeReading(subscriber, {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: null,
    });
    expect(failedThisTime).toMatchObject({ state: "unreadable", transient: true });
    expect(failedThisTime.retryAfterMs).toBeGreaterThan(0);
    const limited = await readClaudeQuota(async () => {
      throw new Error("API Error: 429 rate_limit_error");
    });
    expect(limited).toMatchObject({ transient: true, retryAfterMs: expect.any(Number) });
    expect(
      claudeReading(subscriber, {
        rate_limits_available: true,
        rate_limits: {
          ...usage,
          model_scoped: [{ display_name: "opus", utilization: 99, resets_at: null }],
        },
      }).windows.filter((w) => w.model?.toLowerCase() === "opus"),
    ).toHaveLength(1);
  });

  it("starts no Claude Code when stopped while the SDK loads", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeClaude(controller.signal)).rejects.toThrow(/annulée/);
  });

  it("marks a slow or failing Claude Code transient, and stops it", async () => {
    let stopped = false;
    const slow = await readClaudeQuota(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            stopped = true;
            reject(new Error("aborted"));
          });
        }),
      undefined,
      50,
    );
    expect(slow).toMatchObject({
      state: "unreadable",
      transient: true,
      note: expect.stringMatching(/à temps/),
    });
    expect(stopped).toBe(true);

    const failing = await readClaudeQuota(async () => {
      throw new Error("Unsupported control request\nstack");
    });
    expect(failing).toMatchObject({
      state: "unreadable",
      transient: true,
      note: "Claude Code n'a pas donné ses limites : Unsupported control request",
    });
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
  // Like the real app-server: account/read is refused without params.
  if (m.method === "account/read" && m.params === undefined) {
    process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32600, message: "Invalid request: missing field \`params\`" } }) + "\\n");
    return;
  }
  // Like the real app-server: notifications and its own requests arrive between answers.
  process.stdout.write(JSON.stringify({ method: "configWarning", params: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ id: 1, method: "item/tool/requestUserInput", params: {} }) + "\\n");
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

  it("says Codex is not signed in when it refuses the limits for that reason", async () => {
    // What the real app-server answers with no sign-in (checked against codex-cli 0.171.0).
    const script = path.join(tmp(), "codex-signed-out.mjs");
    writeFileSync(
      script,
      `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const answer = m.method === "initialize" ? { id: m.id, result: {} }
    : m.method === "account/read" ? { id: m.id, result: { account: null, requiresOpenaiAuth: true } }
    : { id: m.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } };
  process.stdout.write(JSON.stringify(answer) + "\\n");
});`,
    );
    const reading = await readCodexQuota({ command: process.execPath, args: [script] });
    expect(reading).toMatchObject({
      state: "unreadable",
      note: expect.stringMatching(/codex login/),
    });
    expect(reading.transient).toBeUndefined();
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

describe("Antigravity's quotas", () => {
  // What agy 1.5.15 really answered on a Google AI Ultra account (2026-11-24).
  const summary = {
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          description:
            "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Orchestrator (Neon), Gemini 3.8 Flash",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              remainingFraction: 0.95480776,
              resetTime: "2026-11-30T20:03:15Z",
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              remainingFraction: 0.860996,
              resetTime: "2026-11-24T01:03:15Z",
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1 },
            { bucketId: "3p-5h", window: "5h", remainingFraction: 1 },
          ],
        },
      ],
    },
  };
  const status = {
    userStatus: {
      planStatus: { planInfo: { planName: "Pro" } },
      userTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
    },
  };

  /** A stand-in for Antigravity's local server, which wants `token` back when it has one. */
  const fakeServer = async (token: string, answer: unknown = summary) => {
    const asked: string[] = [];
    const server: Server = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      if (req.headers["x-codeium-csrf-token"] !== token) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: "unauthenticated", message: "missing CSRF token" }));
        return;
      }
      res.end(JSON.stringify(req.url?.endsWith("/GetUserStatus") ? status : answer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { port, asked, close: () => new Promise((resolve) => server.close(resolve)) };
  };
  const hubDir = (home: string) => {
    const dir = path.join(home, ".gemini", "antigravity", "daemon");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const logDir = (home: string) => {
    const dir = path.join(home, ".gemini", "antigravity-cli", "log");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const logLines = (https: number, http: number) =>
    `I1124 server.go:1] Language server listening on random port at ${https} for HTTPS (gRPC)\n` +
    `I1124 server.go:2] Language server listening on random port at ${http} for HTTP\n`;

  it("reads each group's 5-hour and weekly windows from the share left", () => {
    const reading = parseAntigravityQuota(summary, status);
    expect(reading.state).toBe("ok");
    expect(reading.plan).toBe("Google AI Ultra");
    expect(reading.windows).toEqual([
      {
        label: "Session de 5 h, Gemini",
        short: "5 h Gemini",
        model: "Gemini",
        models: ["Gemini 4 Neon", "Gemini 4 Carbon", "Orchestrator (Neon)", "Gemini 3.8 Flash"],
        usedPercent: 13.9,
        resetsAt: Date.parse("2026-11-24T01:03:15Z"),
      },
      {
        label: "Semaine, Gemini",
        short: "semaine Gemini",
        model: "Gemini",
        models: ["Gemini 4 Neon", "Gemini 4 Carbon", "Orchestrator (Neon)", "Gemini 3.8 Flash"],
        usedPercent: 4.5,
        resetsAt: Date.parse("2026-11-30T20:03:15Z"),
      },
      {
        label: "Session de 5 h, Claude et GPT",
        short: "5 h Claude et GPT",
        model: "Claude et GPT",
        models: ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"],
        usedPercent: 0,
      },
      {
        label: "Semaine, Claude et GPT",
        short: "semaine Claude et GPT",
        model: "Claude et GPT",
        models: ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"],
        usedPercent: 0,
      },
    ]);
  });

  it("says so when no figure comes back, and never invents one", () => {
    expect(parseAntigravityQuota({ response: { groups: [] } }).state).toBe("unreadable");
    expect(parseAntigravityQuota(undefined).state).toBe("unreadable");
    const odd = parseAntigravityQuota({
      groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h" }, null, "x"] }],
    });
    expect(odd.state).toBe("unreadable");
    // Without the plan's answer the figures still count.
    expect(parseAntigravityQuota(summary).plan).toBeUndefined();
    expect(parseAntigravityQuota(summary).state).toBe("ok");
  });

  it("finds the plain-HTTP port in agy's log", () => {
    expect(agyLogPort(logLines(51000, 51001))).toBe(51001);
    expect(agyLogPort("nothing here")).toBeUndefined();
    expect(agyLogPort("listening on random port at 51000 for HTTPS (gRPC)")).toBeUndefined();
  });

  it("asks the desktop app's running server with its token, skipping dead ones", async () => {
    const home = tmp();
    const server = await fakeServer("secret-token");
    try {
      const dir = hubDir(home);
      // Left behind by a server that stopped: its process is gone.
      writeFileSync(
        path.join(dir, "hub_1.json"),
        JSON.stringify({ pid: 2 ** 30, httpPort: 1, csrfToken: "old" }),
      );
      writeFileSync(path.join(dir, "hub_2.json"), "{ not json");
      writeFileSync(
        path.join(dir, `hub_${server.port}.json`),
        JSON.stringify({ pid: process.pid, httpPort: server.port, csrfToken: "secret-token" }),
      );
      expect(await agyHubServers(home)).toEqual([{ port: server.port, csrf: "secret-token" }]);
      const reading = await readAntigravityQuota({ home, agy: null });
      expect(reading.state).toBe("ok");
      expect(reading.plan).toBe("Google AI Ultra");
      expect(reading.windows).toHaveLength(4);
      expect(server.asked).toEqual([
        "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        "/exa.language_server_pb.LanguageServerService/GetUserStatus",
      ]);
    } finally {
      await server.close();
    }
  });

  it("asks a running agy's own server, found through its log", async () => {
    const home = tmp();
    const server = await fakeServer("");
    try {
      const dir = logDir(home);
      writeFileSync(path.join(dir, `acp-server-2026-11-24-${2 ** 30}.log`), logLines(1, 2));
      writeFileSync(
        path.join(dir, `acp-server-2026-11-24-${process.pid}.log`),
        logLines(server.port + 1, server.port),
      );
      expect(await agyCliServers(home)).toEqual([{ port: server.port, csrf: "" }]);
      expect((await readAntigravityQuota({ home, agy: null })).state).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("starts agy when nothing runs, asks, and stops it", async () => {
    const home = tmp();
    const dir = logDir(home);
    const pidFile = path.join(home, "agy.pid");
    const script = path.join(home, "fake-agy.mjs");
    writeFileSync(
      script,
      `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
if (process.argv[2] !== "acp") process.exit(2);
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url.endsWith("/GetUserStatus") ? {} : ${JSON.stringify(summary)}));
});
process.stdin.once("data", () => {
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    writeFileSync(
      path.join(${JSON.stringify(dir)}, "acp-server-2026-11-24-" + process.pid + ".log"),
      "Language server listening on random port at " + port + " for HTTP\\n",
    );
  });
});
`,
    );
    const reading = await readAntigravityQuota({
      home,
      agy: { command: process.execPath, args: [script] },
    });
    expect(reading.state).toBe("ok");
    expect(reading.windows.map((w) => w.short)).toContain("semaine Gemini");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Stopped once asked: nothing of agy lives on.
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  it("says why when agy is missing, refuses or never opens its server", async () => {
    const home = tmp();
    const missing = await readAntigravityQuota({ home, agy: null });
    expect(missing).toMatchObject({ state: "unreadable" });
    expect(missing.note).toContain("agy introuvable");
    expect(missing.transient).toBeFalsy();

    const silent = path.join(home, "silent.mjs");
    writeFileSync(silent, "setTimeout(() => {}, 60_000);");
    const late = await readAntigravityQuota({
      home,
      agy: { command: process.execPath, args: [silent] },
      startTimeoutMs: 400,
    });
    expect(late).toMatchObject({ state: "unreadable", transient: true });
    expect(late.note).toContain("à temps");

    const crashing = path.join(home, "crash.mjs");
    writeFileSync(crashing, `console.error("fatal boom"); process.exit(1);`);
    const crashed = await readAntigravityQuota({
      home,
      agy: { command: process.execPath, args: [crashing] },
    });
    expect(crashed.note).toContain("fatal boom");

    // A server that wants a token we do not have: told as not signed in, not as figures.
    const server = await fakeServer("wanted");
    try {
      writeFileSync(
        path.join(logDir(home), `acp-server-x-${process.pid}.log`),
        logLines(1, server.port),
      );
      const refused = await readAntigravityQuota({ home, agy: null });
      expect(refused.state).toBe("unreadable");
      expect(refused.note).toContain("missing CSRF token");
    } finally {
      await server.close();
    }
  });

  it("stops when the read is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const reading = await readAntigravityQuota({ home: tmp(), agy: null }, controller.signal);
    expect(reading).toMatchObject({ state: "unreadable", transient: true });
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

describe("toTime", () => {
  it("takes seconds, milliseconds and ISO dates", () => {
    expect(toTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toTime(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toTime("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(toTime(null)).toBeUndefined();
  });
});
