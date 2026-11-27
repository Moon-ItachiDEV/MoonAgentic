// Artifacts an agent publishes with `publish_artifact`: kept apart from any repository,
// version by version, shown as a card in the thread, listed, and served with what sits
// beside the file they came from, from any thread, a conversation outside any project too.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_ARTIFACT_VERSIONS, type ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { ARTIFACT_HINT, type Client, Hub } from "../src/hub.ts";
import { createHttpServer } from "../src/http.ts";
import { fileSlug, PublishedArtifacts } from "../src/published-artifacts.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const temp = (name: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `moonagentic-${name}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
};

describe("published artifacts, kept on their own", () => {
  it("keeps each version as it was published, the oldest dropped past the limit", async () => {
    const dir = temp("published");
    const kept = new PublishedArtifacts(dir);
    const first = await kept.publish({
      threadId: "fil-1",
      title: "Maquette",
      kind: "html",
      ext: ".html",
      name: "maquette.html",
      bytes: Buffer.from("<p>un</p>"),
      now: 1000,
    });
    expect(first.version.n).toBe(1);
    const id = first.artifact.id;
    const second = await kept.publish({
      threadId: "fil-1",
      id,
      title: "Maquette",
      kind: "html",
      ext: ".html",
      name: "maquette.html",
      bytes: Buffer.from("<p>deux</p>"),
      now: 2000,
    });
    expect(second.version.n).toBe(2);
    const v1 = await kept.versionFile("fil-1", id, 1);
    const v2 = await kept.versionFile("fil-1", id);
    expect(readFileSync(v1!.file, "utf8")).toBe("<p>un</p>");
    expect(readFileSync(v2!.file, "utf8")).toBe("<p>deux</p>");
    expect(v2!.version.n).toBe(2);

    // Another kind, an id never given, another thread's id: refused.
    const again = { threadId: "fil-1", title: "x", ext: ".png", name: "x.png" };
    await expect(
      kept.publish({ ...again, id, kind: "image", bytes: Buffer.from("png") }),
    ).rejects.toThrow("même type");
    await expect(
      kept.publish({ ...again, id: "inconnu", kind: "image", bytes: Buffer.from("png") }),
    ).rejects.toThrow("n'existe pas");
    expect(await kept.versionFile("fil-2", id)).toBeUndefined();
    expect(await kept.versionFile("fil-1", "../fil-2")).toBeUndefined();
    await expect(kept.list("../..")).resolves.toEqual([]);

    // Two at once both keep their version.
    await Promise.all(
      Array.from({ length: MAX_ARTIFACT_VERSIONS }, (_, i) =>
        kept.publish({
          threadId: "fil-1",
          id,
          title: "Maquette",
          kind: "html",
          ext: ".html",
          name: "maquette.html",
          bytes: Buffer.from(`<p>${i}</p>`),
        }),
      ),
    );
    const [only] = await kept.list("fil-1");
    expect(only!.versions).toHaveLength(MAX_ARTIFACT_VERSIONS);
    expect(only!.versions[0]!.n).toBe(3);
    expect(only!.versions.at(-1)!.n).toBe(MAX_ARTIFACT_VERSIONS + 2);
    expect(await kept.versionFile("fil-1", id, 1)).toBeUndefined();
    expect(existsSync(path.join(dir, "fil-1", id, "1.html"))).toBe(false);

    await kept.forget("fil-1");
    expect(await kept.list("fil-1")).toEqual([]);
    expect(existsSync(path.join(dir, "fil-1"))).toBe(false);
  });

  it("names a page's file after its title", () => {
    expect(fileSlug("Maquette de l'accueil — v2")).toBe("maquette-de-l-accueil-v2");
    expect(fileSlug("¿¡!")).toBe("artefact");
    expect(fileSlug("a".repeat(80))).toHaveLength(60);
  });
});

async function setup() {
  const root = temp("publish");
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
    prWatchMs: 0,
    homeDir: root,
  });
  const server = createHttpServer({ hub, token: "app-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.unshift(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await hub.close();
    store.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sent: ServerMessage[] = [];
  const client: Client = { send: (m) => void sent.push(m) };
  const reply = async <T extends ServerMessage["type"]>(
    message: Parameters<Hub["handle"]>[1],
    type: T,
  ) => {
    sent.length = 0;
    await hub.handle(client, message);
    const found = sent.find((m) => m.type === type);
    if (!found) throw new Error(`pas de réponse ${type} : ${JSON.stringify(sent)}`);
    return found as Extract<ServerMessage, { type: T }>;
  };
  const say = async (threadId: string, text: string) => {
    await hub.handle(client, { type: "thread.send", threadId, text });
    await hub.whenIdle(threadId);
  };
  const lastReply = (threadId: string) => {
    const items = store.listItems(threadId);
    const start = items.findLastIndex((i) => i.kind === "user");
    return items
      .slice(start + 1)
      .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
      .join("\n");
  };
  return { root, store, hub, origin, client, reply, say, lastReply };
}

describe("publish_artifact", () => {
  it("publishes from a conversation outside any project, as a card, version by version", async () => {
    const { root, store, hub, origin, reply, say, lastReply } = await setup();
    const discussions = hub.discussionsProject();
    const threadId = hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "/publie Maquette de l'accueil",
    });
    await hub.whenIdle(threadId);
    const answer = JSON.parse(lastReply(threadId)) as { artifact_id: string; version: number };
    expect(answer.version).toBe(1);
    // Its card in the thread, where it was published.
    const card = store.listItems(threadId).find((i) => i.kind === "artifact");
    expect(card).toMatchObject({
      kind: "artifact",
      artifactId: answer.artifact_id,
      title: "Maquette de l'accueil",
      artifactKind: "html",
      version: 1,
    });
    // Kept by MoonAgentic, not in the folder the conversation works in.
    expect(existsSync(path.join(root, "artifacts", threadId, answer.artifact_id))).toBe(true);

    await say(threadId, `/publie Maquette de l'accueil # ${answer.artifact_id}`);
    expect(JSON.parse(lastReply(threadId))).toMatchObject({ version: 2 });

    const listed = await reply({ type: "artifacts.list", requestId: "l" }, "artifacts");
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0]).toMatchObject({
      id: answer.artifact_id,
      title: "Maquette de l'accueil",
      path: "maquette-de-l-accueil.html",
      kind: "html",
      versions: [{ n: 1 }, { n: 2 }],
    });

    const open = (version?: number) =>
      reply(
        {
          type: "artifacts.open",
          requestId: "o",
          threadId,
          path: "maquette-de-l-accueil.html",
          artifactId: answer.artifact_id,
          ...(version ? { version } : {}),
        },
        "artifactLink",
      );
    const latest = await open();
    expect(latest.version).toBe(2);
    expect(latest.versions?.map((v) => v.n)).toEqual([1, 2]);
    expect(latest.url).toMatch(/\/maquette-de-l-accueil\.html$/);
    const page = await fetch(origin + latest.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts;/);
    expect(await page.text()).toContain("Version suivante");
    const first = await fetch(origin + (await open(1)).url);
    expect(await first.text()).toContain("Première version");
    // A page given as text has nothing beside it.
    expect((await fetch(origin + latest.url.replace(/[^/]+$/, "autre.css"))).status).toBe(404);
    await expect(open(9)).rejects.toThrow("n'existe plus");

    // Gone with its thread.
    await hub.deleteThread(threadId);
    await expect.poll(() => existsSync(path.join(root, "artifacts", threadId))).toBe(false);
  }, 40_000);

  it("publishes a file of the thread's folder, with what sits beside it", async () => {
    const { root, store, hub, origin, reply, say, lastReply } = await setup();
    const repo = path.join(root, "projet");
    mkdirSync(path.join(repo, "maquettes"), { recursive: true });
    writeFileSync(
      path.join(repo, "maquettes/accueil.html"),
      '<link rel="stylesheet" href="a.css">',
    );
    writeFileSync(path.join(repo, "maquettes/a.css"), "body { color: red }");
    writeFileSync(path.join(repo, "maquettes/app.js"), "console.log(1)");
    writeFileSync(path.join(repo, "maquettes/.env"), "SECRET=1");
    writeFileSync(path.join(repo, "notes.md"), "# notes");
    const elsewhere = temp("ailleurs");
    writeFileSync(path.join(elsewhere, "page.html"), "<p>dehors</p>");
    const projectId = hub.createProject("projet", repo);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/publie Accueil = maquettes/accueil.html",
    });
    await hub.whenIdle(threadId);
    const { artifact_id } = JSON.parse(lastReply(threadId)) as { artifact_id: string };
    // What the agent does to its file afterwards changes nothing of what it published.
    writeFileSync(path.join(repo, "maquettes/accueil.html"), "<p>changé</p>");
    const link = await reply(
      { type: "artifacts.open", requestId: "o", threadId, path: "x", artifactId: artifact_id },
      "artifactLink",
    );
    expect(link.url).toMatch(/\/accueil\.html$/);
    const at = (file: string) => origin + link.url.replace(/accueil\.html$/, file);
    expect(await (await fetch(at("accueil.html"))).text()).toContain("a.css");
    expect(await (await fetch(at("a.css"))).text()).toContain("color: red");
    const script = await fetch(at("app.js"));
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    for (const file of [".env", "notes.md", "..%2Fnotes.md", "%2E%2E/notes.md"]) {
      expect((await fetch(at(file))).status, file).toBe(404);
    }

    // Nothing outside the thread's folders, nor a file of another kind.
    for (const asked of [path.join(elsewhere, "page.html"), "notes.md", "maquettes/absente.html"]) {
      await say(threadId, `/publie Dehors = ${asked}`);
      expect(lastReply(threadId), asked).toContain("ne peut pas être publié");
    }
    expect(store.listItems(threadId).filter((i) => i.kind === "artifact")).toHaveLength(1);

    // Listed once, as published, and hidden with its project once locked.
    const listed = await reply({ type: "artifacts.list", requestId: "l" }, "artifacts");
    expect(listed.artifacts.map((a) => a.title)).toEqual(["Accueil"]);
    await hub.handle(
      { send: () => undefined },
      {
        type: "lock.setPin",
        requestId: "pin",
        pin: "123456",
      },
    );
    await hub.handle(
      { send: () => undefined },
      { type: "lock.project", requestId: "k", projectId },
    );
    expect(
      (await reply({ type: "artifacts.list", requestId: "l" }, "artifacts")).artifacts,
    ).toEqual([]);
    expect((await fetch(at("accueil.html"))).status).toBe(404);
  }, 40_000);

  it("tells a new agent how to show something, and lets the user turn off the libraries", async () => {
    const { hub, reply, client, say, lastReply } = await setup();
    const discussions = hub.discussionsProject();
    const threadId = hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "/consignes",
    });
    await hub.whenIdle(threadId);
    // Told once, as its agent starts.
    expect(lastReply(threadId)).toBe(ARTIFACT_HINT);
    await say(threadId, "/consignes");
    expect(lastReply(threadId)).toBe("Aucune consigne.");
    expect(hub.snapshot().artifactLibraries).toBe(true);
    const told: ServerMessage[] = [];
    const unsubscribe = hub.connect({ send: (m) => void told.push(m) });
    await hub.handle(client, { type: "artifacts.setLibraries", on: false });
    expect(hub.artifactLibraries()).toBe(false);
    expect(hub.snapshot().artifactLibraries).toBe(false);
    expect(told).toContainEqual({ type: "artifactLibraries", on: false });
    unsubscribe();
    await reply({ type: "artifacts.list", requestId: "l" }, "artifacts");
  }, 40_000);
});
