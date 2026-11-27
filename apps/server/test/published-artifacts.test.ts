// Artifacts an agent publishes with `publish_artifact`: kept apart from any repository,
// version by version, shown as a card in the thread, listed, and served with what sits
// beside the file they came from, from any thread, a conversation outside any project too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_ARTIFACT_VERSIONS, type ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { ARTIFACT_HINT, type Client, Hub } from "../src/hub.ts";
import { createHttpServer } from "../src/http.ts";
import {
  fileSlug,
  MAX_ARTIFACTS_PER_THREAD,
  PublishedArtifacts,
} from "../src/published-artifacts.ts";
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
    // A version no longer kept gives the latest.
    expect((await kept.versionFile("fil-1", id, 1))?.version.n).toBe(MAX_ARTIFACT_VERSIONS + 2);
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
    // Gone with its thread, once its deletion is answered.
    await hub.deleteThread(threadId);
    expect(existsSync(path.join(root, "artifacts", threadId))).toBe(false);
  }, 40_000);

  it("publishes a file of the thread's folder, with what it loads beside it", async () => {
    const { root, store, hub, origin, reply, say, lastReply } = await setup();
    const repo = path.join(root, "projet");
    mkdirSync(path.join(repo, "maquettes"), { recursive: true });
    writeFileSync(
      path.join(repo, "maquettes/accueil.html"),
      '<link rel="stylesheet" href="a.css"><script src="app.js"></script>',
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

/** A folder made a git repository, its files committed but for those `.gitignore` names. */
function gitRepo(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

// Neon's review of PR #195: each point proven here.
describe("what a published artifact serves beside it", () => {
  const publish = async (
    ctx: Awaited<ReturnType<typeof setup>>,
    projectId: string,
    file: string,
  ) => {
    const threadId = ctx.hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: `/publie Artefact = ${file}`,
    });
    await ctx.hub.whenIdle(threadId);
    const { artifact_id } = JSON.parse(ctx.lastReply(threadId)) as { artifact_id: string };
    const link = await ctx.reply(
      { type: "artifacts.open", requestId: "o", threadId, path: "x", artifactId: artifact_id },
      "artifactLink",
    );
    const at = (name: string) => ctx.origin + link.url.replace(/[^/]+$/, name);
    return {
      threadId,
      artifact_id,
      at,
      status: async (name: string) => (await fetch(at(name))).status,
    };
  };

  it("serves nothing beside an image or a PDF", async () => {
    const ctx = await setup();
    const folder = path.join(ctx.root, "images");
    mkdirSync(folder);
    writeFileSync(path.join(folder, "photo.png"), "png");
    writeFileSync(path.join(folder, "autre.png"), "png");
    writeFileSync(path.join(folder, "rapport.pdf"), "%PDF");
    const projectId = ctx.hub.createProject("images", folder);
    const { status } = await publish(ctx, projectId, "photo.png");
    expect(await status("photo.png")).toBe(200);
    expect(await status("autre.png")).toBe(404);
    expect(await status("rapport.pdf")).toBe(404);
  }, 40_000);

  it("serves nothing beside a page from a folder agents share between projects", async () => {
    const ctx = await setup();
    const shared = path.join(ctx.root, ".codex", "generated_images");
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, "page.html"), '<img src="autre.png">');
    writeFileSync(path.join(shared, "autre.png"), "png d'un autre projet");
    const folder = path.join(ctx.root, "projet");
    mkdirSync(folder);
    const projectId = ctx.hub.createProject("projet", folder);
    const { status } = await publish(ctx, projectId, path.join(shared, "page.html"));
    expect(await status("page.html")).toBe(200);
    expect(await status("autre.png")).toBe(404);
  }, 40_000);

  it("serves only what the page names, never a file git ignores, as it was when published", async () => {
    const ctx = await setup();
    const repo = path.join(ctx.root, "depot");
    gitRepo(repo, {
      ".gitignore": "config.local.js\ndist/\n",
      "index.html":
        '<link rel="stylesheet" href="css/a.css"><script type="module" src="app.mjs"></script>' +
        '<script src="config.local.js"></script><img src="./img/logo.png"><img src="../dehors.png">',
      "css/a.css": "@import url('b.css'); body { background: url(\"../img/fond.png\") }",
      "css/b.css": "p { color: red }",
      "app.mjs": 'import { x } from "./lib.mjs"; import("./plus.mjs");',
      "lib.mjs": "export const x = 1;",
      "plus.mjs": "export default 2;",
      "img/logo.png": "png",
      "img/fond.png": "png",
      "autre.js": "pas nommé",
    });
    writeFileSync(path.join(repo, "config.local.js"), "const SECRET = 1;");
    mkdirSync(path.join(repo, "dist"));
    writeFileSync(path.join(repo, "dist/bundle.js"), "ignoré");
    writeFileSync(path.join(ctx.root, "dehors.png"), "png");
    const projectId = ctx.hub.createProject("depot", repo);
    const { status, at } = await publish(ctx, projectId, "index.html");
    for (const name of [
      "index.html",
      "css/a.css",
      "css/b.css",
      "img/logo.png",
      "img/fond.png",
      "app.mjs",
      "lib.mjs",
      "plus.mjs",
    ]) {
      expect(await status(name), name).toBe(200);
    }
    for (const name of [
      "config.local.js",
      "dist/bundle.js",
      "autre.js",
      "README.md",
      ".gitignore",
    ]) {
      expect(await status(name), name).toBe(404);
    }
    // Kept with its version: what the agent changes or removes afterwards changes nothing.
    writeFileSync(path.join(repo, "css/b.css"), "p { color: blue }");
    rmSync(path.join(repo, "img/logo.png"));
    expect(await (await fetch(at("css/b.css"))).text()).toBe("p { color: red }");
    expect(await status("img/logo.png")).toBe(200);
  }, 40_000);

  it("lets a page in a sandbox load its own modules and fonts", async () => {
    const ctx = await setup();
    const discussions = ctx.hub.discussionsProject();
    const threadId = ctx.hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "/publie Page",
    });
    await ctx.hub.whenIdle(threadId);
    const { artifact_id } = JSON.parse(ctx.lastReply(threadId)) as { artifact_id: string };
    const link = await ctx.reply(
      { type: "artifacts.open", requestId: "o", threadId, path: "x", artifactId: artifact_id },
      "artifactLink",
    );
    // Asked from an opaque origin, as a module or a font is, in CORS mode.
    const page = await fetch(ctx.origin + link.url, { headers: { origin: "null" } });
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
  }, 40_000);

  it("shows the latest version when the one a card made is no longer kept", async () => {
    const ctx = await setup();
    const discussions = ctx.hub.discussionsProject();
    const threadId = ctx.hub.createThread({
      projectId: discussions,
      agentId: "demo",
      permissionMode: "full",
      text: "/publie Page",
    });
    await ctx.hub.whenIdle(threadId);
    const { artifact_id } = JSON.parse(ctx.lastReply(threadId)) as { artifact_id: string };
    for (let i = 0; i < MAX_ARTIFACT_VERSIONS; i++) {
      await ctx.say(threadId, `/publie Page # ${artifact_id}`);
    }
    const link = await ctx.reply(
      {
        type: "artifacts.open",
        requestId: "o",
        threadId,
        path: "x",
        artifactId: artifact_id,
        version: 1,
      },
      "artifactLink",
    );
    expect(link.version).toBe(MAX_ARTIFACT_VERSIONS + 1);
    expect(link.versions).toHaveLength(MAX_ARTIFACT_VERSIONS);
  }, 90_000);

  it("keeps a thread's artifacts to a limit", async () => {
    const kept = new PublishedArtifacts(temp("limite"));
    const one = (i: number) =>
      kept.publish({
        threadId: "fil",
        title: `n${i}`,
        kind: "html",
        ext: ".html",
        name: "p.html",
        bytes: Buffer.from("<p>"),
      });
    for (let i = 0; i < MAX_ARTIFACTS_PER_THREAD; i++) await one(i);
    await expect(one(MAX_ARTIFACTS_PER_THREAD)).rejects.toThrow("artifact_id");
    // A new version of one of them is still taken.
    const [first] = await kept.list("fil");
    await expect(
      kept.publish({
        threadId: "fil",
        id: first!.id,
        title: "n",
        kind: "html",
        ext: ".html",
        name: "p.html",
        bytes: Buffer.from("<p>"),
      }),
    ).resolves.toBeTruthy();
  });
});
