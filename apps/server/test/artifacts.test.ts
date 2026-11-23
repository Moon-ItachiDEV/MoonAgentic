// « Artefacts »: what of the threads' own branches is listed, and what an address serves.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@moonagentic/protocol";
import { Agents } from "../src/agents.ts";
import {
  ARTIFACT_LINK_TTL_MS,
  ArtifactLinks,
  artifactKind,
  artifactUrl,
  findArtifacts,
} from "../src/artifacts.ts";
import { createHttpServer } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function threadFolder() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-artefacts-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  writeFileSync(path.join(repo, "docs/ancien.html"), "<p>avant</p>\n");
  writeFileSync(path.join(repo, "docs/style.css"), "p { color: red }\n");
  writeFileSync(path.join(repo, ".gitignore"), "dist/\n.env\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const store = new Store(path.join(root, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(root, "worktrees"),
  });
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const projectId = hub.createProject("demo", repo);
  const threadId = hub.createThread({
    projectId,
    agentId: "demo",
    permissionMode: "full",
    isolated: true,
    text: "Fais une page",
  });
  await hub.whenIdle(threadId);
  const workspace = store.getThread(threadId)!.workspace!;
  return { root, repo, hub, store, projectId, threadId, dir: workspace.path };
}

/** Files an agent might leave: a page, an image, a PDF, and some that are not artifacts. */
function makeFiles(dir: string) {
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "docs/maquette.html"), '<link rel="stylesheet" href="style.css">');
  writeFileSync(path.join(dir, "docs/ancien.html"), "<p>après</p>\n");
  writeFileSync(path.join(dir, "capture.png"), PNG);
  writeFileSync(path.join(dir, "rapport.pdf"), "%PDF-1.4\n");
  writeFileSync(path.join(dir, "notes.md"), "# notes\n");
  writeFileSync(path.join(dir, "dist/bundle.html"), "<p>ignoré</p>");
  writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
}

describe("artifacts", { timeout: 40_000 }, () => {
  it("knows its kinds by extension", () => {
    expect(artifactKind("a/b.HTML")).toBe("html");
    expect(artifactKind("x.svg")).toBe("image");
    expect(artifactKind("x.webp")).toBe("image");
    expect(artifactKind("doc.pdf")).toBe("pdf");
    expect(artifactKind("notes.md")).toBeUndefined();
    expect(artifactKind("Makefile")).toBeUndefined();
  });

  it("lists the pages, images and PDFs changed in a thread's branch, ignored ones left out", async () => {
    const { store, dir, threadId, projectId } = await threadFolder();
    makeFiles(dir);
    // One committed in the branch counts as much as one not committed yet.
    git(dir, "add", "rapport.pdf");
    git(dir, "commit", "-q", "-m", "rapport");
    const { artifacts, capped } = await findArtifacts(store.listThreads());
    expect(capped).toBe(false);
    expect(artifacts.map((a) => a.path).sort()).toEqual([
      "capture.png",
      "docs/ancien.html",
      "docs/maquette.html",
      "rapport.pdf",
    ]);
    const png = artifacts.find((a) => a.path === "capture.png")!;
    expect(png).toMatchObject({ threadId, projectId, kind: "image", size: PNG.length });
    expect(png.threadTitle).toBeTruthy();
    expect(artifacts.find((a) => a.path === "rapport.pdf")?.kind).toBe("pdf");
  });

  it("leaves out resolved threads and files removed since", async () => {
    const { hub, store, dir, threadId } = await threadFolder();
    makeFiles(dir);
    rmSync(path.join(dir, "capture.png"));
    expect((await findArtifacts(store.listThreads())).artifacts.map((a) => a.path)).not.toContain(
      "capture.png",
    );
    await hub.handle({ send: () => undefined } as never, {
      type: "thread.setArchived",
      threadId,
      archived: true,
    });
    expect((await findArtifacts(store.listThreads())).artifacts).toEqual([]);
  });

  it("serves nothing of a locked project, even from an address given before", async () => {
    const { hub, dir, threadId, projectId } = await threadFolder();
    makeFiles(dir);
    const { ticket } = hub.artifactLinks.issue(threadId);
    expect(await hub.artifactLinks.resolve(ticket, "docs/maquette.html")).toBeDefined();
    hub.locks.setPin("123456");
    hub.locks.lock(projectId);
    expect(await hub.artifactLinks.resolve(ticket, "docs/maquette.html")).toBeUndefined();
    hub.locks.unlock(projectId, "123456");
    expect(await hub.artifactLinks.resolve(ticket, "docs/maquette.html")).toBeDefined();
  });

  it.skipIf(process.platform === "win32")(
    "leaves out a folder whose name looks like a page, and serves nothing from it",
    async () => {
      const { hub, store, dir, threadId } = await threadFolder();
      // Git lists a link as a file, whatever it leads to.
      symlinkSync(path.join(dir, "docs"), path.join(dir, "dossier.html"));
      expect((await findArtifacts(store.listThreads())).artifacts).toEqual([]);
      const { ticket } = hub.artifactLinks.issue(threadId);
      expect(await hub.artifactLinks.resolve(ticket, "dossier.html")).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves out a link leading out of the folder",
    async () => {
      const { root, store, dir } = await threadFolder();
      writeFileSync(path.join(root, "dehors.html"), "<p>dehors</p>");
      symlinkSync(path.join(root, "dehors.html"), path.join(dir, "lien.html"));
      expect((await findArtifacts(store.listThreads())).artifacts.map((a) => a.path)).toEqual([]);
    },
  );

  it("gives an address for a listed file only, which stops working after a while", async () => {
    const { hub, store, dir, threadId } = await threadFolder();
    makeFiles(dir);
    const messages: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void messages.push(m) };
    await hub.handle(client as never, {
      type: "artifacts.open",
      requestId: "r1",
      threadId,
      path: "docs/maquette.html",
    });
    const link = messages.find((m) => m.type === "artifactLink");
    expect(link).toMatchObject({ requestId: "r1" });
    expect(link && "url" in link && link.url).toMatch(
      /^\/api\/artifacts\/[\w-]{43}\/docs\/maquette\.html$/,
    );
    for (const file of [".env", "dist/bundle.html", "../dehors.html", "absent.html"]) {
      await expect(
        hub.handle(client as never, {
          type: "artifacts.open",
          requestId: "r2",
          threadId,
          path: file,
        }),
      ).rejects.toThrow(/plus dans la copie/);
    }

    let now = 1_000;
    // Its thread gone: nothing is served.
    const gone = new ArtifactLinks(
      () => undefined,
      () => now,
    );
    expect(await gone.resolve(gone.issue(threadId).ticket, "docs/maquette.html")).toBeUndefined();
    const real = new ArtifactLinks(
      (id) => store.getThread(id)?.workspace,
      () => now,
    );
    // Data a page could only read with a script, which never runs here: not served.
    writeFileSync(path.join(dir, "donnees.json"), "{}");
    writeFileSync(path.join(dir, "lisez.txt"), "x");
    const reader = real.issue(threadId);
    expect(await real.resolve(reader.ticket, "donnees.json")).toBeUndefined();
    expect(await real.resolve(reader.ticket, "lisez.txt")).toBeUndefined();
    // A file made after the folder was last listed is found all the same.
    expect(await real.resolve(reader.ticket, "docs/maquette.html")).toBeDefined();
    writeFileSync(path.join(dir, "docs/tout-neuf.png"), PNG);
    expect(await real.resolve(reader.ticket, "docs/tout-neuf.png")).toMatchObject({
      type: "image/png",
    });
    // The addresses of a revoked device stop at once; the others stay.
    const phone = real.issue(threadId, "telephone");
    const computer = real.issue(threadId);
    real.forget((deviceId) => deviceId === "telephone");
    expect(await real.resolve(phone.ticket, "docs/maquette.html")).toBeUndefined();
    expect(await real.resolve(computer.ticket, "docs/maquette.html")).toBeDefined();
    const issued = real.issue(threadId);
    expect(await real.resolve(issued.ticket, "docs/maquette.html")).toMatchObject({
      type: "text/html; charset=utf-8",
    });
    // Beside the page, what it loads; nothing of a type that is not served.
    expect(await real.resolve(issued.ticket, "docs/style.css")).toMatchObject({
      type: "text/css; charset=utf-8",
    });
    expect(await real.resolve(issued.ticket, "notes.md")).toBeUndefined();
    expect(await real.resolve(issued.ticket, ".env")).toBeUndefined();
    expect(await real.resolve("autre", "docs/maquette.html")).toBeUndefined();
    now += ARTIFACT_LINK_TTL_MS;
    expect(await real.resolve(issued.ticket, "docs/maquette.html")).toBeUndefined();
  });

  it("serves an artifact inside the app's frame only, as a sandbox with no script", async () => {
    const { root, hub, dir, threadId } = await threadFolder();
    makeFiles(dir);
    const webDir = path.join(root, "web");
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, "index.html"), "<title>MoonAgentic</title>");
    const server = createHttpServer({ hub, token: "jeton", webDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.unshift(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { ticket } = hub.artifactLinks.issue(threadId);

    const page = await fetch(origin + artifactUrl(ticket, "docs/maquette.html"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox; default-src 'none'/);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("script-src");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("style.css");

    const css = await fetch(origin + artifactUrl(ticket, "docs/style.css"));
    expect(css.status).toBe(200);
    const png = await fetch(origin + artifactUrl(ticket, "capture.png"));
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG);
    const pdf = await fetch(origin + artifactUrl(ticket, "rapport.pdf"));
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    );
    const head = await fetch(origin + artifactUrl(ticket, "capture.png"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.length));

    for (const asked of [
      artifactUrl(ticket, ".env"),
      artifactUrl(ticket, "dist/bundle.html"),
      artifactUrl(ticket, "notes.md"),
      `/api/artifacts/${ticket}/..%2F..%2Fstate.sqlite`,
      `/api/artifacts/${ticket}/docs%2Fmaquette.html`,
      `/api/artifacts/${ticket}/%E0%A4%A`,
      `/api/artifacts/${ticket}/`,
      artifactUrl("faux", "docs/maquette.html"),
    ]) {
      expect((await fetch(origin + asked)).status, asked).toBe(404);
    }
    const posted = await fetch(origin + artifactUrl(ticket, "capture.png"), { method: "POST" });
    expect(posted.status).toBe(405);
    // The app's own pages are still kept out of every frame.
    const app = await fetch(`${origin}/`);
    expect(app.headers.get("x-frame-options")).toBe("DENY");
  });
});
