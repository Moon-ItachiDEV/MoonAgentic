// Audit of 2026-11-25, N7: the state sent at each connection, a phone's return to the screen
// included, held each thread's copy of its agent's `/` commands: 10 MB for 3 000 threads.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ServerMessage, type Thread, unpackSnapshot } from "@moonagentic/protocol";
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
});
