// Settings → Accès distant in the built app, against a real server and a stand-in `tailscale`.
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-remote-e2e-"));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  // Answers `tailscale status --json` and `tailscale serve status --json` from files the
  // test writes, so what it publishes can change while the server runs.
  writeFileSync(
    path.join(bin, "tailscale"),
    `#!/bin/sh\nif [ "$1" = serve ]; then cat "${dir}/serve.json"; else cat "${dir}/status.json"; fi\n`,
  );
  chmodSync(path.join(bin, "tailscale"), 0o755);
  writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "mini.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7"] },
    }),
  );
  writeFileSync(path.join(dir, "serve.json"), "{}");
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    },
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

describe("Réglages → Accès distant", () => {
  // The stand-in « tailscale » is a POSIX shell script that Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "shows the real address with its link and QR code, and renews the token",
    async () => {
      const opened = new URL(url);
      const token = new URLSearchParams(opened.hash.replace(/^#/, "")).get("token") ?? "";
      const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
      const page = await context.newPage();
      const errors: Error[] = [];
      page.on("pageerror", (err) => errors.push(err));
      opened.pathname = "/reglages/remote";
      await page.goto(opened.href);

      // Tailscale runs but publishes nothing: no address, no QR code, and the command to run.
      await page.getByRole("heading", { name: "Accès distant" }).waitFor();
      await page.getByText("Aucune adresse ne permet encore").waitFor();
      await page.getByText(`tailscale serve --bg ${opened.port}`).waitFor();
      expect(await page.getByRole("img", { name: "QR code du lien de connexion" }).count()).toBe(0);

      // Once `tailscale serve` publishes the port, Actualiser finds the address.
      writeFileSync(
        path.join(dir, "serve.json"),
        JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "mini.tail1234.ts.net:443": {
              Handlers: { "/": { Proxy: `http://127.0.0.1:${opened.port}` } },
            },
          },
        }),
      );
      await page.getByRole("button", { name: "Actualiser" }).click();
      const link = page.getByLabel("Lien de connexion", { exact: true });
      await expect
        .poll(() => link.textContent())
        .toBe(`https://mini.tail1234.ts.net/#token=${token}`);
      await page.getByRole("img", { name: "QR code du lien de connexion" }).waitFor();
      // Nothing is wider than the phone's screen.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );

      // Renewing gives a new link; this page stays connected, the old token is refused.
      await page.getByRole("button", { name: "Renouveler", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Renouveler" }).click();
      await expect.poll(() => link.textContent()).not.toContain(token);
      const renewedUrl = new URL((await link.textContent()) ?? "");
      const renewed = new URLSearchParams(renewedUrl.hash.replace(/^#/, "")).get("token") ?? "";
      expect(renewed).toBe(readFileSync(path.join(dir, "data", "token"), "utf8"));
      const auth = (given: string) =>
        fetch(new URL("/api/auth", url), { headers: { authorization: `Bearer ${given}` } }).then(
          (r) => r.status,
        );
      expect(await auth(token)).toBe(401);
      expect(await auth(renewed)).toBe(204);
      await page.reload();
      await page.getByRole("heading", { name: "Accès distant" }).waitFor();
      await expect.poll(() => link.textContent()).toContain(renewed);

      // A device still on the old token is shown the door.
      const other = await (await browser.newContext()).newPage();
      await other.goto(url);
      await other.getByRole("heading", { name: "Lien de connexion requis" }).waitFor();

      expect(errors).toEqual([]);
      await context.close();
    },
  );
});
