// What the diagnostic report and the day's log keep of a secret (audit of 2026-11-25, N9): the
// report is readable by every paired device and made to be shared, the logs are kept 14 days.
// The forms are those tools and agents print as they fail.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsMonitor } from "../src/diagnostics.ts";
import { AgentSession } from "../src/session.ts";
import { DailyLog, redact } from "../src/supervisor.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Secrets as tools and agents print them when they fail, none of them invented by the test. */
const FORMS: [string, string, string][] = [
  ["mot de passe en paramètre", "connexion refusée password=Hunter2Secret01", "Hunter2Secret01"],
  ["clé d'API en JSON", '{"api_key": "ak_live_Secret02xyz"}', "ak_live_Secret02xyz"],
  ["en-tête Basic", "Authorization: Basic dXNlcjpTZWNyZXQwMw==", "dXNlcjpTZWNyZXQwMw=="],
  [
    "URL avec identifiants",
    "fatal: https://moi:Secret04Pass@git.example.com/x.git",
    "Secret04Pass",
  ],
  ["clé AWS", "InvalidClientTokenId AKIAIOSFODNN7SECRET5", "AKIAIOSFODNN7SECRET5"],
  ["jeton Slack", "invalid_auth xoxb-123456789012-Secret06abcdef", "Secret06abcdef"],
  ["clé Google", "API key not valid AIzaSyD-Secret07abcdefghijklmnopqrstuv", "Secret07abcdefghij"],
  ["jeton GitLab", "401 glpat-Secret08abcdefghij", "Secret08abcdefghij"],
  [
    "JWT",
    "jwt expired eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTZWNyZXQwOSJ9.c2lnbmF0dXJl",
    "eyJzdWIiOiJTZWNyZXQwOSJ9",
  ],
  ["en-tête x-api-key", "x-api-key: Secret10ApiKeyValue", "Secret10ApiKeyValue"],
  ["paramètre key=", "GET https://api.example.com/v1?key=Secret11Value&a=1", "Secret11Value"],
  ["jeton npm", "npm ERR! npm_Secret12abcdefghijklmnopqrstuvwxyz12", "Secret12abcdefghij"],
];

describe("secrets in the diagnostic report and the logs", () => {
  it.each(FORMS)("%s", (_label, line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  it("still masks what it masked before", () => {
    const line =
      "http://h:1/#token=AbC-123_x ticket=xyz Bearer abcdefghijklmnop12 ghp_abcdef123456 sk-ant-abcdefghijkl123";
    expect(redact(line)).toBe("http://h:1/#token=… ticket=… Bearer … ghp_… sk-ant-…");
  });

  it("keeps out of the day's log and the report what a failing agent wrote", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-diag-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const log = new DailyLog(path.join(dir, "logs"));
    const line = `[agent-exit] claude arrêté : ${FORMS.map((f) => f[1]).join(" ")}`;
    const monitor = new DiagnosticsMonitor({
      dataDir: dir,
      logDir: path.join(dir, "logs"),
      worktreesDir: path.join(dir, "worktrees"),
      getAgents: () => [],
      getRunningTurns: () => 0,
      getStartingAgents: () => 0,
      hasLockedProjects: () => false,
      sampleProcesses: async () => [],
      sampleIntervalMs: 0,
      lagCheckMs: 0,
      log: (l) => log.write(l),
      error: (l) => log.write(l),
    });
    cleanups.push(() => monitor.stop());
    monitor.recordSlow("agent-exit", line.replace("[agent-exit] ", ""));
    const { text } = await monitor.buildReport();
    const file = readFileSync(log.file(), "utf8");
    const inReport = FORMS.filter(([, , s]) => text.includes(s)).map(([l]) => l);
    const inLog = FORMS.filter(([, , s]) => file.includes(s)).map(([l]) => l);
    expect(inReport).toEqual([]);
    expect(inLog).toEqual([]);
  });

  it("shows no interface error while a project is locked: one may name its thread", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-diag-lock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    let locked = false;
    const monitor = new DiagnosticsMonitor({
      dataDir: dir,
      logDir: path.join(dir, "logs"),
      worktreesDir: path.join(dir, "worktrees"),
      getAgents: () => [],
      getRunningTurns: () => 0,
      getStartingAgents: () => 0,
      hasLockedProjects: () => locked,
      sampleProcesses: async () => [],
      sampleIntervalMs: 0,
      lagCheckMs: 0,
      log: () => undefined,
      error: () => undefined,
    });
    cleanups.push(() => monitor.stop());
    monitor.recordClientError(
      { source: "ui", message: "Impossible d'afficher le fil « Rachat de la société X »" },
      "ordinateur",
    );
    locked = true;
    const { text } = await monitor.buildReport();
    expect(text).toContain("Journaux bruts masqués");
    expect(text).not.toContain("Rachat de la société X");
  });
});

describe("what is not a secret", () => {
  it.each([
    "Basic authentication refused",
    "ws://127.0.0.1:4747/ws ouvert",
    "git@github.com:moi/projet.git",
    "monkey=banane",
    // An address whose query holds an `@` has no password in it.
    "http://localhost:4747?email=alice@example.com",
    "status: 200 en 12 ms",
  ])("stays as it is: %s", (line) => {
    expect(redact(line)).toBe(line);
  });

  it("keeps where a failing address pointed, without its password", () => {
    expect(redact("fatal: https://moi:Secret04Pass@git.example.com/x.git")).toBe(
      "fatal: https://moi:…@git.example.com/x.git",
    );
    expect(redact('{"api_key": "ak_live_1", "model": "m1"}')).toBe(
      '{"api_key": "…", "model": "m1"}',
    );
  });
});

/** More forms, found by the review of this PR: none of them real. */
const MORE: [string, string, string][] = [
  [
    "un JWT après token=",
    "GET /cb?token=eyJhbGciOiJIUzI1NiJ9.eyJwYXlsb2FkIjoxfQ.c2ln",
    "eyJwYXlsb2Fk",
  ],
  ["du base64 après token=", "token=abc/Base64+End=", "Base64+End"],
  ["une variable AWS", "AWS_SECRET_ACCESS_KEY=fauxSecret13", "fauxSecret13"],
  ["une variable de base", "DATABASE_PASSWORD=fauxSecret14", "fauxSecret14"],
  ["une variable OpenAI", "OPENAI_API_KEY=fauxSecret15", "fauxSecret15"],
  ["une variable JWT", "JWT_SECRET=fauxSecret16", "fauxSecret16"],
  ["une variable OAuth", "OAUTH_CLIENT_SECRET=fauxSecret17", "fauxSecret17"],
  ["basic en minuscules", "authorization: basic dXNlcjpTZWNyZXQxOA==", "dXNlcjpTZWNyZXQxOA"],
  ["Authorization: Token", "Authorization: Token fauxSecret19", "fauxSecret19"],
  ["un cookie", "Cookie: sid=fauxSecret20; theme=sombre", "fauxSecret20"],
  ["Set-Cookie", "Set-Cookie: sid=fauxSecret21; Path=/", "fauxSecret21"],
  ["entre guillemets", 'password="fauxSecret22"', "fauxSecret22"],
  ["entre apostrophes", "api_key='fauxSecret23'", "fauxSecret23"],
  ["en JSON échappé", '{\\"api_key\\":\\"fauxSecret24\\"}', "fauxSecret24"],
  ["un objet affiché", "{ api_key: 'fauxSecret25' }", "fauxSecret25"],
  ["un en-tête en JSON", '{"x-api-key": "fauxSecret26"}', "fauxSecret26"],
  ["une adresse sans utilisateur", "redis://:fauxSecret27@cache:6379", "fauxSecret27"],
  ["un @ dans le mot de passe", "https://moi:faux@Secret28@hote/x", "Secret28"],
  ["une clé Stripe", "sk_live_fauxSecret29", "fauxSecret29"],
  ["une clé Stripe de test", "sk_test_fauxSecret30", "fauxSecret30"],
];

describe("secrets the review of this PR found", () => {
  it.each(MORE)("%s", (_label, line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  it("keeps the quotes and the name, so the line still reads", () => {
    expect(redact('{\\"api_key\\":\\"fauxSecret24\\"}')).toBe('{\\"api_key\\":\\"…\\"}');
    expect(redact("Cookie: sid=fauxSecret20; theme=sombre")).toBe("Cookie: …");
    expect(redact("https://moi:faux@Secret28@hote/x")).toBe("https://moi:…@hote/x");
  });
});

describe("a line made to be slow to mask", () => {
  // What a log tail reads at most, and what the line buffer holds.
  const LONG = 256 * 1024;
  it.each([
    ["les points d'un nom de domaine", "a."],
    ["le début d'un JWT", "eyJ-"],
    ["le début d'une adresse", "a://"],
    ["un nom de secret sans valeur", "key="],
    ["des guillemets jamais fermés", 'password="'],
    ["des en-têtes vides", "Authorization: "],
    ["un Bearer sans jeton", "Bearer "],
  ])("is masked at once: %s", (_label, piece) => {
    const line = piece.repeat(Math.ceil(LONG / piece.length));
    const started = performance.now();
    redact(line);
    // A few milliseconds here; the expressions of the first version took seconds.
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("reads nothing of an interface error past the rate allowed", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-diag-rate-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const monitor = new DiagnosticsMonitor({
      dataDir: dir,
      logDir: path.join(dir, "logs"),
      worktreesDir: path.join(dir, "worktrees"),
      getAgents: () => [],
      getRunningTurns: () => 0,
      getStartingAgents: () => 0,
      hasLockedProjects: () => false,
      sampleProcesses: async () => [],
      sampleIntervalMs: 0,
      lagCheckMs: 0,
      log: () => undefined,
      error: () => undefined,
    });
    cleanups.push(() => monitor.stop());
    for (let n = 0; n < 30; n++) monitor.recordClientError({ message: `erreur ${n}` }, "ordi");
    let read = 0;
    const late = {
      get message() {
        read++;
        return "x".repeat(1_000_000);
      },
    };
    expect(monitor.recordClientError(late, "ordi")).toBe(false);
    expect(read).toBe(0);
  });
});

describe("a secret at the place a text is cut", () => {
  it("is masked before the cut, in the report", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-diag-cut-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const monitor = new DiagnosticsMonitor({
      dataDir: dir,
      logDir: path.join(dir, "logs"),
      worktreesDir: path.join(dir, "worktrees"),
      getAgents: () => [],
      getRunningTurns: () => 0,
      getStartingAgents: () => 0,
      hasLockedProjects: () => false,
      sampleProcesses: async () => [],
      sampleIntervalMs: 0,
      lagCheckMs: 0,
      log: () => undefined,
      error: () => undefined,
    });
    cleanups.push(() => monitor.stop());
    // The JWT straddles the 300 characters an event keeps: cut first, its payload was kept.
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJmYXV4U2VjcmV0MzEiOjF9.c2lnbmF0dXJl";
    monitor.recordSlow("agent-exit", `${"x".repeat(270)} ${jwt}`);
    monitor.recordClientError({ message: "erreur", route: `/t/${"y".repeat(60)}/${jwt}` }, "ordi");
    const { text } = await monitor.buildReport();
    expect(text).not.toContain("eyJmYXV4U2VjcmV0MzEi");
  });

  it("is masked in what an agent wrote on stderr before it stopped", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-stderr-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const agent = path.join(dir, "agent.mjs");
    // More than the 4000 characters kept, then the secret at the start of a line.
    writeFileSync(
      agent,
      `for (let n = 0; n < 60; n++) console.error("ligne " + n + " " + "z".repeat(80));
       console.error("OPENAI_API_KEY=fauxSecret32 refusée");
       process.exit(3);`,
    );
    let reason: string | undefined;
    const started = AgentSession.start({
      launch: { command: process.execPath, args: [agent] },
      cwd: dir,
      previousSessionId: null,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: (why) => {
          reason = why;
        },
      },
    });
    const failure = await started.then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).not.toContain("fauxSecret32");
    expect(reason ?? "").not.toContain("fauxSecret32");
    expect(`${failure}${reason ?? ""}`).toContain("OPENAI_API_KEY=…");
  });
});
