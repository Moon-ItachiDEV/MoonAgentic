// What the diagnostic report and the day's log keep of a secret (audit of 2026-11-25, N9): the
// report is readable by every paired device and made to be shared, the logs are kept 14 days.
// The forms are those tools and agents print as they fail.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsMonitor } from "../src/diagnostics.ts";
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
    "Authorization: Basic",
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
