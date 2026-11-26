import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { discordNotices, discordWebhook } from "../src/hermes.ts";
import { HERMES_PATH, HERMES_TOOLS } from "../src/hermes-tools.ts";
import { createHttpServer } from "../src/http.ts";
import { type Client, Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const APP_TOKEN = "jeton-de-l-app";
const WEBHOOK = "https://discord.com/api/webhooks/123456/abc-DEF_9";
const BRIDGE = fileURLToPath(new URL("../src/hermes-bridge.ts", import.meta.url));
const soon = <T>(read: () => T) => expect.poll(read, { timeout: 20_000 });

function repoAt(dir: string) {
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

/** The real server with a project and its coordinator on the demo agent, Hermes not connected. */
async function withHermes() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-hermes-"));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  repoAt(path.join(root, "site"));
  const store = new Store(path.join(root, "state.sqlite"));
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
    dataDir,
    webhookSend: async (url, init) => {
      posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return { status: 204 };
    },
  });
  const server = createHttpServer({ hub, token: APP_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const projectId = hub.createProject("Site vitrine", path.join(root, "site"));
  const coordinatorId = hub.openCoordinator(projectId, "demo");
  const seen: ServerMessage[] = [];
  const client: Client = { send: (m) => void seen.push(m) };
  const tokenFile = path.join(dataDir, "hermes-token");
  const token = () => readFileSync(tokenFile, "utf8").trim();
  const status = () => hub.hermes.status();
  const call = (tool: string, args: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${origin}${HERMES_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token()}`,
        ...headers,
      },
      body: JSON.stringify({ tool, args }),
    });
  const result = async (tool: string, args: unknown = {}) => {
    const res = await call(tool, args);
    const body = (await res.json()) as { result?: unknown; error?: string };
    return { status: res.status, ...body };
  };
  return {
    root,
    store,
    hub,
    origin,
    projectId,
    coordinatorId,
    client,
    seen,
    posted,
    tokenFile,
    token,
    status,
    call,
    result,
  };
}

describe("Hermes · accès", () => {
  it("n'ouvre rien avant Connecter, puis ouvre avec son propre jeton, et plus après Couper", async () => {
    const h = await withHermes();
    expect(h.status().connected).toBe(false);
    // Without an access, the app's own token opens nothing.
    const before = await fetch(`${h.origin}${HERMES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      body: JSON.stringify({ tool: "list_projects", args: {} }),
    });
    expect(before.status).toBe(401);

    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    expect(h.status().connected).toBe(true);
    // Only the hash is kept in the settings, never the token.
    expect(JSON.stringify(h.store.getSetting("hermes", {}))).not.toContain(h.token());

    const listed = await h.result("list_projects");
    expect(listed.status).toBe(200);
    expect(listed.result).toEqual([
      expect.objectContaining({
        project: "Site vitrine",
        project_id: h.projectId,
        coordinator: true,
      }),
    ]);

    const appToken = await fetch(`${h.origin}${HERMES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      body: JSON.stringify({ tool: "list_projects", args: {} }),
    });
    expect(appToken.status).toBe(401);

    const old = h.token();
    await h.hub.handle(h.client, { type: "hermes.cut", requestId: "r2" });
    expect(h.status().connected).toBe(false);
    const after = await fetch(`${h.origin}${HERMES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${old}` },
      body: JSON.stringify({ tool: "list_projects", args: {} }),
    });
    expect(after.status).toBe(401);
  });

  it("refuse un navigateur et ce qui vient par l'accès distant", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    expect((await h.call("list_projects", {}, { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await h.call("list_projects", {}, { "x-forwarded-for": "100.64.0.2" })).status).toBe(
      403,
    );
    const get = await fetch(`${h.origin}${HERMES_PATH}`, {
      headers: { authorization: `Bearer ${h.token()}` },
    });
    expect(get.status).toBe(405);
  });

  it("donne à copier la commande du pont avec l'adresse et le fichier du jeton", async () => {
    const h = await withHermes();
    const config = h.status().config;
    expect(config).toContain("  moonagentic:");
    expect(config).toContain(h.origin);
    expect(config).toContain(h.tokenFile);
    expect(config).toContain("hermes-bridge.ts");
  });
});

describe("Hermes · outils", () => {
  it("écrit au coordinateur comme l'utilisateur et rend sa réponse", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const asked = await h.result("ask_coordinator", {
      project: "site",
      message: "/ouvre Refaire le logo",
    });
    expect(asked.status).toBe(200);
    expect(asked.result).toEqual({
      answer: "J'ai ouvert le fil « Refaire le logo ».",
      opened_threads: [{ thread_id: expect.any(String), title: "Refaire le logo" }],
    });
    const items = h.store.listItems(h.coordinatorId);
    const sent = items.find((i) => i.kind === "user" && i.text === "/ouvre Refaire le logo");
    expect(sent).toMatchObject({ kind: "user", from: "hermes" });
    expect(h.status().log[0]).toMatchObject({
      what: "Message au coordinateur",
      project: "Site vitrine",
    });
    expect(h.status().lastSeen).toBeGreaterThan(0);
  });

  it("dit tout de suite quand le coordinateur attend l'utilisateur", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    // On the demo agent, an ordinary message makes the coordinator ask for a permission.
    const asked = await h.result("ask_coordinator", {
      project: "Site vitrine",
      message: "Bonjour",
    });
    expect(asked.result).toMatchObject({ waiting_for_user: true });
    const requests = (await h.result("list_requests")).result as {
      permissions: { thread_id: string }[];
    };
    expect(requests.permissions).toEqual([
      expect.objectContaining({ thread_id: h.coordinatorId, project: "Site vitrine" }),
    ]);
  });

  it("respecte ce que l'utilisateur a coupé dans les réglages", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    // Answering the agents' requests is off until the user turns it on.
    const answer = await h.result("answer_request", {
      thread_id: h.coordinatorId,
      request_id: "x",
    });
    expect(answer.status).toBe(400);
    expect(answer.error).toContain("répondre aux demandes");

    await h.hub.handle(h.client, {
      type: "hermes.set",
      requestId: "r2",
      allow: { coordinators: false, plan: false },
    });
    const ask = await h.result("ask_coordinator", { project: "Site vitrine", message: "Salut" });
    expect(ask.status).toBe(400);
    expect(ask.error).toContain("écrire aux coordinateurs");
    const card = await h.result("add_plan_card", { project: "Site vitrine", title: "Logo" });
    expect(card.error).toContain("planifier");
    expect(h.store.listItems(h.coordinatorId).some((i) => i.kind === "user")).toBe(false);
    expect(h.hub.planner.list()).toHaveLength(0);
    // Reading stays open.
    expect((await h.result("project_status", { project: "Site vitrine" })).status).toBe(200);
  });

  it("ajoute une carte au Planner et une tâche planifiée, marquées Hermes", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const card = await h.result("add_plan_card", {
      project: "Site vitrine",
      title: "Refaire le logo",
      due: "2026-12-04",
    });
    expect(card.status).toBe(200);
    const [task] = h.hub.planner.list();
    expect(task).toMatchObject({
      projectId: h.projectId,
      title: "Refaire le logo",
      source: "hermes",
      due: new Date(2026, 11, 4).getTime(),
    });

    const bad = await h.result("add_plan_card", {
      project: "Site vitrine",
      title: "X",
      due: "2026-02-31",
    });
    expect(bad.error).toContain("AAAA-MM-JJ");

    const planned = await h.result("schedule_task", {
      project: "Site vitrine",
      message: "Vérifie les liens morts du site",
      when: "2030-01-02T09:30",
      repeat: "weekdays",
    });
    expect(planned.status).toBe(200);
    const [schedule] = h.hub.scheduler.list();
    expect(schedule).toMatchObject({
      projectId: h.projectId,
      text: "Vérifie les liens morts du site",
      repeat: "weekdays",
      by: "hermes",
    });
    expect(schedule!.nextAt).toBe(new Date(2030, 0, 2, 9, 30).getTime());
  });

  it("ne voit pas un projet verrouillé ni un projet inconnu", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const unknown = await h.result("project_status", { project: "Inexistant" });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toContain("Site vitrine");
  });
});

describe("Hermes · Discord", () => {
  it("n'accepte qu'une adresse de webhook Discord", () => {
    expect(discordWebhook(WEBHOOK)).toBe(true);
    expect(discordWebhook("https://discordapp.com/api/webhooks/1/x")).toBe(true);
    expect(discordWebhook("http://discord.com/api/webhooks/1/x")).toBe(false);
    expect(discordWebhook("https://discord.com.evil.io/api/webhooks/1/x")).toBe(false);
    expect(discordWebhook("https://discord.com:8443/api/webhooks/1/x")).toBe(false);
    expect(discordWebhook("https://discord.com/api/users/1")).toBe(false);
    expect(discordWebhook("pas une adresse")).toBe(false);
  });

  it("enregistre le webhook, envoie le test sans mentionner personne, et le retire", async () => {
    const h = await withHermes();
    await expect(
      h.hub.handle(h.client, { type: "hermes.set", requestId: "r0", webhook: "https://x.io/a" }),
    ).rejects.toThrow("webhook Discord");
    await h.hub.handle(h.client, { type: "hermes.set", requestId: "r1", webhook: WEBHOOK });
    expect(h.status().webhook).toBe(true);
    // The address itself never goes to the app's screens.
    expect(JSON.stringify(h.status())).not.toContain("abc-DEF_9");
    await h.hub.handle(h.client, { type: "hermes.test", requestId: "r2" });
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({
      url: WEBHOOK,
      body: { username: "MoonAgentic", allowed_mentions: { parse: [] } },
    });
    await h.hub.handle(h.client, { type: "hermes.set", requestId: "r3", webhook: null });
    expect(h.status().webhook).toBe(false);
  });

  it("prévient quand un fil a fini, et se tait si c'est coupé", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.set", requestId: "r1", webhook: WEBHOOK });
    await h.hub.handle(h.client, {
      type: "thread.create",
      requestId: "t1",
      projectId: h.projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Bonjour",
    });
    const work = await (async () => {
      await soon(() =>
        h.store.listThreads().some((t) => t.projectId === h.projectId && t.kind !== "coordinator"),
      ).toBe(true);
      return h.store
        .listThreads()
        .find((t) => t.projectId === h.projectId && t.kind !== "coordinator")!;
    })();
    await h.hub.whenIdle(work.id);
    await soon(() => h.posted.map((p) => String(p.body.content))).toContainEqual(
      expect.stringContaining("**Fil terminé** · Site vitrine"),
    );

    const count = h.posted.length;
    await h.hub.handle(h.client, {
      type: "hermes.set",
      requestId: "r2",
      notify: { done: false },
    });
    await h.hub.handle(h.client, { type: "thread.send", threadId: work.id, text: "Encore" });
    await h.hub.whenIdle(work.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.posted.slice(count).some((p) => String(p.body.content).includes("Fil terminé"))).toBe(
      false,
    );
  });

  it("dit ce qui a changé, pas ce qui était déjà vrai", () => {
    const base = {
      id: "t",
      projectId: "p",
      title: "Formulaire de contact",
      status: "running",
      updatedAt: 0,
    } as never as Parameters<typeof discordNotices>[0];
    const all = { done: true, waiting: true, prReady: true };
    expect(discordNotices(base, { ...base, status: "idle" }, all, "Site")).toEqual([
      "**Fil terminé** · Site\nFormulaire de contact",
    ]);
    expect(discordNotices(base, { ...base, status: "waiting" }, all, "Site")).toEqual([
      "**Attend ta réponse** · Site\nFormulaire de contact",
    ]);
    // A coordinator or a thread under another one is never told.
    expect(
      discordNotices(base, { ...base, status: "idle", kind: "coordinator" } as never, all, "Site"),
    ).toEqual([]);
    expect(
      discordNotices(base, { ...base, status: "idle", parentId: "x" } as never, all, "Site"),
    ).toEqual([]);
    expect(
      discordNotices(base, { ...base, status: "idle" }, { ...all, done: false }, "Site"),
    ).toEqual([]);
  });
});

describe("Hermes · pont MCP", () => {
  it("répond à Hermes sur stdio et passe l'appel à MoonAgentic", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const bridge = spawn(process.execPath, [BRIDGE, h.origin, h.tokenFile], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    cleanups.push(() => {
      bridge.kill();
    });
    const replies = new Map<number, Record<string, unknown>>();
    let rest = "";
    bridge.stdout.on("data", (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id: number } & Record<string, unknown>;
        replies.set(message.id, message);
      }
    });
    const ask = async (id: number, method: string, params: unknown = {}) => {
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await soon(() => replies.has(id)).toBe(true);
      return replies.get(id)!;
    };
    const init = await ask(1, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.result).toMatchObject({ serverInfo: { name: "moonagentic" } });
    const tools = (await ask(2, "tools/list")).result as { tools: { name: string }[] };
    expect(tools.tools.map((t) => t.name)).toEqual(HERMES_TOOLS.map((t) => t.name));
    const listed = (await ask(3, "tools/call", { name: "list_projects", arguments: {} }))
      .result as { content: { text: string }[]; isError?: boolean };
    expect(listed.isError).toBeUndefined();
    expect(listed.content[0]!.text).toContain("Site vitrine");
    const unknown = await ask(4, "tools/call", { name: "rm_rf", arguments: {} });
    expect(unknown.error).toMatchObject({ code: -32602 });

    // Cut: the bridge, still running, reads the file again and is refused.
    await h.hub.handle(h.client, { type: "hermes.cut", requestId: "r2" });
    const refused = (await ask(5, "tools/call", { name: "list_projects", arguments: {} }))
      .result as { content: { text: string }[]; isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Connecter Hermes");
  });
});
