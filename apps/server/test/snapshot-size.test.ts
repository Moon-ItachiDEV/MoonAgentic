// Audit of 2026-11-25, N7: the state sent at each connection, a phone's return to the screen
// included, held each thread's copy of its agent's `/` commands: 10 MB for 3 000 threads.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packSnapshot,
  type ServerMessage,
  type Snapshot,
  type Thread,
  unpackSnapshot,
} from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const commands = (agent: string) =>
  Array.from({ length: 25 }, (_, i) => ({
    name: `${agent}-${i}`,
    description: `Ce que fait la commande ${i} : une description d'une ligne comme en donnent les agents`,
  }));

describe("the state sent at each connection (N7)", () => {
  it("sends each list of commands once, and gives every thread its own back", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-snapshot-"));
    const store = new Store(path.join(dir, "state.sqlite"));
    store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
    store.transaction(() => {
      for (let t = 0; t < 3000; t++) {
        const thread: Thread = {
          id: `fil-${t}`,
          projectId: "p",
          title: `Fil numéro ${t} sur un sujet ou un autre`,
          agentId: "demo",
          status: "idle",
          permissionMode: "full",
          // Two agents' lists, and a few threads that have none yet.
          ...(t % 100 === 0 ? {} : { commands: commands(t % 2 ? "claude" : "codex") }),
          ...(t < 2500 ? { archived: true } : {}),
          summary: "Le début de ce que l'agent a dit en dernier, pour les listes de fils.",
          createdAt: t,
          updatedAt: t,
        };
        store.addThread(thread);
      }
    });
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, "worktrees"),
      homeDir: dir,
      prWatchMs: 0,
    });
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await hub.recovered;
    const sent: ServerMessage[] = [];
    hub.connect({ send: (message) => void sent.push(message) })();
    const message = sent.find((m) => m.type === "snapshot");
    if (message?.type !== "snapshot") throw new Error("no snapshot");
    // 10 MB before, as the audit measured it.
    expect(JSON.stringify(message).length).toBeLessThan(2_000_000);
    expect(message.snapshot.commandLists).toHaveLength(2);
    // What the screen makes of it is the state itself.
    const whole = hub.snapshot();
    expect(unpackSnapshot(JSON.parse(JSON.stringify(message.snapshot))).threads).toEqual(
      JSON.parse(JSON.stringify(whole.threads)),
    );
  });

  it("keeps an empty list as it is, and gives no thread a list its place does not name", () => {
    const thread = (id: string, extra: Partial<Thread>) =>
      ({ id, projectId: "p", title: id, agentId: "demo", status: "idle", ...extra }) as Thread;
    const listed = [{ name: "compact", description: "Résume la conversation" }];
    const snapshot = {
      threads: [
        thread("vide", { commands: [] }),
        thread("liste", { commands: listed }),
        thread("rien", {}),
      ],
    } as unknown as Snapshot;
    // The agent said it has no command: not the same as a thread that has not heard yet.
    expect(unpackSnapshot(JSON.parse(JSON.stringify(packSnapshot(snapshot)))).threads).toEqual(
      snapshot.threads,
    );
    // Places a server of another version could send: none of them is read as a list.
    const odd = {
      threads: [
        thread("hors", { commandList: 5 }),
        thread("negatif", { commandList: -1 }),
        thread("demi", { commandList: 0.5 }),
        thread("texte", { commandList: 1 }),
      ],
      commandLists: [listed, "pas une liste"],
    } as unknown as Snapshot;
    for (const t of unpackSnapshot(odd).threads) {
      expect(t.commands, t.id).toBeUndefined();
      expect("commandList" in t, t.id).toBe(false);
    }
  });
});
