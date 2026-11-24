// The files an answer names: which are served, from which folders, and to whom.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@moonagentic/protocol";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { generatedFolders, refPath, resolveThreadFile } from "../src/thread-files.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-fichiers-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("refPath", () => {
  it("reads the paths an agent writes, and leaves out web addresses", () => {
    expect(refPath("images/plan.png")).toBe("images/plan.png");
    expect(refPath("./plan.png?v=2#haut")).toBe("./plan.png");
    expect(refPath("C:\\Users\\a\\pingouin.jpg")).toBe("C:\\Users\\a\\pingouin.jpg");
    expect(refPath("C:/Users/a/pingouin.jpg")).toBe("C:/Users/a/pingouin.jpg");
    expect(refPath("/home/a/pingouin.jpg")).toBe("/home/a/pingouin.jpg");
    // A Windows file address, read on any system.
    expect(refPath("file:///C:/Users/a/mon%20image.png")).toMatch(
      /^C:[\\/]Users[\\/]a[\\/]mon image\.png$/,
    );
    for (const web of [
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "//example.com/a.png",
      "\\\\serveur\\partage\\a.png",
      "",
      "a\0b.png",
    ]) {
      expect(refPath(web)).toBeUndefined();
    }
  });
});

describe("resolveThreadFile", () => {
  it("serves a shown kind of file inside the roots only", async () => {
    const root = tempDir();
    const folder = path.join(root, "projet");
    const brain = path.join(root, "brain", "conv-1");
    mkdirSync(path.join(folder, "images"), { recursive: true });
    mkdirSync(brain, { recursive: true });
    writeFileSync(path.join(folder, "images", "mon plan.png"), PNG);
    writeFileSync(path.join(folder, ".env"), "SECRET=1");
    writeFileSync(path.join(folder, "notes.md"), "# notes");
    writeFileSync(path.join(brain, "pingouin_1795.jpg"), PNG);
    writeFileSync(path.join(root, "dehors.png"), PNG);
    const roots = [folder, path.join(root, "brain")];

    const relative = await resolveThreadFile("images/mon%20plan.png", folder, roots);
    expect(relative).toMatchObject({ name: "mon plan.png", type: "image/png", size: PNG.length });
    const generated = path.join(brain, "pingouin_1795.jpg");
    expect(await resolveThreadFile(generated, folder, roots)).toMatchObject({
      type: "image/jpeg",
    });
    expect(await resolveThreadFile(pathToFileURL(generated).href, folder, roots)).toMatchObject({
      name: "pingouin_1795.jpg",
    });

    for (const refused of [
      ".env",
      "notes.md",
      "../dehors.png",
      "images/../../dehors.png",
      path.join(root, "dehors.png"),
      pathToFileURL(path.join(root, "dehors.png")).href,
      "absent.png",
      "images",
    ]) {
      expect(await resolveThreadFile(refused, folder, roots), refused).toBeUndefined();
    }
  });

  it.skipIf(process.platform === "win32")(
    "follows links before it looks where a file is, and by what it really is",
    async () => {
      const root = tempDir();
      const folder = path.join(root, "projet");
      mkdirSync(folder);
      writeFileSync(path.join(root, "dehors.png"), PNG);
      writeFileSync(path.join(folder, "secret.txt"), "x");
      symlinkSync(path.join(root, "dehors.png"), path.join(folder, "lien.png"));
      symlinkSync(path.join(folder, "secret.txt"), path.join(folder, "deguise.png"));
      expect(await resolveThreadFile("lien.png", folder, [folder])).toBeUndefined();
      expect(await resolveThreadFile("deguise.png", folder, [folder])).toBeUndefined();
    },
  );

  it("knows where agents keep what they generate", () => {
    expect(generatedFolders("/h")).toContain(path.join("/h", ".gemini", "antigravity", "brain"));
  });
});

describe("file.open", { timeout: 40_000 }, () => {
  async function hubWithThread() {
    const root = tempDir();
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    mkdirSync(repo, { recursive: true });
    const store = new Store(path.join(root, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      homeDir: home,
      worktreesDir: path.join(root, "worktrees"),
    });
    cleanups.unshift(async () => {
      await hub.close();
      store.close();
    });
    const projectId = hub.createProject("demo", repo);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Génère une image",
    });
    await hub.whenIdle(threadId);
    return { root, repo, home, hub, projectId, threadId };
  }

  it("gives an address for an image the agent made, which serves that file alone", async () => {
    const { repo, home, hub, projectId, threadId } = await hubWithThread();
    const brain = path.join(home, ".gemini", "antigravity", "brain", "conv");
    mkdirSync(brain, { recursive: true });
    const made = path.join(brain, "pingouin_mange_1795.jpg");
    writeFileSync(made, PNG);
    writeFileSync(path.join(repo, "pingouin_mange.jpg"), PNG);

    const replies: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void replies.push(m) };
    await hub.handle(client as never, {
      type: "file.open",
      requestId: "f1",
      threadId,
      ref: pathToFileURL(made).href,
    });
    const link = replies.at(-1) as Extract<ServerMessage, { type: "fileLink" }>;
    expect(link).toMatchObject({
      type: "fileLink",
      requestId: "f1",
      name: "pingouin_mange_1795.jpg",
      mime: "image/jpeg",
      size: PNG.length,
    });
    expect(link.url).toMatch(/^\/api\/artifacts\/[\w-]{43}\/pingouin_mange_1795\.jpg$/);
    const ticket = link.url.split("/")[3]!;
    expect(await hub.artifactLinks.resolve(ticket, "pingouin_mange_1795.jpg")).toMatchObject({
      type: "image/jpeg",
    });
    // The address is for that file, not for its folder.
    expect(await hub.artifactLinks.resolve(ticket, "autre.jpg")).toBeUndefined();

    // Asked again, the same address is given while it has time left.
    await hub.handle(client as never, {
      type: "file.open",
      requestId: "f2",
      threadId,
      ref: made,
    });
    expect((replies.at(-1) as { url: string }).url).toBe(link.url);

    // One in the project, as the agent names it.
    await hub.handle(client as never, {
      type: "file.open",
      requestId: "f3",
      threadId,
      ref: "pingouin_mange.jpg",
    });
    expect(replies.at(-1)).toMatchObject({ type: "fileLink", name: "pingouin_mange.jpg" });

    // Nothing outside the thread's folders and the agents' own.
    writeFileSync(path.join(home, "photo.png"), PNG);
    await expect(
      hub.handle(client as never, {
        type: "file.open",
        requestId: "f4",
        threadId,
        ref: path.join(home, "photo.png"),
      }),
    ).rejects.toThrow(/ne peut pas être ouvert/);

    // Nor anything of a locked project, even from an address given before.
    hub.locks.setPin("123456");
    hub.locks.lock(projectId);
    expect(await hub.artifactLinks.resolve(ticket, "pingouin_mange_1795.jpg")).toBeUndefined();
    hub.locks.unlock(projectId, "123456");
    expect(await hub.artifactLinks.resolve(ticket, "pingouin_mange_1795.jpg")).toBeDefined();
  });
});
