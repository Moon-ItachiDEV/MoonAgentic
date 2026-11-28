import { execFileSync, spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { dayOf, discordNotices, discordWebhook, timeOf } from "../src/hermes.ts";
import { BACKUP_SUFFIX, type HermesRun, modelOf, splitModel } from "../src/hermes-cli.ts";
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

/**
 * Hermes's command line as the tests play it: its `config.yaml` is a file of the test, `config
 * set` writes what it is given into a map, and each command is noted. `fail` makes one fail.
 */
function fakeHermes(root: string) {
  const configFile = path.join(root, "hermes-config.yaml");
  writeFileSync(configFile, "model:\n  default: gpt-6.2-sol\n  provider: openai-codex\n");
  const calls: string[][] = [];
  const config: Record<string, string> = {
    "model.default": "gpt-6.2-sol",
    "model.provider": "openai-codex",
  };
  const fail: { on?: string } = {};
  /** `old`: a Hermes from before August 2026, which keeps a JSON value as a string. */
  const mode = { old: false, gatewayUp: true };
  /** A command held until `release()`: for what happens while it runs. */
  const hold: { on?: string; release?: () => void } = {};
  const run = async (args: string[]): Promise<HermesRun> => {
    calls.push(args);
    const said = args.join(" ");
    if (hold.on && said.startsWith(hold.on)) {
      delete hold.on;
      await new Promise<void>((resolve) => {
        hold.release = resolve;
      });
    }
    if (fail.on && said.startsWith(fail.on)) return { code: 1, out: "", err: "✗ Ça a raté.\n" };
    if (said === "config path") return { code: 0, out: `${configFile}\n`, err: "" };
    if (args[0] === "config" && args[1] === "set") {
      config[args[2]!] = args[3]!;
      return { code: 0, out: "✓ Set\n", err: "" };
    }
    if (said === "config get model --json") {
      return {
        code: 0,
        out: JSON.stringify({
          default: config["model.default"],
          provider: config["model.provider"],
        }),
        err: "",
      };
    }
    if (said === "config get mcp_servers.moonagentic --json") {
      const value = config["mcp_servers.moonagentic"];
      if (value === undefined) return { code: 1, out: "", err: "✗ Not set\n" };
      return { code: 0, out: mode.old ? JSON.stringify(value) : value, err: "" };
    }
    if (said === "gateway ensure --json --timeout 60") {
      return mode.gatewayUp
        ? { code: 0, out: '{"state":"running"}\n', err: "" }
        : { code: 1, out: '{"state":"stopped","message":"Discord refuse le jeton"}\n', err: "" };
    }
    if (said === "gateway restart --yes --detach")
      return { code: 0, out: "✓ Restarted\n", err: "" };
    return { code: 2, out: "", err: `inconnu : ${said}` };
  };
  return { configFile, calls, config, fail, mode, hold, run };
}

/** The real server with a project and its coordinator on the demo agent, Hermes not connected. */
async function withHermes() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-hermes-"));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  repoAt(path.join(root, "site"));
  const store = new Store(path.join(root, "state.sqlite"));
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  // Never the real Hermes of the machine running the tests.
  const cli = fakeHermes(root);
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
    dataDir,
    hermesRunner: cli.run,
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
    cli,
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

  it("pose une carte dans la colonne voulue, avec son échéance", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const put = async (title: string, column?: string, due?: string) =>
      await h.result("add_plan_card", {
        project: "Site vitrine",
        title,
        ...(column ? { column } : {}),
        ...(due ? { due } : {}),
      });
    expect((await put("Tester /revue sur le mini-PC")).result).toMatchObject({
      column: "À faire",
    });
    expect((await put("Vérifier les icônes clavier", "En cours")).result).toMatchObject({
      column: "En cours",
    });
    // Any case, any accent, or the column's id.
    const later = await h.result("add_plan_card", {
      project: "Site vitrine",
      title: "Publier v0.1.19",
      column: "reporte",
      start: "2026-11-28",
      due: "2026-11-30",
    });
    expect(later.result).toMatchObject({
      column: "Reporté",
      start: "2026-11-28",
      due: "2026-11-30",
    });
    await put("Essai", "test");
    const cards = h.hub.planner.list();
    expect(cards.map((c) => [c.title, c.status])).toEqual(
      expect.arrayContaining([
        ["Tester /revue sur le mini-PC", "todo"],
        ["Vérifier les icônes clavier", "doing"],
        ["Publier v0.1.19", "report"],
        ["Essai", "test"],
      ]),
    );
    const doing = cards.find((c) => c.status === "doing")!;
    // Out of « À faire », its work began: the Timeline draws it from today.
    expect(doing.startedAt).toBeTypeOf("number");
    expect(cards.find((c) => c.status === "report")!.due).toBe(new Date(2026, 10, 30).getTime());

    const bad = await put("X", "Plus tard");
    expect(bad.status).toBe(400);
    expect(bad.error).toContain("En test");
    expect(h.hub.planner.list()).toHaveLength(4);
  });

  it("déplace, modifie et supprime une carte par son numéro", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    const card = h.hub.planner.add({
      projectId: h.projectId,
      title: "Publier v0.1.19",
      description: "Après le correctif clavier",
      start: new Date(2026, 10, 27).getTime(),
    });
    const ref = `#${card.number}`;

    // Models that send `null` for untouched optional fields must not wipe existing values.
    const moved = await h.result("update_plan_card", {
      project: "Site vitrine",
      card: ref,
      column: "Reporté",
      title: null,
      description: null,
      start: null,
      due: "2026-11-30",
    });
    expect(moved.status).toBe(200);
    expect(moved.result).toMatchObject({
      column: "Reporté",
      start: "2026-11-27",
      due: "2026-11-30",
    });
    expect(h.hub.planner.list()[0]).toMatchObject({
      status: "report",
      start: new Date(2026, 10, 27).getTime(),
      due: new Date(2026, 10, 30).getTime(),
      title: "Publier v0.1.19",
      description: "Après le correctif clavier",
    });

    // Only what is given changes; an empty or blank string clears it. The number may come bare or numeric.
    const edited = await h.result("update_plan_card", {
      project: "Site vitrine",
      card: card.number,
      title: "Publier la v0.1.19",
      description: "",
      start: "   ",
    });
    expect(edited.status).toBe(200);
    const [now] = h.hub.planner.list();
    expect(now).toMatchObject({ title: "Publier la v0.1.19", status: "report" });
    expect(now!.description).toBeUndefined();
    expect(now!.start).toBeUndefined();
    expect(now!.due).toBe(new Date(2026, 10, 30).getTime());

    const emptyTitle = await h.result("update_plan_card", {
      project: "Site vitrine",
      card: String(card.number),
      title: "",
    });
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.error).toContain("vide");
    const nothing = await h.result("update_plan_card", { project: "Site vitrine", card: ref });
    expect(nothing.error).toContain("Rien à changer");
    const unknown = await h.result("update_plan_card", {
      project: "Site vitrine",
      card: "#999",
      column: "En cours",
    });
    expect(unknown.error).toContain("read_planner");

    // A card that follows its thread is not moved by hand.
    const linked = h.hub.planner.add({ projectId: h.projectId, title: "Page contact" });
    h.hub.planner.update(linked.id, { threadId: h.coordinatorId });
    const held = await h.result("update_plan_card", {
      project: "Site vitrine",
      card: `#${linked.number}`,
      column: "Livré",
    });
    expect(held.status).toBe(400);
    expect(held.error).toContain("suit son fil");

    // A card of another project is not found under this one.
    repoAt(path.join(h.root, "boutique"));
    const other = h.hub.createProject("Boutique", path.join(h.root, "boutique"));
    for (const title of ["Panier", "Livraison"]) h.hub.planner.add({ projectId: other, title });
    const theirs = h.hub.planner.add({ projectId: other, title: "Paiement" });
    expect(theirs.number).toBe(3);
    const wrong = await h.result("remove_plan_card", { project: "Site vitrine", card: "#3" });
    expect(wrong.status).toBe(400);

    const removed = await h.result("remove_plan_card", { project: "Site vitrine", card: ref });
    expect(removed.result).toMatchObject({ removed: `${ref} Publier la v0.1.19` });
    expect(
      h.hub.planner
        .list()
        .map((c) => c.title)
        .sort(),
    ).toEqual(["Livraison", "Page contact", "Paiement", "Panier"]);
    expect(h.status().log?.map((l) => l.what)).toEqual(
      expect.arrayContaining([
        "Carte déplacée en Reporté · Publier v0.1.19",
        "Carte modifiée · Publier la v0.1.19",
        "Carte supprimée du Planner · Publier la v0.1.19",
      ]),
    );

    // Turned off in the settings, nothing changes.
    await h.hub.handle(h.client, { type: "hermes.set", requestId: "r2", allow: { plan: false } });
    const offUpdate = await h.result("update_plan_card", {
      project: "Site vitrine",
      card: `#${linked.number}`,
      title: "Autre",
    });
    expect(offUpdate.error).toContain("planifier");
    const off = await h.result("remove_plan_card", {
      project: "Site vitrine",
      card: `#${linked.number}`,
    });
    expect(off.error).toContain("planifier");
    expect(h.hub.planner.list()).toHaveLength(4);
  });

  it("lit le Planner d'un projet ou de tous, par colonne, sans rien y changer", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    repoAt(path.join(h.root, "boutique"));
    const other = h.hub.createProject("Boutique", path.join(h.root, "boutique"));
    const late = h.hub.planner.add({
      projectId: h.projectId,
      title: "Refaire le logo",
      due: new Date(2020, 0, 3).getTime(),
    });
    h.hub.planner.update(late.id, { status: "doing" });
    const contact = h.hub.planner.add({ projectId: h.projectId, title: "Page contact" });
    // A card a thread works on: its id, to go on with read_thread.
    h.hub.planner.update(contact.id, { threadId: h.coordinatorId });
    const shipped = h.hub.planner.add({ projectId: other, title: "Paiement" });
    h.hub.planner.update(shipped.id, { status: "live" });
    const before = JSON.stringify(h.hub.planner.list());

    const one = await h.result("read_planner", { project: "Site vitrine" });
    expect(one.status).toBe(200);
    const cards = (one.result as { total: number; cards: Record<string, unknown>[] }).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      project: "Site vitrine",
      card: `#${late.number}`,
      title: "Refaire le logo",
      column: "En cours",
      due: "2020-01-03",
      late: true,
    });
    expect(cards[1]).toMatchObject({
      thread_id: h.coordinatorId,
      thread_state: expect.any(String),
    });
    // Its column follows the thread that works on it.
    expect(cards[1]).toMatchObject({ title: "Page contact", column: "En test" });

    const all = await h.result("read_planner");
    expect((all.result as { total: number }).total).toBe(3);
    const delivered = await h.result("read_planner", { column: "livré" });
    expect((delivered.result as { cards: unknown[] }).cards).toEqual([
      expect.objectContaining({ project: "Boutique", title: "Paiement", column: "Livré" }),
    ]);
    const bad = await h.result("read_planner", { column: "Plus tard" });
    expect(bad.error).toContain("À faire");
    // Read only: the Planner is as it was.
    expect(JSON.stringify(h.hub.planner.list())).toBe(before);
  });

  it("ne voit pas un projet verrouillé ni un projet inconnu", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const unknown = await h.result("project_status", { project: "Inexistant" });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toContain("Site vitrine");

    // Its Planner neither, asked by name or with all the others.
    h.hub.planner.add({ projectId: h.projectId, title: "Carte secrète" });
    h.hub.locks.setPin("123456");
    h.hub.locks.lock(h.projectId);
    const named = await h.result("read_planner", { project: "Site vitrine" });
    expect(named.status).toBe(400);
    const all = await h.result("read_planner");
    expect(JSON.stringify(all.result)).not.toContain("Carte secrète");
    expect((all.result as { total: number }).total).toBe(0);
  });
});

describe("Hermes · réglage de Hermes depuis MoonAgentic", () => {
  it("Connecter écrit l'entrée de MoonAgentic dans config.yaml, garde une copie et relance Hermes", async () => {
    const h = await withHermes();
    const original = readFileSync(h.cli.configFile, "utf8");
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    expect(h.status().setup).toMatchObject({ what: "connect", state: "running" });
    await h.hub.hermes.settled();
    expect(h.status().setup).toMatchObject({ what: "connect", state: "done" });
    const entry = JSON.parse(h.cli.config["mcp_servers.moonagentic"]!) as {
      command: string;
      args: string[];
      timeout: number;
    };
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([
      expect.stringContaining("hermes-bridge.ts"),
      h.origin,
      h.tokenFile,
    ]);
    expect(entry.timeout).toBeGreaterThan(13 * 60);
    // The token itself never goes into Hermes's config: only the file that holds it.
    expect(h.cli.config["mcp_servers.moonagentic"]).not.toContain(h.token());
    expect(readFileSync(`${h.cli.configFile}${BACKUP_SUFFIX}`, "utf8")).toBe(original);
    // Then its model is read again, for the page.
    expect(h.cli.calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "config path",
      "config set mcp_servers.moonagentic",
      "config get mcp_servers.moonagentic",
      "gateway restart --yes",
      "config get model",
    ]);
    expect(h.cli.calls[3]).toEqual(["gateway", "restart", "--yes", "--detach"]);
  });

  it("dit pourquoi le réglage a échoué, et Réessayer le refait", async () => {
    const h = await withHermes();
    h.cli.fail.on = "gateway restart";
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    expect(h.status().setup).toMatchObject({ state: "failed" });
    expect(h.status().setup?.error).toContain("Ça a raté");
    delete h.cli.fail.on;
    await h.hub.handle(h.client, { type: "hermes.install", requestId: "r2" });
    await h.hub.hermes.settled();
    expect(h.status().setup).toMatchObject({ state: "done" });
  });

  it("refuse un second réglage pendant le premier", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await expect(
      h.hub.handle(h.client, { type: "hermes.install", requestId: "r2" }),
    ).rejects.toThrow("déjà");
    await h.hub.hermes.settled();
  });

  it("lit le modèle de Hermes et le change, fournisseur d'abord, puis relance Hermes", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.get" });
    await soon(() => h.status().model).toEqual({ provider: "openai-codex", model: "gpt-6.2-sol" });
    h.cli.calls.length = 0;
    await h.hub.handle(h.client, {
      type: "hermes.setModel",
      requestId: "m1",
      model: "openrouter:anthropic/claude-sonnet-4",
    });
    await h.hub.hermes.settled();
    expect(h.status().modelSetup).toMatchObject({ what: "model", state: "done" });
    expect(h.status().setup).toBeUndefined();
    const sets = h.cli.calls.filter((c) => c[1] === "set");
    expect(sets).toEqual([
      ["config", "set", "model.provider", "openrouter"],
      ["config", "set", "model.default", "anthropic/claude-sonnet-4"],
    ]);
    expect(h.cli.calls.at(-2)).toEqual(["gateway", "restart", "--yes", "--detach"]);
    await soon(() => h.status().model).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("lit les identifiants de modèles comme Hermes", () => {
    expect(splitModel("openai-codex:gpt-6.2-sol")).toEqual({
      provider: "openai-codex",
      model: "gpt-6.2-sol",
    });
    expect(splitModel("custom:local:qwen-2.5")).toEqual({
      provider: "custom:local",
      model: "qwen-2.5",
    });
    expect(splitModel("openrouter:anthropic/claude:beta")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude:beta",
    });
    expect(splitModel("gpt-6.2-sol")).toEqual({ model: "gpt-6.2-sol" });
    expect(modelOf('{"default":"x","provider":"auto"}')).toEqual({ model: "x" });
    expect(modelOf('{"model":"y","provider":"nous"}')).toEqual({ provider: "nous", model: "y" });
    expect(modelOf('"z"')).toEqual({ model: "z" });
    expect(modelOf("pas du json")).toBeUndefined();
  });
});

describe("Hermes · relecture de Neon", () => {
  it("1. n'écrit pas au coordinateur par message_thread quand c'est coupé, ni dans un sous-fil", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.handle(h.client, {
      type: "hermes.set",
      requestId: "r2",
      allow: { coordinators: false, threads: true },
    });
    const sent = await h.result("message_thread", {
      thread_id: h.coordinatorId,
      message: "Passe par la porte de côté",
    });
    expect(sent.status).toBe(400);
    expect(h.store.listItems(h.coordinatorId).some((i) => i.kind === "user")).toBe(false);

    const parent = h.store.getThread(h.coordinatorId)!;
    h.store.addThread({
      ...parent,
      id: "sous-fil",
      kind: undefined,
      parentId: "fil-parent",
      title: "Morceau d'équipe",
    } as never);
    const member = await h.result("message_thread", { thread_id: "sous-fil", message: "Salut" });
    expect(member.status).toBe(400);
  });

  it("2. isole une tâche planifiée sur sa branche, et ne voit pas un projet archivé", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.result("schedule_task", {
      project: "Site vitrine",
      message: "Vérifie les liens",
      when: "2030-01-02T09:30",
      repeat: "once",
    });
    expect(h.hub.scheduler.list()[0]).toMatchObject({ isolated: true });

    await h.hub.handle(h.client, {
      type: "project.setArchived",
      requestId: "a1",
      projectId: h.projectId,
      archived: true,
    } as never);
    expect((await h.result("list_projects")).result).toEqual([]);
    const status = await h.result("project_status", { project: "Site vitrine" });
    expect(status.status).toBe(400);
    const read = await h.result("read_thread", { thread_id: h.coordinatorId });
    expect(read.status).toBe(400);
  });

  it("3a. n'empile pas un écouteur d'arrêt par seconde d'attente", async () => {
    const h = await withHermes();
    h.hub.hermes.connect();
    const token = h.token();
    const stop = new AbortController();
    // A long turn: the demo agent takes several seconds « en 5 étapes ».
    const asked = h.hub.hermes.call(
      token,
      "ask_coordinator",
      { project: "Site vitrine", message: "/ouvre Logo en 5 étapes" },
      stop.signal,
    );
    await new Promise((r) => setTimeout(r, 4500));
    expect(getEventListeners(stop.signal, "abort").length).toBeLessThanOrEqual(1);
    stop.abort();
    await asked;
  }, 20_000);

  it("3b. rend la main quand le message reste en file après un tour en erreur", async () => {
    const h = await withHermes();
    h.hub.hermes.connect();
    // The coordinator waits for a permission: its turn is under way.
    await h.hub.handle(h.client, {
      type: "thread.send",
      threadId: h.coordinatorId,
      text: "Regarde",
    });
    await soon(() => h.store.getThread(h.coordinatorId)!.status).toBe("waiting");
    const started = Date.now();
    const asked = h.hub.hermes.call(h.token(), "ask_coordinator", {
      project: "Site vitrine",
      message: "/fils",
    });
    // Whatever comes back, it must not be the 13 minutes' wait.
    const result = (await Promise.race([
      asked,
      new Promise((r) => setTimeout(() => r("toujours en attente"), 6000)),
    ])) as Record<string, unknown> | string;
    expect(result).not.toBe("toujours en attente");
    expect(Date.now() - started).toBeLessThan(6000);
    expect(result).toMatchObject({ waiting_for_user: true });
  }, 20_000);

  it("3c. remonte l'erreur du coordinateur au lieu d'une réponse vide", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const asked = await h.result("ask_coordinator", { project: "Site vitrine", message: "boom" });
    expect(asked.status).toBe(400);
    expect(asked.error).toContain("planté");
  });

  it("3d. ne prend pas la réponse au message suivant pour la sienne", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    const asked = await h.result("ask_coordinator", {
      project: "Site vitrine",
      message: "/ouvre Refaire le logo",
    });
    expect(asked.result).toMatchObject({ answer: "J'ai ouvert le fil « Refaire le logo »." });
    // The answer sent to Discord is marked on the message, for the app's « Envoyé sur Discord ».
    const mine = h.store
      .listItems(h.coordinatorId)
      .find((i) => i.kind === "user" && i.from === "hermes");
    expect(mine).toMatchObject({ relayed: true });
  });

  it("4. ne marque rien comme envoyé sur Discord pour message_thread", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.result("message_thread", { thread_id: h.coordinatorId, message: "/fils" });
    await h.hub.whenIdle(h.coordinatorId);
    const mine = h.store
      .listItems(h.coordinatorId)
      .find((i) => i.kind === "user" && i.from === "hermes");
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty("relayed");
  });

  it("6. refuse les dates impossibles", () => {
    expect(() => timeOf("2026-02-31T09:30", "when")).toThrow();
    expect(() => timeOf("2026-13-01T09:30", "when")).toThrow();
    expect(() => dayOf("2026-13-01", "due")).toThrow();
    expect(() => dayOf("2026-00-01", "due")).toThrow();
    expect(dayOf("2028-02-29", "due")).toBe(new Date(2028, 1, 29).getTime());
    expect(timeOf("2026-12-31T23:59", "when")).toBe(new Date(2026, 11, 31, 23, 59).getTime());
  });

  it("mineur : ne répond pas à la question d'un autre fil", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.handle(h.client, {
      type: "hermes.set",
      requestId: "r2",
      allow: { requests: true },
    });
    const hub = h.hub as unknown as {
      pendingQuestions: () => unknown[];
      respondToQuestion: (...args: unknown[]) => void;
    };
    // A question of another thread, maybe of a locked project.
    hub.pendingQuestions = () => [
      { threadId: "ailleurs", itemId: "q1", questions: [{ question: "?", options: ["a"] }] },
    ];
    const answered: unknown[] = [];
    hub.respondToQuestion = (...args) => void answered.push(args);
    const answer = await h.result("answer_request", {
      thread_id: h.coordinatorId,
      request_id: "q1",
      answers: ["a"],
    });
    expect(answer.status).toBe(400);
    expect(answer.error).toContain("n'attend plus");
    expect(answered).toEqual([]);
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

  it("mineur : dit le refus du serveur quand sa réponse n'est pas du JSON", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    // The bridge pointed at a path answering 404 with an empty body.
    const bridge = spawn(process.execPath, [BRIDGE, `${h.origin}/rien`, h.tokenFile], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    cleanups.push(() => void bridge.kill());
    let out = "";
    bridge.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    bridge.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } })}\n`,
    );
    await soon(() => out.includes("\n")).toBe(true);
    const reply = JSON.parse(out) as { result: { content: { text: string }[] } };
    expect(reply.result.content[0]!.text).not.toContain("JSON");
    expect(reply.result.content[0]!.text).toMatch(/\d{3}/);
  });
});

describe("Hermes · relecture de Neon (réglage depuis MoonAgentic)", () => {
  it("1. un « en cours » laissé par un arrêt n'est pas montré, et fermer attend la fin du réglage", async () => {
    const h = await withHermes();
    h.store.setSetting("hermes", { setup: { what: "connect", state: "running", at: 1 } });
    expect(h.status().setup).toBeUndefined();
    h.store.setSetting("hermes", {});
    h.cli.hold.on = "gateway restart";
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await soon(() => !!h.cli.hold.release).toBe(true);
    // Never saved: only what is under way in this server.
    expect(h.store.getSetting<{ setup?: unknown }>("hermes", {}).setup).toBeUndefined();
    let closed = false;
    const closing = h.hub.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    h.cli.hold.release!();
    await closing;
    expect(h.store.getSetting<{ setup?: unknown }>("hermes", {}).setup).toMatchObject({
      state: "done",
    });
  });

  it("2. le changement de modèle a son propre état, et Couper efface celui de la connexion", async () => {
    const h = await withHermes();
    h.cli.fail.on = "config set model.default";
    await h.hub.handle(h.client, {
      type: "hermes.setModel",
      requestId: "m1",
      model: "nous:hermes-5",
    });
    await h.hub.hermes.settled();
    expect(h.status().modelSetup).toMatchObject({ state: "failed" });
    expect(h.status().setup).toBeUndefined();
    delete h.cli.fail.on;
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    expect(h.status().setup).toMatchObject({ state: "done" });
    expect(h.status().modelSetup).toMatchObject({ state: "failed" });
    await h.hub.handle(h.client, { type: "hermes.cut", requestId: "r2" });
    expect(h.status().setup).toBeUndefined();
  });

  it("3. une lecture du modèle commencée avant un changement ne remet pas l'ancien", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.get" });
    await soon(() => h.status().model?.model).toBe("gpt-6.2-sol");
    // An old read held, then the model changed meanwhile.
    h.cli.hold.on = "config get model";
    // @ts-expect-error -- the throttle, reset for the test.
    h.hub.hermes.modelReadAt = 0;
    const oldRead = h.hub.hermes.readModel();
    await soon(() => !!h.cli.hold.release).toBe(true);
    // The model known stays shown while it is read.
    expect(h.status().model?.model).toBe("gpt-6.2-sol");
    const release = h.cli.hold.release!;
    h.cli.hold.release = undefined;
    await h.hub.handle(h.client, {
      type: "hermes.setModel",
      requestId: "m1",
      model: "nous:hermes-5",
    });
    await h.hub.hermes.settled();
    await soon(() => h.status().model).toEqual({ provider: "nous", model: "hermes-5" });
    // The held read now answers what Hermes said before the change: it is not kept.
    h.cli.config["model.default"] = "gpt-6.2-sol";
    release();
    await oldRead;
    expect(h.status().model).toEqual({ provider: "nous", model: "hermes-5" });
  });

  it("4. un hermes.cmd qui ne peut pas recevoir le réglage dit de le copier", async () => {
    const { hermesRunner, reason } = await import("../src/hermes-cli.ts");
    const done = await hermesRunner("C:\\hermes\\hermes.cmd", "win32")(
      ["config", "set", "mcp_servers.moonagentic", '{"command": "node"}'],
      1000,
    );
    expect(done.code).toBe(1);
    expect(reason(done)).toContain("copie le réglage dans config.yaml");
  });

  it("6. Connecter pendant un changement de modèle écrit l'entrée juste après", async () => {
    const h = await withHermes();
    h.cli.hold.on = "gateway restart";
    await h.hub.handle(h.client, {
      type: "hermes.setModel",
      requestId: "m1",
      model: "nous:hermes-5",
    });
    await soon(() => !!h.cli.hold.release).toBe(true);
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    expect(h.status().setup).toMatchObject({ state: "running" });
    h.cli.hold.release!();
    await h.hub.hermes.settled();
    expect(h.cli.config["mcp_servers.moonagentic"]).toContain("hermes-bridge");
    expect(h.status().setup).toMatchObject({ state: "done" });
    expect(h.status().modelSetup).toMatchObject({ state: "done" });
  });

  it("7. dit que Hermes n'a pas répondu à temps", async () => {
    const { hermesRunner, reason } = await import("../src/hermes-cli.ts");
    const done = await hermesRunner(process.execPath)(["-e", "setTimeout(() => {}, 5000)"], 300);
    expect(done.code).not.toBe(0);
    expect(reason(done)).toContain("délai dépassé");
  });

  it("8. un Hermes trop ancien qui garde le JSON en texte est signalé", async () => {
    const h = await withHermes();
    h.cli.mode.old = true;
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    expect(h.status().setup).toMatchObject({ state: "failed" });
    expect(h.status().setup?.error).toContain("hermes update");
    expect(h.cli.calls.some((c) => c[1] === "restart")).toBe(false);
  });

  it("passerelle : la regarde une fois connecté, la dit arrêtée et pourquoi", async () => {
    const h = await withHermes();
    await h.hub.hermes.watchGateway();
    expect(h.status().gateway).toBeUndefined();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    h.cli.mode.gatewayUp = false;
    await h.hub.handle(h.client, { type: "hermes.gateway", requestId: "g1" });
    expect(h.status().gateway).toMatchObject({ running: false, reason: "Discord refuse le jeton" });
    h.cli.mode.gatewayUp = true;
    await h.hub.handle(h.client, { type: "hermes.gateway", requestId: "g2" });
    expect(h.status().gateway).toMatchObject({ running: true });
  });
});

describe("Hermes · entrée de MoonAgentic absente ou périmée dans config.yaml", () => {
  it("connecté sans entrée (avant que MoonAgentic sache régler Hermes) : l'écrit et relance la passerelle", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    // As on the mini-PC: connected, but nothing under `mcp_servers` in Hermes's config.yaml.
    delete h.cli.config["mcp_servers.moonagentic"];
    h.cli.calls.length = 0;
    await h.hub.hermes.watchGateway();
    await h.hub.hermes.settled();
    expect(h.cli.config["mcp_servers.moonagentic"]).toContain("hermes-bridge");
    expect(h.cli.calls.some((c) => c.join(" ") === "gateway restart --yes --detach")).toBe(true);
    expect(h.status().setup).toMatchObject({ state: "done" });
    // Looked at once per start: the next look only watches the gateway.
    h.cli.calls.length = 0;
    await h.hub.hermes.watchGateway();
    expect(h.cli.calls.map((c) => c.join(" "))).toEqual(["gateway ensure --json --timeout 60"]);
  });

  it("une entrée qui lance un autre pont (ancien chemin) est réécrite", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    const entry = JSON.parse(h.cli.config["mcp_servers.moonagentic"]!) as { args: string[] };
    entry.args[0] = "C:\\ailleurs\\server\\src\\hermes-bridge.ts";
    h.cli.config["mcp_servers.moonagentic"] = JSON.stringify(entry);
    await h.hub.hermes.watchGateway();
    await h.hub.hermes.settled();
    expect(h.cli.config["mcp_servers.moonagentic"]).not.toContain("ailleurs");
  });

  it("une entrée déjà juste ne relance pas Hermes", async () => {
    const h = await withHermes();
    await h.hub.handle(h.client, { type: "hermes.connect", requestId: "r1" });
    await h.hub.hermes.settled();
    h.cli.calls.length = 0;
    await h.hub.hermes.watchGateway();
    await h.hub.hermes.settled();
    expect(h.cli.calls.map((c) => c.join(" "))).toEqual([
      "config get mcp_servers.moonagentic --json",
      "gateway ensure --json --timeout 60",
    ]);
    expect(h.status().gateway).toMatchObject({ running: true });
  });
});
