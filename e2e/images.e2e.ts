// Images joined to a message, in the built app: picked, pasted or dropped in the composer,
// shown in the thread, given to the demo agent.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;

/** A real PNG of one colour, or of noise when it has to be heavy. */
function png(width: number, height: number, rgb: [number, number, number] | "noise"): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + width * 3));
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 3);
    for (let x = 0; x < width * 3; x++) {
      if (rgb === "noise") {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        rows[at + 1 + x] = seed >> 16;
      } else rows[at + 1 + x] = rgb[x % 3]!;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(rows, { level: rgb === "noise" ? 0 : 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-images-e2e-"));
  repo = path.join(dir, "projet");
  mkdirSync(repo);
  writeFileSync(path.join(repo, "README.md"), "# Démo\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" },
  );
  url = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+#token=\S+/.exec(out);
      if (found) resolve(found[0]);
    });
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    server.once("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code}).`)));
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly keep a handle on a temp directory after process shutdown.
    }
  }
});

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
const drafts = (page: Page) => page.locator(".cimg");
const sentImages = (page: Page) => page.locator(".u-img img");
const send = (page: Page) => page.getByRole("button", { name: "Envoyer" });

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** Hands files to the page as a paste or a drop would. */
async function give(
  page: Page,
  how: "paste" | "drop",
  files: { name: string; type: string; bytes: Buffer }[],
  text?: string,
) {
  await page.evaluate(
    ({ how, files, text }) => {
      const data = new DataTransfer();
      for (const file of files) {
        const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], file.name, { type: file.type }));
      }
      if (text !== undefined) data.setData("text/plain", text);
      if (how === "paste") {
        document
          .querySelector('textarea[aria-label="Message"]')!
          .dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        return;
      }
      for (const type of ["dragenter", "dragover", "drop"])
        document.body.dispatchEvent(
          new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    },
    {
      how,
      text,
      files: files.map((f) => ({ name: f.name, type: f.type, base64: f.bytes.toString("base64") })),
    },
  );
}

/** How many images wait on the server for their message. */
const waiting = () => {
  const folder = path.join(dir, "data", "attachments", "pending");
  return existsSync(folder) ? readdirSync(folder).filter((f) => !f.endsWith(".json")).length : 0;
};

describe("images jointes", () => {
  it("joins images to a message, shows them in the thread and gives them to the agent", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    // An image the page may not show is said on the console, by the browser's own policy.
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(repo);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await page.locator(".agentchip").click();
    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");
    // The demo agent asks before it changes a file: here it is let through.
    await page.getByRole("button", { name: /Mode d'accès/ }).click();
    await page.getByRole("menuitemradio", { name: /Accès complet/ }).click();

    const red = png(40, 30, [220, 40, 40]);
    const blue = png(30, 40, [40, 80, 220]);

    // The « + » offers to join an image; the file chosen shows in the composer.
    await page.getByRole("button", { name: "Ajouter" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Joindre une image" }).click();
    await (await chooser).setFiles({ name: "rouge.png", mimeType: "image/png", buffer: red });
    await drafts(page).getByRole("img", { name: "rouge.png" }).waitFor();
    // An image alone is a message: it can be sent as soon as the server has it.
    await expect.poll(() => send(page).isEnabled()).toBe(true);
    expect(waiting()).toBe(1);

    // Pasted from the clipboard, and dropped on the page.
    await give(page, "paste", [{ name: "bleu.png", type: "image/png", bytes: blue }]);
    await expect.poll(() => drafts(page).count()).toBe(2);
    await give(page, "drop", [{ name: "encore.png", type: "image/png", bytes: red }]);
    await expect.poll(() => drafts(page).count()).toBe(3);
    await expect.poll(() => page.locator(".cimg.sending").count()).toBe(0);
    expect(await page.locator(".cdrop").count()).toBe(0);
    expect(waiting()).toBe(3);
    await shot(page, "i1-composer");

    // Taken off before sending: the server does not keep it.
    await page.getByRole("button", { name: "Retirer encore.png" }).click();
    await expect.poll(() => drafts(page).count()).toBe(2);
    await expect.poll(waiting).toBe(1 + 1);

    // Text copied with a picture of it, as a spreadsheet does, is pasted as text.
    await composer(page).focus();
    await give(page, "paste", [{ name: "cellules.png", type: "image/png", bytes: red }], "A1");
    expect(await drafts(page).count()).toBe(2);
    // A file that is no image is refused, and said so.
    await give(page, "drop", [{ name: "notes.txt", type: "text/plain", bytes: Buffer.from("x") }]);
    await page.getByText("Seules les images peuvent être jointes").waitFor();
    expect(await drafts(page).count()).toBe(2);

    await composer(page).fill("Regarde ces deux images");
    await composer(page).press("Enter");
    // In the thread, over the text; the composer is empty again.
    await expect.poll(() => sentImages(page).count()).toBe(2);
    await expect
      .poll(() =>
        sentImages(page).evaluateAll((all) =>
          all.every((img) => (img as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    expect(await drafts(page).count()).toBe(0);
    expect(waiting()).toBe(0);
    // The agent got both, as images. Its turn is over first: until its last word, what it
    // did is folded in two details, and the one opened too early would be merged away.
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    await page.locator(".team-detail-h").last().click();
    await page
      .getByText(
        `Pièces jointes : image/png, ${red.length} octets (image), image/png, ${blue.length} octets (image).`,
      )
      .waitFor();
    await shot(page, "i2-fil");

    // Read back from the server after a reload, with the token.
    await page.reload();
    await expect.poll(() => sentImages(page).count()).toBe(2);
    await expect
      .poll(() =>
        sentImages(page).evaluateAll((all) =>
          all.every((img) => (img as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);

    // Pressed, an image shows whole; Escape closes it.
    await page.getByRole("button", { name: "Agrandir rouge.png" }).click();
    const viewer = page.getByRole("dialog", { name: "rouge.png" });
    await viewer.getByRole("img").waitFor();
    await shot(page, "i3-agrandie");
    await page.keyboard.press("Escape");
    await expect.poll(() => viewer.count()).toBe(0);

    // A heavy image is drawn again lighter before it leaves, and goes alone, without text.
    const heavy = png(1500, 1000, "noise");
    expect(heavy.length).toBeGreaterThan(4 * 1024 * 1024);
    await page
      .getByLabel("Choisir des images")
      .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: heavy });
    await drafts(page).getByRole("img", { name: "photo.jpg" }).waitFor();
    await expect.poll(() => send(page).isEnabled(), { timeout: 20_000 }).toBe(true);
    await send(page).click();
    await page.getByRole("button", { name: "Agrandir photo.jpg" }).waitFor();
    await expect.poll(() => sentImages(page).count()).toBe(3);
    await expect.poll(() => page.getByText("C'est fait, la réponse vaut 42.").count()).toBe(2);
    await page.locator(".team-detail-h").last().click();
    await page.getByText(/Pièces jointes : image\/jpeg, \d+ octets \(image\)\./).waitFor();
    // A message of images alone has no empty bubble.
    expect(await page.locator(".u-wrap").last().locator(".u").count()).toBe(0);

    // « Revenir ici » takes the message back with its image.
    await page.locator(".u-wrap").last().hover();
    await page.locator(".u-wrap").last().getByRole("button", { name: "Revenir ici" }).click();
    await page
      .getByRole("group", { name: "Revenir à ce message" })
      .getByRole("button", { name: "Revenir ici" })
      .click();
    await drafts(page).getByRole("img", { name: "photo.jpg" }).waitFor();
    await expect.poll(() => sentImages(page).count()).toBe(2);
    await expect.poll(() => send(page).isEnabled()).toBe(true);

    expect(errors).toEqual([]);
    await page.close();
  });

  it("fits a phone's screen", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByText("Regarde ces deux images").first().click();
    await expect.poll(() => sentImages(page).count()).toBe(2);
    await page.getByLabel("Choisir des images").setInputFiles(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        name: `image-${n}.png`,
        mimeType: "image/png",
        buffer: png(20 + n, 20, [n * 30, 90, 160]),
      })),
    );
    await expect.poll(() => drafts(page).count()).toBe(8);
    await expect.poll(() => page.locator(".cimg.sending").count()).toBe(0);
    // No more than eight in one message: the ninth is refused, and said so.
    await page
      .getByLabel("Choisir des images")
      .setInputFiles({ name: "de-trop.png", mimeType: "image/png", buffer: png(9, 9, [0, 0, 0]) });
    await page.getByText("Pas plus de 8 images par message.").waitFor();
    expect(await drafts(page).count()).toBe(8);
    await shot(page, "i4-telephone");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await context.close();
  });
});
