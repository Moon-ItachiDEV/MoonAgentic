// What used to stop the whole server, and every agent at work with it (audit of 2026-11-25:
// N2, N3, N12, N18, N21, N22): a write the database refuses, an agent that leaves the
// protocol, saved values the server did not write, a stray line from Codex.
import { type ChildProcess, spawn } from "node:child_process";
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
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
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
        : [model("m1")];
    await out({ id, result: { sessionId: "s1", configOptions } });
  } else if (method === "session/set_config_option") {
    // Out of the protocol: the choices are texts where records are expected.
    const answer = mode === "mauvais-changement" ? model(params.value, ["m1", "m2"]) : model(params.value);
    await out({ id, result: { configOptions: [answer] } });
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
