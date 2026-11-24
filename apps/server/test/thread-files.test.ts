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
import { generatedFolders, madeImages, refPath, resolveThreadFile } from "../src/thread-files.ts";

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
      // A drive with no folder after it: relative to whatever folder that drive is in.
      "C:foo.png",
    ]) {
      expect(refPath(web)).toBeUndefined();
    }
  });
});

describe("madeImages", () => {
  it("reads the image a tool's result says it saved, as Codex's image generation does", () => {
    const saved = "C:\\Users\\BreezyHomeCinéma\\.codex\\generated_images\\019a\\ig_1.png";
    const image = { type: "content", content: { type: "image", data: "AA", uri: saved } };
    const link = { type: "content", content: { type: "resource_link", name: saved, uri: saved } };
    expect(madeImages([image], { savedPath: saved })).toEqual([saved]);
    expect(madeImages([link], undefined)).toEqual([saved]);
    expect(madeImages(undefined, { savedPath: saved })).toEqual([saved]);
    // Not what is no image, nor an address of the web, nor a result that says nothing.
    expect(
      madeImages(
        [
          { type: "content", content: { type: "text", text: saved } },
          { type: "content", content: { type: "resource_link", uri: "C:\\a\\notes.md" } },
          { type: "content", content: { type: "image", data: "AA", uri: "https://x.test/a.png" } },
          { type: "diff", path: "a.png", newText: "" },
        ],
        { savedPath: null },
      ),
    ).toEqual([]);
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

  it("finds an image named alone in the folder where the agent generated it", async () => {
    // Hydrogen, out of any project: « [naruto_1795.jpg](naruto_1795.jpg) », the file being in
    // Antigravity's own conversation folder.
    const root = tempDir();
    const folder = path.join(root, "discussions");
    const brain = path.join(root, "brain");
    mkdirSync(folder, { recursive: true });
    mkdirSync(path.join(brain, "conv-ancienne"), { recursive: true });
    mkdirSync(path.join(brain, "conv-2"), { recursive: true });
    writeFileSync(path.join(brain, "conv-2", "naruto_1795.jpg"), PNG);
    writeFileSync(path.join(brain, "conv-2", "notes.md"), "# notes");
    writeFileSync(path.join(root, "dehors.png"), PNG);

    expect(await resolveThreadFile("naruto_1795.jpg", folder, [folder], [brain])).toMatchObject({
      name: "naruto_1795.jpg",
      type: "image/jpeg",
    });
    // Not without the generated folders, nor what is not shown, nor out of them.
    expect(await resolveThreadFile("naruto_1795.jpg", folder, [folder])).toBeUndefined();
    for (const refused of ["notes.md", "../../dehors.png", "absent.jpg"]) {
      expect(await resolveThreadFile(refused, folder, [folder], [brain]), refused).toBeUndefined();
    }
    // The thread's own file comes first.
    writeFileSync(path.join(folder, "naruto_1795.jpg"), Buffer.concat([PNG, PNG]));
    expect(await resolveThreadFile("naruto_1795.jpg", folder, [folder], [brain])).toMatchObject({
      size: PNG.length * 2,
    });
  });

  it("knows where agents keep what they generate", () => {
    expect(generatedFolders("/h")).toContain(path.join("/h", ".gemini", "antigravity", "brain"));
  });

  it("finds the image Antigravity made from the app, kept apart from the desktop one's", async () => {
    // The app runs Antigravity as `agy`, whose conversations are in `antigravity-cli`, not in
    // `antigravity`; the home folder has an accent, as on the computer where it was missed.
    const home = path.join(tempDir(), "BreezyHomeCinéma");
    const folder = path.join(home, "MoonAgentic", "Discussions");
    const conversation = path.join(home, ".gemini", "antigravity-cli", "brain", "1795544700000");
    mkdirSync(folder, { recursive: true });
    mkdirSync(conversation, { recursive: true });
    mkdirSync(path.join(home, ".gemini", "antigravity", "brain"), { recursive: true });
    const name = "naruto_sasuke_mcdonalds_1795544736202.jpg";
    writeFileSync(path.join(conversation, name), PNG);

    expect(await resolveThreadFile(name, folder, [folder], generatedFolders(home))).toMatchObject({
      name,
      type: "image/jpeg",
    });
  });

  it("finds an image named alone a few folders below the conversation's", async () => {
    const root = tempDir();
    const folder = path.join(root, "discussions");
    const brain = path.join(root, "brain");
    mkdirSync(folder, { recursive: true });
    mkdirSync(path.join(brain, "conv-1", "artifacts", "images"), { recursive: true });
    mkdirSync(path.join(brain, "conv-1", "a", "b", "c"), { recursive: true });
    writeFileSync(path.join(brain, "conv-1", "artifacts", "images", "chat_1.png"), PNG);
    writeFileSync(path.join(brain, "conv-1", "a", "b", "c", "trop_loin.png"), PNG);

    expect(await resolveThreadFile("chat_1.png", folder, [folder], [brain])).toMatchObject({
      name: "chat_1.png",
    });
    expect(await resolveThreadFile("trop_loin.png", folder, [folder], [brain])).toBeUndefined();
  });
});

describe("file.open", { timeout: 40_000 }, () => {
  /** A thread whose demo agent generated an image, as Antigravity does, in `home`. */
  async function hubWithImage() {
    const root = tempDir();
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    // The agent keeps what it generates in the home folder it is started with.
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    cleanups.push(() => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
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
      text: "Stp génère une image d'un pingouin",
    });
    await hub.whenIdle(threadId);
    const answer = store
      .listItems(threadId)
      .find((i): i is Extract<typeof i, { kind: "agent" }> => i.kind === "agent")!.text;
    // The image as a path, the copy and the original as file addresses.
    const [image, copy, original] = [...answer.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    return {
      root,
      repo,
      home,
      hub,
      store,
      projectId,
      threadId,
      image: image!,
      copy: copy!,
      original: original!,
    };
  }

  const ask = async (hub: Hub, threadId: string, ref: string) => {
    const replies: ServerMessage[] = [];
    await hub.handle({ send: (m: ServerMessage) => void replies.push(m) } as never, {
      type: "file.open",
      requestId: "f",
      threadId,
      ref,
    });
    return replies.at(-1) as Extract<ServerMessage, { type: "fileLink" }>;
  };

  it("gives an address for an image the agent made, which serves that file alone", async () => {
    const { hub, projectId, threadId, image, copy, original } = await hubWithImage();
    expect(image).toMatch(/pingouin_\d+\.png$/);

    const link = await ask(hub, threadId, image);
    expect(link).toMatchObject({ type: "fileLink", mime: "image/png", name: path.basename(image) });
    expect(link.url).toMatch(/^\/api\/artifacts\/[\w-]{43}\/pingouin_\d+\.png$/);
    const ticket = link.url.split("/")[3]!;
    expect(await hub.artifactLinks.resolve(ticket, link.name)).toMatchObject({
      type: "image/png",
    });
    // The address is for that file, not for its folder.
    expect(await hub.artifactLinks.resolve(ticket, "autre.png")).toBeUndefined();
    // Asked again, the same address is given while it has time left; by a file address too.
    expect((await ask(hub, threadId, image)).url).toBe(link.url);
    expect((await ask(hub, threadId, original)).url).toBe(link.url);
    // The copy in the project, as the agent names it.
    expect(await ask(hub, threadId, copy)).toMatchObject({ name: "pingouin.png" });

    // Nothing of a locked project, even from an address given before.
    hub.locks.setPin("123456");
    hub.locks.lock(projectId);
    expect(await hub.artifactLinks.resolve(ticket, link.name)).toBeUndefined();
    hub.locks.unlock(projectId, "123456");
    expect(await hub.artifactLinks.resolve(ticket, link.name)).toBeDefined();
  });

  it("keeps the image a tool says it made, and serves it though no answer names it", async () => {
    // Codex: « Voici la lune » and nothing else; the file is told in the tool's result only.
    const { hub, store, home, projectId } = await hubWithImage();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Stp peins une image de la lune",
    });
    await hub.whenIdle(threadId);
    const items = store.listItems(threadId);
    const answer = items.find((i) => i.kind === "agent")!;
    expect(answer.kind === "agent" && answer.text).not.toMatch(/\.png/);
    const tool = items.find((i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool")!;
    expect(tool.images).toHaveLength(1);
    const made = tool.images![0]!;
    expect(made.startsWith(path.join(home, ".codex", "generated_images"))).toBe(true);
    expect(await ask(hub, threadId, made)).toMatchObject({ type: "fileLink", mime: "image/png" });
    // Another image beside it, which no tool of the thread made, stays out of reach.
    const other = path.join(path.dirname(made), "autre.png");
    writeFileSync(other, PNG);
    await expect(ask(hub, threadId, other)).rejects.toThrow(/ne nomme ce fichier/);
  });

  it("serves only a file one of the thread's answers names", async () => {
    const { hub, store, home, repo, projectId, threadId, image } = await hubWithImage();
    // Another image in the agents' shared folder, and one in the project: no answer names them.
    const other = path.join(path.dirname(image), "autre_projet.png");
    writeFileSync(other, PNG);
    writeFileSync(path.join(repo, "photo.png"), PNG);
    writeFileSync(path.join(home, "photo.png"), PNG);
    for (const ref of [other, "photo.png", path.join(home, "photo.png")]) {
      await expect(ask(hub, threadId, ref), ref).rejects.toThrow(/ne nomme ce fichier/);
    }
    // A thread of another project cannot have it either, though the folder is shared.
    const elsewhere = hub.createProject("autre", tempDir());
    const otherThread = hub.createThread({
      projectId: elsewhere,
      agentId: "demo",
      permissionMode: "full",
      text: "Bonjour",
    });
    await hub.whenIdle(otherThread);
    await expect(ask(hub, otherThread, image)).rejects.toThrow(/ne nomme ce fichier/);
    expect(store.answerHolds(threadId, image)).toBe(true);
    expect(projectId).not.toBe(elsewhere);
  });
});
