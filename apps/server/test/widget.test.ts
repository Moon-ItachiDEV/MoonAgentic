// The iPhone widgets' reading: what it says of quotas, threads and Hermes, what it never
// says (a locked project), and who may ask.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  AgentInfo,
  AgentQuota,
  HermesStatus,
  PendingRequest,
  Project,
  Schedule,
  Thread,
} from "@moonagentic/protocol";
import { DEFAULT_HERMES_ALLOW, DEFAULT_HERMES_NOTIFY } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Devices } from "../src/devices.ts";
import { createHttpServer } from "../src/http.ts";
import type { Hub } from "../src/hub.ts";
import {
  RECENT_MS,
  ThreadClock,
  WIDGET_PATH,
  type WidgetData,
  type WidgetInput,
  widgetData,
} from "../src/widget.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const agent = (id: string, name: string): AgentInfo =>
  ({ id, name, short: name.slice(0, 2), available: true }) as AgentInfo;
const project = (id: string, name: string) => ({ id, name, path: `/p/${id}` }) as Project;
const thread = (id: string, patch: Partial<Thread> = {}): Thread =>
  ({
    id,
    projectId: "p1",
    title: `Fil ${id}`,
    agentId: "claude",
    status: "idle",
    permissionMode: "supervised",
    ...patch,
  }) as Thread;
const hermes = (patch: Partial<HermesStatus> = {}): HermesStatus => ({
  connected: true,
  allow: DEFAULT_HERMES_ALLOW,
  notify: DEFAULT_HERMES_NOTIFY,
  webhook: false,
  config: "",
  log: [],
  ...patch,
});
const input = (patch: Partial<WidgetInput> = {}): WidgetInput => ({
  now: NOW,
  agents: [agent("claude", "Claude Code"), agent("hermes", "Hermes")],
  quotas: [],
  projects: [project("p1", "MoonAgentic"), project("p2", "Secret")],
  threads: [],
  requests: [],
  questions: [],
  schedules: [],
  hermes: hermes(),
  clock: new ThreadClock(() => NOW),
  locked: () => false,
  modelName: () => undefined,
  ...patch,
});

describe("widgetData: quotas", () => {
  const quota: AgentQuota = {
    agentId: "claude",
    state: "ok",
    extras: [],
    windows: [
      {
        label: "Semaine, tous modèles",
        short: "semaine",
        usedPercent: 31.4,
        resetsAt: NOW + 80 * HOUR,
      },
      { label: "Session de 5 h", short: "5 h", usedPercent: 86, resetsAt: NOW + 2 * HOUR },
    ],
  };

  it("puts the session first, then the week, and points at the fullest", () => {
    const [claude] = widgetData(input({ quotas: [quota] })).quotas;
    expect(claude).toEqual({
      id: "claude",
      name: "Claude Code",
      tight: 0,
      windows: [
        { label: "Session de 5 h", short: "5 h", used: 86, resetsAt: NOW + 2 * HOUR },
        { label: "Semaine, tous modèles", short: "semaine", used: 31, resetsAt: NOW + 80 * HOUR },
      ],
    });
  });

  it("counts a window as empty once its announced reset has passed", () => {
    const stale: AgentQuota = {
      ...quota,
      windows: [{ label: "Session de 5 h", short: "5 h", usedPercent: 100, resetsAt: NOW - 1 }],
    };
    expect(widgetData(input({ quotas: [stale] })).quotas[0]!.windows).toEqual([
      { label: "Session de 5 h", short: "5 h", used: 0 },
    ]);
  });

  it("leaves out an agent whose figures cannot be read, or that has none", () => {
    const quotas: AgentQuota[] = [
      { agentId: "cursor", state: "unreadable", windows: [], extras: [] },
      { agentId: "hermes", state: "none", windows: [], extras: [] },
      { agentId: "claude", state: "loading", windows: [], extras: [] },
    ];
    expect(widgetData(input({ quotas })).quotas).toEqual([]);
  });
});

describe("widgetData: threads", () => {
  it("lists those that wait before those at work, with since when", () => {
    const clock = new ThreadClock(() => NOW - 12 * 60_000);
    const t1 = thread("t1");
    const t2 = thread("t2", { agentId: "hermes" });
    clock.know([t1, t2]);
    clock.threadChanged({ ...t1, status: "running" });
    const requests = [
      { threadId: "t2", itemId: "i", title: "git push", options: [], at: NOW - 4 * 60_000 },
    ];
    const data = widgetData(
      input({
        clock,
        requests: requests as PendingRequest[],
        threads: [
          { ...t1, status: "running", model: "opus" },
          { ...t2, status: "waiting" },
          thread("t3"),
        ],
        modelName: (_a, model) => (model === "opus" ? "Opus 5.5" : undefined),
      }),
    );
    expect(data.waiting).toBe(1);
    expect(data.running).toBe(1);
    expect(data.threads).toEqual([
      {
        title: "Fil t2",
        project: "MoonAgentic",
        by: "Hermes",
        state: "waiting",
        since: NOW - 4 * 60_000,
      },
      {
        title: "Fil t1",
        project: "MoonAgentic",
        by: "Opus 5.5",
        state: "running",
        since: NOW - 12 * 60_000,
      },
    ]);
  });

  it("says nothing of a locked project, an archived thread or one held in line", () => {
    const data = widgetData(
      input({
        locked: (id) => id === "p2",
        threads: [
          thread("a", { projectId: "p2", status: "waiting", title: "Secret" }),
          thread("b", { status: "running", archived: true }),
          thread("c", { status: "running", held: "plus tard" }),
        ],
        schedules: [
          { projectId: "p2", title: "Tâche secrète", by: "hermes", enabled: true, nextAt: NOW + 1 },
        ] as Schedule[],
      }),
    );
    expect(data.waiting).toBe(0);
    expect(data.running).toBe(0);
    expect(JSON.stringify(data)).not.toContain("ecr");
  });
});

describe("widgetData: Hermes", () => {
  it("is absent when Hermes is neither installed nor connected", () => {
    const data = widgetData(
      input({ agents: [agent("claude", "Claude Code")], hermes: hermes({ connected: false }) }),
    );
    expect(data.hermes).toBeUndefined();
  });

  it("is off without an access, at rest with one", () => {
    expect(widgetData(input({ hermes: hermes({ connected: false, lastSeen: 5 }) })).hermes).toEqual(
      {
        state: "off",
        at: 5,
        log: [],
        next: [],
      },
    );
    expect(widgetData(input({ hermes: hermes({ lastSeen: 7 }) })).hermes).toMatchObject({
      state: "rest",
      at: 7,
    });
  });

  it("asks when one of its own threads waits, naming the request", () => {
    const requests = [
      { threadId: "h", itemId: "i", title: "Autoriser git push", options: [], at: NOW - 60_000 },
    ];
    const data = widgetData(
      input({
        requests: requests as PendingRequest[],
        threads: [thread("h", { agentId: "hermes", status: "waiting" })],
      }),
    );
    expect(data.hermes).toMatchObject({
      state: "asks",
      title: "Autoriser git push",
      project: "MoonAgentic",
      at: NOW - 60_000,
    });
  });

  it("waits for the user only when Discord was told of the thread that waits", () => {
    const threads = [thread("w", { status: "waiting" })];
    expect(widgetData(input({ threads })).hermes!.state).toBe("rest");
    expect(widgetData(input({ threads, hermes: hermes({ webhook: true }) })).hermes).toMatchObject({
      state: "waiting",
      title: "Fil w",
    });
    const quiet = hermes({ webhook: true, notify: { ...DEFAULT_HERMES_NOTIFY, waiting: false } });
    expect(widgetData(input({ threads, hermes: quiet })).hermes!.state).toBe("rest");
  });

  it("works, then is done for a while, then rests", () => {
    let now = NOW - 20 * 60_000;
    const clock = new ThreadClock(() => now);
    const h = thread("h", { agentId: "hermes" });
    clock.know([h]);
    clock.threadChanged({ ...h, status: "running" });
    const working = widgetData(input({ clock, threads: [{ ...h, status: "running" }] }));
    expect(working.hermes).toMatchObject({ state: "working", title: "Fil h", at: now });
    now = NOW - 60_000;
    clock.threadChanged(h);
    expect(widgetData(input({ clock, threads: [h] })).hermes).toMatchObject({
      state: "done",
      title: "Fil h",
      at: now,
    });
    const later = widgetData(input({ clock, threads: [h], now: now + RECENT_MS }));
    expect(later.hermes).toMatchObject({ state: "rest", at: now });
  });

  it("says its last turn failed for as long as the thread stays in error", () => {
    const clock = new ThreadClock(() => NOW - HOUR);
    const h = thread("h", { agentId: "hermes", status: "running" });
    clock.know([h]);
    clock.threadChanged({ ...h, status: "error" });
    const data = widgetData(input({ clock, threads: [{ ...h, status: "error" }] }));
    expect(data.hermes).toMatchObject({ state: "error", title: "Fil h", at: NOW - HOUR });
  });

  it("says what it just did from Discord, and lists its actions and next tasks", () => {
    const log = [
      { what: "Message au coordinateur", project: "MoonAgentic", at: NOW - 2 * 60_000 },
      { what: "a", at: 4 },
      { what: "b", at: 3 },
      { what: "c", at: 2 },
      { what: "d", at: 1 },
    ];
    const schedules = [
      { projectId: "p1", title: "Plus tard", by: "hermes", enabled: true, nextAt: NOW + 2 * HOUR },
      { projectId: "p1", title: "Bientôt", by: "hermes", enabled: true, nextAt: NOW + HOUR },
      { projectId: "p1", title: "En pause", by: "hermes", enabled: false, nextAt: NOW + 1 },
      { projectId: "p1", title: "Pas de lui", enabled: true, nextAt: NOW + 1 },
    ] as Schedule[];
    const data = widgetData(input({ hermes: hermes({ log }), schedules }));
    expect(data.hermes).toMatchObject({
      state: "acted",
      title: "Message au coordinateur",
      project: "MoonAgentic",
    });
    expect(data.hermes!.log).toHaveLength(4);
    expect(data.hermes!.next).toEqual([
      { title: "Bientôt", at: NOW + HOUR },
      { title: "Plus tard", at: NOW + 2 * HOUR },
    ]);
  });
});

// Neon's review of PR 177.
describe("widgetData: review of PR 177", () => {
  it("says nothing of a project locked after Hermes acted on it or ended a turn in it", () => {
    const clock = new ThreadClock(() => NOW - 3 * 60_000);
    const secret = thread("s", { projectId: "p2", agentId: "hermes", status: "running" });
    clock.know([secret]);
    clock.threadChanged({ ...secret, status: "idle" });
    const log = [
      { what: "Message au fil · Fil caché", project: "Secret", at: NOW - 60_000 },
      { what: "Message au coordinateur", project: "MoonAgentic", at: NOW - HOUR },
    ];
    const data = widgetData(
      input({
        clock,
        locked: (id) => id === "p2",
        threads: [{ ...secret, status: "idle" }],
        hermes: hermes({ log, lastSeen: NOW - 2 * HOUR }),
      }),
    );
    expect(JSON.stringify(data)).not.toMatch(/Secret|caché/);
    expect(data.hermes!.log).toEqual([log[1]]);
    // Neither what it did there, nor when its turn there ended.
    expect(data.hermes).toMatchObject({ state: "rest", at: NOW - 2 * HOUR });
  });

  it("does not count as at work a thread whose turn waits for a place", () => {
    const data = widgetData(
      input({
        threads: [
          thread("q", { status: "running", inLine: true }),
          thread("r", { status: "running" }),
        ],
      }),
    );
    expect(data.running).toBe(1);
    expect(data.threads.map((t) => t.title)).toEqual(["Fil r"]);
  });

  it("sees a turn end on an error while it waited for an answer", () => {
    const clock = new ThreadClock(() => NOW - 60_000);
    const h = thread("h", { agentId: "hermes", status: "waiting" });
    clock.know([h]);
    clock.threadChanged({ ...h, status: "error" });
    expect(clock.lastEnded("hermes")).toMatchObject({ threadId: "h", error: true });
    const data = widgetData(input({ clock, threads: [{ ...h, status: "error" }] }));
    expect(data.hermes).toMatchObject({ state: "error", title: "Fil h" });
  });
});

describe("GET /api/widget", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function serve() {
    const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-widget-"));
    const webDir = path.join(root, "web");
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, "index.html"), "<title>MoonAgentic</title>");
    const data: WidgetData = { at: NOW, quotas: [], waiting: 2, running: 1, threads: [] };
    const devices = new Devices();
    const hub = { widget: async () => data } as unknown as Hub;
    const server = createHttpServer({ hub, token: "jeton-du-proprietaire", webDir, devices });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${WIDGET_PATH}`;
    return { url, devices, data, webDir };
  }

  it("answers a paired device, and no one without a token", async () => {
    const { url, devices, data } = await serve();
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer faux" } })).status).toBe(401);
    const paired = devices.pair(devices.startPairing().code, "Widget iPhone");
    const res = await fetch(url, { headers: { authorization: `Bearer ${paired!.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(data);
  });

  it("serves Hermes's portrait as the image it is", async () => {
    const { url, webDir } = await serve();
    writeFileSync(path.join(webDir, "hermes-avatar.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const res = await fetch(url.replace(WIDGET_PATH, "/hermes-avatar.jpg"));
    await res.body?.cancel();
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("serves the script as UTF-8, so that Safari shows its accents", async () => {
    const { url, webDir } = await serve();
    writeFileSync(path.join(webDir, "widget-iphone.js"), 'const mot = "Relié";\n');
    const res = await fetch(url.replace(WIDGET_PATH, "/widget-iphone.js"));
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toContain("Relié");
  });

  it("only reads, and never for a page of another site", async () => {
    const { url } = await serve();
    const headers = { authorization: "Bearer jeton-du-proprietaire" };
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
    const elsewhere = await fetch(url, {
      headers: { ...headers, origin: "https://ailleurs.example" },
    });
    expect(elsewhere.status).toBe(403);
  });
});
