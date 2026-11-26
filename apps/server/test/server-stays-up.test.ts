// What used to stop the whole server, and every agent at work with it (audit of 2026-11-25:
// N2, N3, N12, N18, N21, N22): a write the database refuses, an agent that leaves the
// protocol, saved values the server did not write, a stray line from Codex.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Item, ServerMessage, Thread } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Agents } from "../src/agents.ts";
import { DiagnosticsMonitor } from "../src/diagnostics.ts";
import { type Client, Hub } from "../src/hub.ts";
import { ProjectLocks } from "../src/locks.ts";
import { askCodex } from "../src/quotas.ts";
import { AgentSession } from "../src/session.ts";
import { Store, storageTrouble } from "../src/store.ts";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-up-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

class Screen implements Client {
  openThreadIds?: Set<string>;
  readonly messages: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  /** What the screen was last told about the database. */
  get storage(): (string | null)[] {
    return this.messages.flatMap((m) => (m.type === "storage" ? [m.error] : []));
  }
  /** The states of a thread, in the order the screen got them. */
  states(threadId: string): Thread["status"][] {
    return this.messages.flatMap((m) =>
      m.type === "thread" && m.thread.id === threadId ? [m.thread.status] : [],
    );
  }
}

function setup(seed?: (store: Store, dir: string) => void, ownProject = true) {
  const dir = tmp();
  mkdirSync(path.join(dir, ".home"));
  const file = path.join(dir, "state.sqlite");
  const store = new Store(file);
  seed?.(store, dir);
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(dir, ".worktrees"),
    homeDir: path.join(dir, ".home"),
    storageRetryMs: 40,
  });
  const screen = new Screen();
  hub.connect(screen);
  const projectId = ownProject ? hub.createProject("demo", dir) : "";
  cleanups.push(async () => {
    await hub.close();
    store.close();
  });
  return { dir, file, store, hub, screen, projectId };
}

/** What nothing caught while `work` ran: what `server.ts` takes for a crash, and stops on. */
async function escaped(work: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const note = (error: unknown) => seen.push(error instanceof Error ? error.message : `${error}`);
  process.on("unhandledRejection", note);
  process.on("uncaughtException", note);
  try {
    await work();
    // A rejection nobody handles is reported a turn of the loop later.
    await sleep(50);
  } finally {
    process.off("unhandledRejection", note);
    process.off("uncaughtException", note);
  }
  return seen;
}

/** What node:sqlite really throws on a full disk: here, a database that may not grow any more. */
function diskFull(): Error {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (x TEXT); PRAGMA max_page_count = 2");
    db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(1_000_000));
  } catch (error) {
    return error as Error;
  } finally {
    db.close();
  }
  throw new Error("La base de test a accepté l'écriture.");
}

/** Another program holding the database: its writes are refused until `release`. */
function hold(file: string): () => void {
  const other = new DatabaseSync(file);
  other.exec("PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE");
  return () => {
    other.exec("ROLLBACK");
    other.close();
  };
}

/**
 * An ACP agent of our own. Its first argument says how it leaves the protocol; the last
 * « TOUR:<name> » of a message says what its turn does (a new agent gets the thread's history
 * first). It notes its process in the file given as second argument.
 */
function strayAgent(dir: string): string {
  const file = path.join(dir, "stray-agent.mjs");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [, , mode, pids] = process.argv;
if (pids) appendFileSync(pids, process.pid + "\\n");
const out = (message) =>
  new Promise((done) => {
    const line = JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n";
    if (process.stdout.write(line)) done();
    else process.stdout.once("drain", done);
  });
const say = (text) =>
  out({
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const model = (current, choices) => ({
  id: "model",
  name: "Modèle",
  category: "model",
  type: "select",
  currentValue: current,
  options: choices ?? [
    { value: "m1", name: "M1" },
    { value: "m2", name: "M2" },
  ],
});
const update = (update) => out({ method: "session/update", params: { sessionId: "s1", update } });
// What the agent asked the app, waiting for its answer.
const asked = new Map();
let asks = 1000;
const ask = (method, params) =>
  new Promise((answer) => {
    const id = ++asks;
    asked.set(id, answer);
    void out({ id, method, params });
  });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (!method && asked.has(id)) {
    asked.get(id)(result);
    asked.delete(id);
    return;
  }
  if (method === "initialize") {
    await out({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === "session/new") {
    // Out of the protocol at the start: a number, and choices that are texts, among sound ones.
    const effort = { id: "effort", name: "Effort", category: "thought_level", type: "select" };
    const ask = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask" };
    const configOptions =
      mode === "mauvais-depart"
        ? [
            12,
            { ...effort, currentValue: "high", options: ["low", "high"] },
            { ...ask, options: [{ value: "ask", name: "Demander" }] },
            model("m1"),
          ]
        : mode === "categorie-objet"
          ? [
              {
                id: "drole",
                name: "Drôle",
                category: { toString: 1, valueOf: 1 },
                type: "select",
                currentValue: "a",
                options: [{ value: "a", name: "A" }],
              },
              model("m1"),
            ]
          : [model("m1")];
    // Out of the protocol: an id that is not a text.
    await out({ id, result: { sessionId: mode === "id-bizarre" ? true : "s1", configOptions } });
  } else if (method === "session/set_config_option") {
    // Out of the protocol: the choices are texts where records are expected.
    const answer = mode === "mauvais-changement" ? model(params.value, ["m1", "m2"]) : model(params.value);
    // Out of the protocol: a record, or a number, where the list of options is expected.
    if (mode === "options-objet") await out({ id, result: { configOptions: {} } });
    else if (mode === "options-nombre") await out({ id, result: { configOptions: 42 } });
    else await out({ id, result: { configOptions: [answer] } });
  } else if (method === "session/prompt") {
    const text = params.prompt.map((block) => block.text ?? "").join("\\n");
    const turn = [...text.matchAll(/TOUR:(\\S+)/g)].at(-1)?.[1];
    if (turn === "ligne-34mo") {
      // One line over the 32 MiB the ACP connection accepts.
      await say("x".repeat(34 * 1024 * 1024));
      await sleep(300);
    } else if (turn === "lent") {
      for (let word = 1; word <= 30; word++) {
        await say("mot" + word + " ");
        await sleep(150);
      }
    } else if (turn === "alpha-beta-gamma") {
      // Text, a tool between two of its pieces, then text again.
      await say("ALPHA ");
      await sleep(250);
      await say("BETA ");
      await sleep(250);
      await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Lecture", kind: "read", status: "in_progress" });
      await sleep(250);
      await say("GAMMA");
      await sleep(250);
    } else if (turn === "permission") {
      await say("Je demande. ");
      const answer = await ask("session/request_permission", {
        sessionId: "s1",
        toolCall: { toolCallId: "t2", title: "Écrire", kind: "edit", status: "pending" },
        options: [{ optionId: "oui", name: "Oui", kind: "allow_once" }],
      });
      await say("Réponse : " + (answer?.outcome?.optionId ?? "aucune") + ".");
    } else if (turn === "outil-puis-suite") {
      await update({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Vérif", kind: "read", status: "in_progress" });
      await sleep(100);
      await say("Debut ");
      await sleep(100);
      await update({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed" });
      await sleep(100);
      await say("suite");
      await sleep(100);
    } else if (turn === "echo-contexte") {
      await say(text.includes("MEMOIRE_SECRETE") && text.includes("Bonjour.") ? "VU_MEMOIRE_ET_HISTORIQUE" : "OUBLIE");
    } else if (turn === "repos-34mo") {
      await say("Bonjour.");
      await out({ id, result: { stopReason: "end_turn" } });
      // At rest, the turn over: one line over the 32 MiB the connection accepts.
      await sleep(200);
      await say("x".repeat(34 * 1024 * 1024));
      return;
    } else {
      await say("Bonjour.");
    }
    await out({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined && method) {
    await out({ id, error: { code: -32601, message: "inconnu" } });
  }
});
`,
  );
  return file;
}

const agentText = (items: Item[]) =>
  items.flatMap((item) => (item.kind === "agent" ? [item.text] : [])).join("");

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a write the database refuses", () => {
  it("waits for another program that holds the database for a moment", async () => {
    const dir = tmp();
    const file = path.join(dir, "state.sqlite");
    const store = new Store(file);
    cleanups.push(() => store.close());
    // As a copy or a look with an SQLite tool does: the write lock, for half a second.
    const other = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("BEGIN IMMEDIATE");
         console.log("tenu");
         setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 500);`,
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    cleanups.push(() => other.kill());
    await new Promise<void>((held, failed) => {
      other.stdout.once("data", () => held());
      other.once("exit", () => failed(new Error("L'autre programme n'a pas pris la base.")));
    });

    const started = Date.now();
    store.setSetting("note", "écrite");

    expect(Date.now() - started).toBeGreaterThan(100);
    expect(store.getSetting("note", "")).toBe("écrite");
  });

  it("names a full disk and a database held by another program, and nothing else", () => {
    const dir = tmp();
    const file = path.join(dir, "state.sqlite");
    const store = new Store(file);
    cleanups.push(() => store.close());

    expect(storageTrouble(diskFull())).toBe("Disque plein");

    store.waitOnHold(false);
    const release = hold(file);
    let refused: unknown;
    try {
      store.setSetting("note", "refusée");
    } catch (error) {
      refused = error;
    }
    release();
    expect(storageTrouble(refused)).toBe("Base verrouillée par un autre programme");

    // A mistake of ours is not the disk's: it stays an error like any other.
    let mistake: unknown;
    try {
      store.db.exec("SELECT rien FROM nulle_part");
    } catch (error) {
      mistake = error;
    }
    expect(mistake).toBeInstanceOf(Error);
    expect(storageTrouble(mistake)).toBeUndefined();
    expect(storageTrouble(new Error("database or disk is full"))).toBeUndefined();
  });

  it("names a database file that cannot be opened as a write that is impossible", () => {
    let failure: unknown;
    try {
      new DatabaseSync(path.join(tmp(), "absent", "state.sqlite"));
    } catch (error) {
      failure = error;
    }
    expect(storageTrouble(failure)).toBe("Écriture impossible sur le disque");
  });

  it("waits for another program that holds a database not yet in WAL mode, as it opens", async () => {
    const dir = tmp();
    const file = path.join(dir, "state.sqlite");
    const before = new DatabaseSync(file);
    before.exec("PRAGMA journal_mode = DELETE; CREATE TABLE autre (x)");
    before.close();
    const other = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("BEGIN IMMEDIATE");
         console.log("tenu");
         setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 500);`,
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    cleanups.push(() => other.kill());
    await new Promise<void>((held, failed) => {
      other.stdout.once("data", () => held());
      other.once("exit", () => failed(new Error("L'autre programme n'a pas pris la base.")));
    });

    const store = new Store(file);
    cleanups.push(() => store.close());

    expect(store.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  it("answers, then stops its agent, when the database refuses to note the agent works", async () => {
    const { dir, store, hub, projectId } = setup();
    const pids = path.join(dir, "pids.txt");
    writeFileSync(pids, "");
    const agentId = hub.addCustomAgent({
      name: "Vérifié",
      command: process.execPath,
      args: [strayAgent(dir), "", pids],
    });
    const write = store.setSetting.bind(store);
    store.setSetting = (key, value) => {
      if (key === "agentChecks") throw diskFull();
      write(key, value);
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let threadId = "";
    const seen = await escaped(async () => {
      threadId = hub.createThread({ projectId, agentId, permissionMode: "full", text: "bonjour" });
      await hub.whenIdle(threadId);
    });

    expect(seen).toEqual([]);
    // Only a note of the check: the turn goes on without it.
    expect(store.getThread(threadId)?.status).toBe("idle");
    expect(agentText(store.listItems(threadId))).toBe("Bonjour.");
    await hub.close();
    const started = (await import("node:fs"))
      .readFileSync(pids, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(started.length).toBeGreaterThan(0);
    for (const pid of started.map(Number)) {
      await expect.poll(() => isRunning(pid), { timeout: 10_000 }).toBe(false);
    }
  }, 20_000);

  it("reports what stopped a transaction, not the rollback that had nothing left to undo", () => {
    const dir = tmp();
    const store = new Store(path.join(dir, "state.sqlite"));
    cleanups.push(() => store.close());
    // A real full disk, as SQLite sees one: the file may not grow by a single page.
    const { page_count: pages } = store.db.prepare("PRAGMA page_count").get() as {
      page_count: number;
    };
    store.db.exec(`PRAGMA max_page_count = ${pages}`);

    let failure: unknown;
    try {
      store.transaction(() => store.setSetting("gros", "x".repeat(4_000_000)));
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toMatch(/database or disk is full/);
    expect(storageTrouble(failure)).toBe("Disque plein");
  });

  it("ends the turn on the screens, tells them, and writes its end once writes pass again", async () => {
    const { store, hub, screen, projectId } = setup();
    const write = store.updateThread.bind(store);
    let full = false;
    let threadId = "";

    const seen = await escaped(async () => {
      threadId = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        text: "bonjour",
      });
      // The disk fills up during the turn: the thread's new state cannot be written.
      full = true;
      store.updateThread = (id, patch) => {
        if (full && id === threadId && patch.status) throw diskFull();
        return write(id, patch);
      };
      await expect.poll(() => hub.runningTurnCount, { timeout: 10_000 }).toBe(0);
    });

    expect(seen).toEqual([]);
    expect(screen.storage).toEqual(["Disque plein : plus rien n'est enregistré"]);
    // The database still says « running »: the screens are told the turn ended all the same.
    expect(store.getThread(threadId)?.status).toBe("running");
    expect(screen.states(threadId).at(-1)).toBe("idle");
    const late = hub.snapshot();
    expect(late.storageError).toBe("Disque plein : plus rien n'est enregistré");
    expect(late.threads.find((t) => t.id === threadId)?.status).toBe("idle");

    full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    expect(store.getThread(threadId)?.status).toBe("idle");
    expect(hub.snapshot().storageError).toBeUndefined();
  });

  it("keeps an agent's text the database refused, and writes it once writes pass again", async () => {
    const { store, hub, screen, projectId } = setup();
    const write = store.putItem.bind(store);
    let full = true;
    // The first words are written; the rest of the answer finds the disk full.
    store.putItem = (threadId, item) => {
      if (full && item.kind === "agent" && item.text.length > 20) throw diskFull();
      return write(threadId, item);
    };
    let threadId = "";

    const seen = await escaped(async () => {
      threadId = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        text: "/flux",
      });
      await hub.whenIdle(threadId);
    });

    expect(seen).toEqual([]);
    expect(screen.storage).toEqual(["Disque plein : plus rien n'est enregistré"]);
    expect(agentText(store.listItems(threadId)).length).toBeLessThanOrEqual(20);

    full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    const kept = agentText(store.listItems(threadId));
    expect(kept).toContain("## Partie 1");
    expect(kept).toContain("## Partie 12");
  });

  it("answers what a screen asked with what happened, in the user's words", async () => {
    const { store, hub, screen, projectId } = setup();
    const write = store.setSetting.bind(store);
    store.setSetting = (key, value) => {
      if (key === "pinnedProjects") throw diskFull();
      return write(key, value);
    };

    await expect(
      hub.handle(screen, { type: "project.setPinned", projectId, pinned: true }),
    ).rejects.toThrow("Disque plein : rien n'a été enregistré.");
    expect(screen.storage).toEqual(["Disque plein : plus rien n'est enregistré"]);
  });
});

/** A real `server.ts` on a data folder, and one screen connected to it. */
async function realServer(dataDir: string) {
  const child: ChildProcess = spawn(
    process.execPath,
    [SERVER, "--demo", "--data-dir", dataDir, "--port", "0", "--host", "127.0.0.1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  cleanups.push(() => child.kill());
  let output = "";
  const address = await new Promise<RegExpMatchArray>((ready, failed) => {
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.match(/MoonAgentic est prêt : http:\/\/([^/]+)\/#token=(\S+)/);
      if (line) ready(line);
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", () => failed(new Error(`Le serveur n'a pas démarré :\n${output}`)));
  });
  const [, host, token] = address;
  const ticket = await fetch(`http://${host}/api/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).then((answer) => answer.json() as Promise<{ ticket: string }>);
  const socket = new WebSocket(`ws://${host}/ws?ticket=${ticket.ticket}`);
  cleanups.push(() => socket.terminate());
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((opened, failed) => {
    socket.once("open", () => opened());
    socket.once("error", failed);
  });
  let asked = 0;
  /** Sends what creates something, and gives the id it got. */
  const create = async (message: Record<string, unknown>): Promise<string> => {
    const requestId = `r${++asked}`;
    socket.send(JSON.stringify({ ...message, requestId }));
    let id: string | undefined;
    await expect
      .poll(
        () => {
          const answer = messages.find(
            (m) => (m.type === "created" || m.type === "error") && m.requestId === requestId,
          );
          if (answer?.type === "error") throw new Error(answer.message);
          return (id = answer?.type === "created" ? answer.id : undefined);
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();
    return id!;
  };
  return { child, messages, create, output: () => output };
}

describe("a real server whose database another program holds while an agent works", () => {
  it("stays up, says so, and loses neither the answer nor the end of the turn", async () => {
    const dataDir = tmp();
    const project = tmp();
    const { child, messages, create, output } = await realServer(dataDir);
    const projectId = await create({ type: "project.create", name: "Projet", path: project });
    const agentId = await create({
      type: "agent.addCustom",
      agent: { name: "Agent lent", command: process.execPath, args: [strayAgent(project), ""] },
    });
    const threadId = await create({
      type: "thread.create",
      projectId,
      agentId,
      permissionMode: "full",
      text: "TOUR:lent",
    });
    const storage = () => messages.flatMap((m) => (m.type === "storage" ? [m.error] : []));
    const states = () =>
      messages.flatMap((m) => (m.type === "thread" && m.thread.id === threadId ? [m.thread] : []));
    // The agent has started to answer: its text is being streamed and written.
    await expect
      .poll(() => messages.some((m) => m.type === "append" && m.threadId === threadId), {
        timeout: 15_000,
      })
      .toBe(true);

    const release = hold(path.join(dataDir, "state.sqlite"));
    try {
      await expect
        .poll(() => storage(), { timeout: 15_000 })
        .toEqual(["Base verrouillée par un autre programme : plus rien n'est enregistré"]);
      // The turn ends while the database is still held.
      await expect.poll(() => states().at(-1)?.status, { timeout: 15_000 }).toBe("idle");
    } finally {
      release();
    }
    await expect.poll(() => storage().at(-1), { timeout: 15_000 }).toBeNull();

    expect(child.exitCode).toBeNull();
    expect(output()).not.toMatch(/Erreur imprévue/);
    // What the database holds now: the whole answer, and a thread that is no longer at work.
    const saved = new DatabaseSync(path.join(dataDir, "state.sqlite"), { readOnly: true });
    const thread = saved.prepare("SELECT status, error FROM threads WHERE id = ?").get(threadId);
    const items = saved
      .prepare("SELECT data FROM items WHERE thread_id = ?")
      .all(threadId)
      .map((row) => JSON.parse(String(row.data)) as Item);
    saved.close();
    expect(thread).toEqual({ status: "idle", error: null });
    const words = agentText(items).trim().split(" ");
    expect(words).toEqual(Array.from({ length: 30 }, (_, n) => `mot${n + 1}`));
  }, 60_000);
});

describe("an agent that leaves the protocol", () => {
  const start = (mode: string) => {
    const dir = tmp();
    return AgentSession.start({
      launch: { command: process.execPath, args: [strayAgent(dir), mode] },
      cwd: dir,
      previousSessionId: null,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    }).then((session) => {
      cleanups.push(() => session.close());
      return session;
    });
  };

  it("refuses an answer to a change of model it cannot read, and keeps what it knew", async () => {
    const session = await start("mauvais-changement");
    expect(session.model?.current).toBe("m1");

    await expect(session.setModel("m2")).rejects.toThrow(/format inattendu/);

    // What the diagnostics timer reads every minute, outside any try.
    expect(session.model).toEqual({
      configId: "model",
      current: "m1",
      choices: [
        { id: "m1", name: "M1" },
        { id: "m2", name: "M2" },
      ],
    });
    expect(session.settings).toEqual([]);
  });

  it.each(["options-objet", "options-nombre"])(
    "refuses an answer to a change of model that is not a list (%s)",
    async (mode) => {
      const session = await start(mode);
      await expect(session.setModel("m2")).rejects.toThrow(/format inattendu/);
      expect(session.model?.current).toBe("m1");
    },
  );

  it("leaves out a setting whose kind is not a text, and keeps the others", async () => {
    let session: AgentSession | undefined;
    const seen = await escaped(async () => {
      session = await start("categorie-objet");
    });
    expect(seen).toEqual([]);
    expect(session?.model?.current).toBe("m1");
    expect(session?.settings).toEqual([]);
  });

  it("takes the settings it can read when a session opens, and leaves out the others", async () => {
    const session = await start("mauvais-depart");

    expect(session.model?.current).toBe("m1");
    expect(session.settings).toEqual([
      { id: "mode", kind: "mode", current: "ask", choices: [{ id: "ask", name: "Demander" }] },
    ]);
    // The agent itself is sound: a change it answers properly still passes.
    await session.setModel("m2");
    expect(session.model?.current).toBe("m2");
  });

  it("tells the screen that asked, and the thread's agent stays readable", async () => {
    const { dir, hub, screen, store, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Hors protocole",
      command: process.execPath,
      args: [strayAgent(dir), "mauvais-changement"],
    });
    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "full",
      text: "bonjour",
    });
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.status).toBe("idle");

    await expect(
      hub.handle(screen, { type: "thread.setModel", threadId, model: "m2" }),
    ).rejects.toThrow(/format inattendu/);

    expect(hub.diagnosticAgents()).toMatchObject([{ agentId, model: "m1", running: false }]);
    // And the agent is still the thread's: the next message gets its answer.
    hub.send(threadId, "encore");
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)).toMatchObject({ status: "idle" });
    expect(store.getThread(threadId)?.error).toBeUndefined();
  });

  it("drops a measure of the monitor that fails, instead of stopping the server on it", async () => {
    const dir = tmp();
    const said: string[] = [];
    let asked = 0;
    const seen = await escaped(async () => {
      const monitor = new DiagnosticsMonitor({
        dataDir: dir,
        logDir: dir,
        worktreesDir: dir,
        getAgents: () => {
          asked++;
          throw new TypeError("Cannot read properties of undefined (reading 'value')");
        },
        getRunningTurns: () => 1,
        getStartingAgents: () => 0,
        hasLockedProjects: () => false,
        sampleProcesses: async () => [],
        log: () => undefined,
        error: (line) => said.push(line),
        sampleIntervalMs: 20,
        lagCheckMs: 0,
      });
      cleanups.push(() => monitor.stop());
      await expect.poll(() => asked, { timeout: 5_000 }).toBeGreaterThan(1);
      monitor.stop();
    });

    expect(seen).toEqual([]);
    expect(said[0]).toMatch(/^\[perf\] mesure abandonnée : TypeError: Cannot read properties/);
  });

  it("starts a new agent after a line too long closed the connection of the first", async () => {
    const { dir, hub, store, projectId } = setup();
    const pids = path.join(dir, "pids.txt");
    writeFileSync(pids, "");
    const agentId = hub.addCustomAgent({
      name: "Bavard",
      command: process.execPath,
      args: [strayAgent(dir), "", pids],
    });
    const started = async () =>
      (await import("node:fs")).readFileSync(pids, "utf8").trim().split("\n").filter(Boolean);

    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "full",
      text: "TOUR:ligne-34mo",
    });
    await hub.whenIdle(threadId);
    // That turn is lost, and says so.
    const failed = store.getThread(threadId);
    expect(failed?.status).toBe("error");
    expect(failed?.error).toMatch(/^L'agent s'est arrêté avant la fin de sa réponse\./);

    hub.send(threadId, "TOUR:bonjour");
    await hub.whenIdle(threadId);

    const after = store.getThread(threadId);
    expect(after?.error).toBeUndefined();
    expect(after?.status).toBe("idle");
    expect(agentText(store.listItems(threadId))).toContain("Bonjour.");
    // Two agents were started, and the one whose connection closed does not stay behind.
    const [first, second] = (await started()).map(Number);
    expect(second).toBeDefined();
    await expect.poll(() => isRunning(first!), { timeout: 10_000 }).toBe(false);
  }, 40_000);
});

describe("saved values the server did not write itself", () => {
  const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
    id,
    projectId: "p1",
    title: id,
    agentId: "demo",
    status: "idle",
    permissionMode: "full",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it("leaves out a thread whose row is damaged, says it once, and still starts", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, hub } = setup((store, dir) => {
      store.addProject({ id: "p1", name: "projet", path: dir, createdAt: 1 });
      store.addThread(thread("sain", { status: "running" }));
      store.addThread(thread("abime", { pinned: true, status: "running" }));
      store.addThread(thread("liste", { pinned: true }));
      // A file cut short, an edit made by hand.
      store.db.prepare(`UPDATE threads SET extra = '{"pinned":tru' WHERE id = 'abime'`).run();
      store.db.prepare(`UPDATE threads SET extra = '[1, 2]' WHERE id = 'liste'`).run();
      // What every start does first.
      store.recoverAfterRestart();
    });
    await hub.recovered;

    expect(store.listThreads().map((t) => t.id)).toEqual(["sain"]);
    expect(store.getThread("sain")?.status).toBe("idle");
    expect(store.getThread("abime")).toBeUndefined();
    expect(hub.snapshot().threads.map((t) => t.id)).toEqual(["sain"]);
    // The row itself is left as it is, for whoever repairs the file.
    expect(store.db.prepare(`SELECT extra FROM threads WHERE id = 'abime'`).get()).toEqual({
      extra: '{"pinned":tru',
    });
    const about = said.mock.calls.map((call) => String(call[0]));
    expect(about.filter((line) => line.includes("le fil abime"))).toHaveLength(1);
    expect(about.filter((line) => line.includes("le fil liste"))).toHaveLength(1);
  });

  const custom = { id: "custom-garde", name: "Gardé", command: "garde", args: ["acp"] };
  const server = {
    id: "mcp-garde",
    name: "Gardé",
    enabled: true,
    transport: { type: "stdio", command: "garde", args: [], env: [] },
  };
  type Seen = ReturnType<Hub["snapshot"]>;
  const customKept = (seen: Seen) => expect(seen.agents.map((a) => a.id)).toContain("custom-garde");
  it.each<[string, unknown, (seen: Seen) => void]>([
    ["pendingRestores", null, customKept],
    ["pendingRestores", { t1: null, t2: { itemId: 4 } }, customKept],
    ["pinnedProjects", { p1: true }, customKept],
    ["lock.projects", { p1: true }, customKept],
    ["defaults", "texte", (seen) => expect(seen.defaults).toBeUndefined()],
    ["teamPresets", { a: 1 }, (seen) => expect(seen.teamPresets).toBeUndefined()],
    ["customAgents", { a: 1 }, (seen) => expect(seen.agents.map((a) => a.id)).toContain("demo")],
    // What is sound in the same value is kept.
    ["customAgents", [null, 42, {}, custom], customKept],
    ["favorites", [1, 2], (seen) => expect(seen.favorites).toEqual({})],
    [
      "favorites",
      { demo: null, autre: 42, "custom-garde": ["m1"] },
      (seen) => expect(seen.favorites).toEqual({ "custom-garde": ["m1"] }),
    ],
    [
      "favoriteOrder",
      [null, 42, { agentId: "custom-garde", model: "m1" }],
      (seen) => expect(seen.favoriteOrder).toEqual([{ agentId: "custom-garde", model: "m1" }]),
    ],
    [
      "mcpServers",
      [null, 42, {}, server],
      (seen) => expect(seen.mcpServers.map((m) => m.id)).toEqual(["mcp-garde"]),
    ],
    // Sound outside, damaged inside.
    [
      "mcpServers",
      [{ ...server, id: "mcp-abime", projectIds: 42 }, server],
      (seen) => expect(seen.mcpServers.map((m) => m.id)).toEqual(["mcp-garde"]),
    ],
    ["coordinator", { routes: null }, (seen) => expect(seen.coordinator).toEqual({ routes: {} })],
    [
      "coordinator",
      { routes: { default: 42, code: { agentId: "demo" } }, team: {}, parallel: "3" },
      (seen) => expect(seen.coordinator).toEqual({ routes: { code: { agentId: "demo" } } }),
    ],
    [
      "coordinator",
      {
        routes: {},
        team: {
          lead: { agentId: "demo" },
          coder: { agentId: "demo" },
          coders: 0,
          permissionMode: "bogus",
        },
        parallel: 99,
        maxTurns: 99,
      },
      (seen) => expect(seen.coordinator).toEqual({ routes: {} }),
    ],
    ["teamPresets", [null, {}], (seen) => expect(seen.teamPresets).toEqual([])],
  ])("starts and opens a screen with « %s » saved as %j", async (key, value, check) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen = await escaped(async () => {
      const { hub, screen, projectId } = setup((store, dir) => {
        store.addProject({ id: "p1", name: "projet", path: dir, createdAt: 1 });
        store.addThread(thread("t1"));
        store.setSetting("customAgents", [custom]);
        store.setSetting("favorites", { "custom-garde": ["m1"] });
        store.setSetting(key, value);
      });
      await hub.recovered;

      // What every screen gets as it connects.
      expect(screen.messages[0]?.type).toBe("snapshot");
      const snapshot = hub.snapshot();
      expect(snapshot.threads.map((t) => t.id)).toEqual(["t1"]);
      check(snapshot);
      // And the value can be written anew from the app.
      await hub.handle(screen, { type: "project.setPinned", projectId, pinned: true });
      // Reading the MCP servers' secrets ends on its own, after the start.
      await sleep(60);
    });
    expect(seen).toEqual([]);
  });

  it("leaves out the damaged entries of an agent's saved models", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen = await escaped(async () => {
      const { hub, store } = setup((store) => {
        store.db.prepare(`INSERT INTO agent_models (agent_id, data) VALUES ('demo', ?)`).run(
          JSON.stringify({
            models: [null, { id: "m1", name: "M1" }],
            current: "m1",
            settings: [null, 42],
            modelSettings: { m1: [{}], m2: "texte" },
          }),
        );
      });
      await hub.recovered;
      expect(store.getAgentModels("demo")).toEqual({
        models: [{ id: "m1", name: "M1" }],
        current: "m1",
        settings: [],
        modelSettings: { m1: [] },
      });
      expect(hub.snapshot().agents.map((a) => a.id)).toContain("demo");
    });
    expect(seen).toEqual([]);
  });

  it("leaves out an item of a thread that is not a sound item, and goes on with the thread", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let threadId = "";
    const seen = await escaped(async () => {
      const { hub, store, projectId } = setup();
      threadId = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        text: "un",
      });
      await hub.whenIdle(threadId);
      hub.send(threadId, "deux");
      await hub.whenIdle(threadId);
      const [first, second] = store.listItems(threadId);
      // An edit made by hand: SQLite takes them, as they are sound JSON.
      store.db.prepare(`UPDATE items SET data = 'null' WHERE id = ?`).run(first!.id);
      store.db.prepare(`UPDATE items SET data = '{"kind":"user"}' WHERE id = ?`).run(second!.id);

      expect(store.listItems(threadId).map((i) => i.id)).not.toContain(first!.id);
      expect(() => store.searchItems("deux")).not.toThrow();
      expect(() => store.searchProjectItems(projectId, "deux")).not.toThrow();
      expect(() => store.pageItems(threadId)).not.toThrow();
      hub.send(threadId, "trois");
      await hub.whenIdle(threadId);
      expect(store.getThread(threadId)?.status).toBe("idle");
    });
    expect(seen).toEqual([]);
  });

  it("searches a project whose threads include one with damaged state", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store } = setup((store, dir) => {
      store.addProject({ id: "p1", name: "projet", path: dir, createdAt: 1 });
      store.addThread(thread("abime", { pinned: true }));
      store.putItem("abime", { id: "i1", kind: "user", text: "cherche-moi", at: 1 });
      store.db.prepare(`UPDATE threads SET extra = '{"pinned":tru' WHERE id = 'abime'`).run();
    }, false);

    expect(() => store.searchProjectItems("p1", "cherche")).not.toThrow();
  });

  it("keeps every project locked when the list of locked projects cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, screen, store } = setup((store, dir) => {
      store.addProject({ id: "p1", name: "un", path: path.join(dir, "un"), createdAt: 1 });
      store.addProject({ id: "p2", name: "deux", path: path.join(dir, "deux"), createdAt: 2 });
      store.addThread(thread("t1"));
      store.addThread(thread("t2", { projectId: "p2" }));
      const locks = new ProjectLocks(store);
      locks.setPin("482913");
      locks.lock("p1");
      // The file is cut short in the middle of the list.
      store.db.prepare(`UPDATE settings SET value = '["p1"' WHERE key = 'lock.projects'`).run();
    }, false);
    await hub.recovered;

    // Opening p1 because its lock cannot be read would be the one thing not to do.
    const first = screen.messages[0];
    if (first?.type !== "snapshot") throw new Error("unreachable");
    expect(first.snapshot.threads).toEqual([]);
    expect(first.snapshot.projects.map((p) => [p.id, p.locked])).toEqual([
      ["p1", true],
      ["p2", true],
    ]);

    await hub.handle(screen, {
      type: "lock.unlock",
      requestId: "r1",
      projectId: "p2",
      pin: "482913",
    });
    expect(hub.snapshot().projects.map((p) => [p.id, !!p.locked])).toEqual([
      ["p1", true],
      ["p2", false],
    ]);
    expect(store.getSetting("lock.projects", [])).toEqual(["p1"]);
  });

  it("starts a real server on such a database, and gives a screen its snapshot", async () => {
    const dataDir = tmp();
    const project = tmp();
    const store = new Store(path.join(dataDir, "state.sqlite"));
    store.addProject({ id: "p1", name: "projet", path: project, createdAt: 1 });
    store.addThread(thread("sain"));
    store.addThread(thread("abime", { pinned: true }));
    store.db.prepare(`UPDATE threads SET extra = '{"pinned":tru' WHERE id = 'abime'`).run();
    store.setSetting("pendingRestores", null);
    store.setSetting("pinnedProjects", { p1: true });
    store.setSetting("customAgents", [null, custom]);
    store.setSetting("mcpServers", [42]);
    store.close();

    const { child, messages, output } = await realServer(dataDir);

    await expect.poll(() => messages[0]?.type, { timeout: 10_000 }).toBe("snapshot");
    const first = messages[0];
    if (first?.type !== "snapshot") throw new Error("unreachable");
    expect(first.snapshot.threads.map((t) => t.id)).toEqual(["sain"]);
    expect(first.snapshot.agents.map((a) => a.id)).toContain("custom-garde");
    expect(child.exitCode).toBeNull();
    expect(output()).toContain("le fil abime est illisible et laissé de côté");
    expect(output()).not.toMatch(/Erreur imprévue/);
  }, 40_000);
});

describe("Codex's app-server writing a line that is not a message", () => {
  it("skips it and still reads the answers", async () => {
    const script = path.join(tmp(), "codex.mjs");
    writeFileSync(
      script,
      `import readline from "node:readline";
const say = (line) => process.stdout.write(line + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    say("null");
    say(JSON.stringify({ id: m.id, result: {} }));
  } else if (m.id !== undefined) {
    say("42");
    say('"du texte"');
    say("null");
    say(JSON.stringify({ id: m.id, result: { account: { type: "chatgpt" } } }));
  }
});`,
    );

    let answers: Record<string, unknown> | undefined;
    const seen = await escaped(async () => {
      answers = await askCodex(
        { command: process.execPath, args: [script] },
        ["account/read"],
        5_000,
      );
    });

    expect(seen).toEqual([]);
    expect(answers).toEqual({ "account/read": { account: { type: "chatgpt" } } });
  });
});

describe("a write refused in the middle of a turn", () => {
  /** The database refuses every write of an agent's text while `full`, from the `after`-th on. */
  const refuseText = (store: Store, after = 0) => {
    const write = store.putItem.bind(store);
    const state = { full: true, written: 0 };
    store.putItem = (threadId, item) => {
      if (state.full && item.kind === "agent" && ++state.written > after) throw diskFull();
      return write(threadId, item);
    };
    return state;
  };
  /** The agent's text a screen reads in the thread now, written or still waiting to be. */
  const shown = async (hub: Hub, threadId: string) => {
    const reader = new Screen();
    await hub.handle(reader, { type: "thread.open", threadId });
    await hub.handle(reader, { type: "thread.leave", threadId });
    const timeline = reader.messages.find((m) => m.type === "items");
    return timeline?.type === "items" ? agentText(timeline.items) : "";
  };

  it("keeps an answer whose very first words the database refused", async () => {
    const { store, hub, screen, projectId } = setup();
    const disk = refuseText(store);
    let threadId = "";

    const seen = await escaped(async () => {
      threadId = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        text: "/flux",
      });
      await hub.whenIdle(threadId);
    });

    expect(seen).toEqual([]);
    // Said as soon as the first words were refused, not at the end of the turn.
    expect(screen.storage).toEqual(["Disque plein : plus rien n'est enregistré"]);
    expect(await shown(hub, threadId)).toContain("## Partie 12");
    expect(agentText(store.listItems(threadId))).toBe("");

    disk.full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    const kept = agentText(store.listItems(threadId));
    expect(kept).toContain("## Partie 1\n");
    expect(kept).toContain("## Partie 12");
  });

  it("loses no words when a tool comes between two pieces of text the database refused", async () => {
    const { dir, store, hub, screen, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Outil",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    // « ALPHA » is written; the disk is full for « BETA », the tool and « GAMMA ».
    const disk = refuseText(store, 1);

    const seen = await escaped(async () => {
      const threadId = hub.createThread({
        projectId,
        agentId,
        permissionMode: "full",
        text: "TOUR:alpha-beta-gamma",
      });
      await hub.whenIdle(threadId);
      disk.full = false;
      await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
      expect(agentText(store.listItems(threadId))).toBe("ALPHA BETA GAMMA");
      expect(store.listItems(threadId).some((i) => i.kind === "tool")).toBe(true);
    });
    expect(seen).toEqual([]);
  }, 20_000);

  it("gives the agent the user's answer to a permission the database refused to write", async () => {
    const { dir, store, hub, screen, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Demande",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "supervised",
      text: "TOUR:permission",
    });
    await expect.poll(() => store.getThread(threadId)?.status, { timeout: 10_000 }).toBe("waiting");
    const asked = store.listItems(threadId).find((i) => i.kind === "permission")!;
    const write = store.putItem.bind(store);
    const update = store.updateThread.bind(store);
    let full = true;
    store.putItem = (id, item) => {
      if (full) throw diskFull();
      return write(id, item);
    };
    store.updateThread = (id, patch) => {
      if (full) throw diskFull();
      return update(id, patch);
    };

    await hub.handle(screen, {
      type: "permission.respond",
      threadId,
      itemId: asked.id,
      optionId: "oui",
    });
    // The turn goes on and ends: it does not wait for ever on an answer that was lost.
    await expect.poll(() => hub.runningTurnCount, { timeout: 10_000 }).toBe(0);
    expect(await shown(hub, threadId)).toContain("Réponse : oui.");

    full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    expect(agentText(store.listItems(threadId))).toContain("Réponse : oui.");
    expect(store.listItems(threadId).find((i) => i.id === asked.id)).toMatchObject({
      outcome: "oui",
    });
    expect(store.getThread(threadId)?.status).toBe("idle");
  }, 20_000);

  it("brings a screen that opened during the outage up to date once writes pass again", async () => {
    const { store, hub, screen, projectId } = setup();
    const disk = refuseText(store, 1);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/flux",
    });
    await hub.whenIdle(threadId);

    // A phone opens the thread while the database still refuses the text.
    const late = new Screen();
    hub.connect(late);
    await hub.handle(late, { type: "thread.open", threadId });
    const opened = late.messages.find((m) => m.type === "items");
    if (opened?.type !== "items") throw new Error("Le fil ne s'est pas ouvert.");
    expect(agentText(opened.items)).toContain("## Partie 12");

    disk.full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    // It comes back with what it holds: it is sent what changed since.
    late.messages.length = 0;
    await hub.handle(late, {
      type: "thread.open",
      threadId,
      since: { epoch: opened.epoch, rev: opened.rev, first: opened.first },
    });
    const changes = late.messages.find((m) => m.type === "changes" || m.type === "items");
    const items = new Map(opened.items.map((item) => [item.id, item]));
    if (changes?.type === "changes") for (const { item } of changes.items) items.set(item.id, item);
    if (changes?.type === "items") for (const item of changes.items) items.set(item.id, item);
    expect(agentText([...items.values()])).toBe(agentText(store.listItems(threadId)));
    expect(agentText(store.listItems(threadId))).toContain("## Partie 12");
  });

  it("does not bring back what a step back took away during the outage", async () => {
    const { dir, store, hub, screen } = setup(undefined, false);
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(repo, "README.md"), "# Demo\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const projectId = hub.createProject("repo", repo);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const disk = refuseText(store);
    hub.send(threadId, "/flux");
    await hub.whenIdle(threadId);
    expect(screen.storage).toEqual(["Disque plein : plus rien n'est enregistré"]);

    const second = store.listItems(threadId).filter((i) => i.kind === "user")[1]!;
    await hub.restore(threadId, second.id);

    disk.full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    await sleep(200);
    expect(agentText(store.listItems(threadId))).not.toContain("## Partie");
    expect(store.listItems(threadId).some((i) => i.id === second.id)).toBe(false);
    expect(store.getThread(threadId)?.status).toBe("idle");
  }, 30_000);

  it("does not bring back the text of a thread deleted during the outage", async () => {
    const { store, hub, screen, projectId } = setup();
    const disk = refuseText(store, 1);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/flux",
    });
    await hub.whenIdle(threadId);
    await hub.handle(screen, { type: "thread.delete", requestId: "r1", threadId });

    disk.full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    expect(store.getThread(threadId)).toBeUndefined();
    expect(store.listItems(threadId)).toEqual([]);
  });

  it("stops quickly on a held database, whatever text waits to be written", async () => {
    const { dir, file, store, hub, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Lent",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    const threads = [1, 2, 3].map(() =>
      hub.createThread({ projectId, agentId, permissionMode: "full", text: "TOUR:lent" }),
    );
    await expect
      .poll(() => threads.every((id) => agentText(store.listItems(id)).length > 0), {
        timeout: 15_000,
      })
      .toBe(true);
    await sleep(100);

    const release = hold(file);
    cleanups.push(release);
    const started = Date.now();
    await hub.close();
    // One wait on the hold, not one per thread.
    expect(Date.now() - started).toBeLessThan(4_500);
  }, 30_000);

  it("opens an unread thread and finds what was written while the database is held", async () => {
    const { file, store, hub, screen, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "bonjour",
    });
    await hub.whenIdle(threadId);
    store.updateThread(threadId, { unread: true });

    const release = hold(file);
    cleanups.push(release);
    await hub.handle(screen, { type: "thread.open", threadId });
    const opened = screen.messages.find((m) => m.type === "items" && m.threadId === threadId);
    expect(opened).toBeDefined();
    // Searching reads the index there is, without writing to it first.
    expect(() => store.searchItems("bonjour")).not.toThrow();
    expect(() => store.searchProjectItems(projectId, "bonjour")).not.toThrow();
  });
});

describe("an agent at rest whose connection closed", () => {
  it("is replaced by a new one for the next message", async () => {
    const { dir, hub, store, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Bavard au repos",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "full",
      text: "TOUR:repos-34mo",
    });
    await hub.whenIdle(threadId);
    // Its line too long is read: the connection closes, its process lives a little longer.
    await sleep(1_500);

    hub.send(threadId, "TOUR:bonjour");
    await hub.whenIdle(threadId);

    const after = store.getThread(threadId);
    expect(after?.error).toBeUndefined();
    expect(after?.status).toBe("idle");
    expect(agentText(store.listItems(threadId))).toBe("Bonjour.Bonjour.");
  }, 30_000);

  it("gives the replacement agent the project memory and conversation history", async () => {
    const { dir, hub, store, projectId } = setup();
    store.setProjectMemory(projectId, "MEMOIRE_SECRETE");
    const agentId = hub.addCustomAgent({
      name: "Bavard au repos",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "full",
      text: "TOUR:repos-34mo",
    });
    await hub.whenIdle(threadId);
    await sleep(1_500);

    hub.send(threadId, "TOUR:echo-contexte");
    await hub.whenIdle(threadId);

    const after = store.getThread(threadId);
    expect(after?.error).toBeUndefined();
    expect(after?.status).toBe("idle");
    expect(agentText(store.listItems(threadId))).toBe("Bonjour.VU_MEMOIRE_ET_HISTORIQUE");
  }, 30_000);

  it("keeps timeline order and avoids splitting text when an earlier tool updates while storage is down", async () => {
    const { dir, store, hub, screen, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Outil maj",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    const write = store.putItem.bind(store);
    let full = false;
    store.putItem = (id, item) => {
      if (full && item.kind !== "user") throw diskFull();
      return write(id, item);
    };
    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "full",
      text: "TOUR:bonjour",
    });
    await hub.whenIdle(threadId);

    // A screen holds the thread at its state right before the outage, then disconnects.
    const watcher = new Screen();
    const disconnect = hub.connect(watcher);
    await hub.handle(watcher, { type: "thread.open", threadId });
    const before = watcher.messages.find((m) => m.type === "items");
    if (before?.type !== "items") throw new Error("Le fil ne s'est pas ouvert.");
    disconnect();

    // Outage starts before turn 2: tool starts, text begins, earlier tool finishes, text continues.
    full = true;
    hub.send(threadId, "TOUR:outil-puis-suite");
    await hub.whenIdle(threadId);

    // Reopening from before the outage must return the new tool before the new reply, unsplit.
    watcher.messages.length = 0;
    hub.connect(watcher);
    await hub.handle(watcher, {
      type: "thread.open",
      threadId,
      since: { epoch: before.epoch, rev: before.rev, first: before.first },
    });
    const delta = watcher.messages.find((m) => m.type === "changes");
    if (delta?.type !== "changes") throw new Error("Pas de rattrapage reçu.");
    expect(delta.items.map((c) => c.item.kind)).toEqual(["user", "tool", "agent"]);
    const deltaAgent = delta.items.find((c) => c.item.kind === "agent")?.item;
    expect(deltaAgent?.kind === "agent" ? deltaAgent.text : "").toBe("Debut suite");

    // Once storage recovers, SQLite keeps the exact same order and single reply bubble.
    full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    const turn2 = store.listItems(threadId).slice(2);
    expect(turn2.map((i) => i.kind)).toEqual(["user", "tool", "agent"]);
    expect(turn2[1]).toMatchObject({ kind: "tool", status: "completed" });
    expect(turn2[2]).toMatchObject({ kind: "agent", text: "Debut suite" });
  }, 20_000);

  it("does not split an already-persisted reply when an earlier persisted tool updates during an outage", async () => {
    const { dir, store, hub, screen, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Outil persiste",
      command: process.execPath,
      args: [strayAgent(dir), ""],
    });
    const write = store.putItem.bind(store);
    let full = false;
    store.putItem = (id, item) => {
      // Let the first tool_call and the first text chunk persist; refuse the later tool update and tail.
      if (full) throw diskFull();
      const seq = write(id, item);
      if (item.kind === "agent" && item.text === "Debut ") full = true;
      return seq;
    };
    const threadId = hub.createThread({
      projectId,
      agentId,
      permissionMode: "full",
      text: "TOUR:outil-puis-suite",
    });
    await hub.whenIdle(threadId);

    full = false;
    await expect.poll(() => screen.storage.at(-1), { timeout: 5_000 }).toBeNull();
    const items = store.listItems(threadId);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "agent"]);
    expect(items[1]).toMatchObject({ kind: "tool", status: "completed" });
    expect(items[2]).toMatchObject({ kind: "agent", text: "Debut suite" });
  }, 20_000);

  it("ends the turn in words when the agent opens a session with an id that is not a text", async () => {
    const { dir, hub, store, projectId } = setup();
    const agentId = hub.addCustomAgent({
      name: "Identifiant",
      command: process.execPath,
      args: [strayAgent(dir), "id-bizarre"],
    });
    let threadId = "";
    const seen = await escaped(async () => {
      threadId = hub.createThread({ projectId, agentId, permissionMode: "full", text: "bonjour" });
      await hub.whenIdle(threadId);
    });

    expect(seen).toEqual([]);
    expect(store.getThread(threadId)?.status).toBe("error");
    expect(store.getThread(threadId)?.error).toMatch(/sans identifiant lisible/);
  }, 20_000);
});
