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
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

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

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("Réglages → Accès distant", () => {
  // The stand-in « tailscale » is a POSIX shell script that Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "pairs a phone with a one-time code, renews the computer's token, and revokes the phone",
    async () => {
      const opened = new URL(url);
      const token = new URLSearchParams(opened.hash.replace(/^#/, "")).get("token") ?? "";
      const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
      const page = await context.newPage();
      const errors: Error[] = [];
      page.on("pageerror", (err) => errors.push(err));
      opened.pathname = "/reglages/remote";
      await page.goto(opened.href);

      // Tailscale runs but publishes nothing: no address, nothing to pair with, the command.
      await page.getByRole("heading", { name: "Accès distant" }).waitFor();
      await page.getByText("Aucune adresse ne permet encore").waitFor();
      await page.getByText(`tailscale serve --bg ${opened.port}`).waitFor();
      await page.getByText("Aucun pour l'instant.").waitFor();
      expect(await page.getByRole("button", { name: "Appairer un appareil" }).count()).toBe(0);
      // The computer's own token is never shown on the page any more.
      expect(await page.content()).not.toContain(token);

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
      await page.getByRole("button", { name: "Appairer un appareil" }).click();
      const shown = page.getByLabel("Code d'appairage", { exact: true });
      await shown.waitFor();
      const code = ((await shown.textContent()) ?? "").replace("-", "");
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      await page.getByRole("img", { name: "QR code d'appairage" }).waitFor();
      if (shots)
        await page.screenshot({ path: path.join(shots, "appairer-code.png"), fullPage: true });
      // Nothing is wider than the phone's screen.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );

      // The phone opens the pairing link: it gets its own access, and the code leaves the address.
      const phoneContext = await browser.newContext({
        viewport: { width: 390, height: 800 },
        userAgent: IPHONE,
      });
      const phone = await phoneContext.newPage();
      phone.on("pageerror", (err) => errors.push(err));
      await phone.goto(`${new URL(url).origin}/#pair=${code}`);
      await phone.getByRole("combobox", { name: "Message" }).waitFor();
      expect(new URL(phone.url()).hash).toBe("");
      await page.getByText("« iPhone · Safari » est appairé.").waitFor();
      await page.locator(".ra-devices").getByText("iPhone · Safari").waitFor();
      if (shots) await page.screenshot({ path: path.join(shots, "appareils.png"), fullPage: true });
      // On the phone, the devices are not listed: only the computer manages them.
      await phone.goto(`${new URL(url).origin}/reglages/remote`);
      await phone.getByText("Cet appareil est appairé").waitFor();
      expect(await phone.getByRole("button", { name: "Renouveler" }).count()).toBe(0);

      // The same code does not work twice.
      const again = await (await browser.newContext()).newPage();
      await again.goto(`${new URL(url).origin}/#pair=${code}`);
      await again.getByRole("heading", { name: "Appairer cet appareil" }).waitFor();
      await again.getByText("il a expiré ou a déjà servi").waitFor();
      if (shots) await again.screenshot({ path: path.join(shots, "appairer-telephone.png") });

      // Already paired, the phone opening a used link stays connected, and is told why.
      await phone.goto(`${new URL(url).origin}/#pair=${code}`);
      await phone.getByText("Appairage refusé").waitFor();
      await phone.getByRole("combobox", { name: "Message" }).waitFor();
      await phone.goto(`${new URL(url).origin}/reglages/remote`);

      // Renewing the computer's token: the old one is refused, the phone stays connected.
      await page.getByRole("button", { name: "Renouveler", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Renouveler" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached" });
      const auth = (given: string) =>
        fetch(new URL("/api/auth", url), { headers: { authorization: `Bearer ${given}` } }).then(
          (r) => r.status,
        );
      await expect.poll(() => auth(token)).toBe(401);
      const renewed = readFileSync(path.join(dir, "data", "token"), "utf8");
      expect(await auth(renewed)).toBe(204);
      await phone.reload();
      await phone.getByText("Cet appareil est appairé").waitFor();

      // Revoked from the computer, the phone is asked to pair again.
      await page
        .locator(".ra-devices li", { hasText: "iPhone · Safari" })
        .getByRole("button", {
          name: "Révoquer",
        })
        .click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Révoquer" }).click();
      await page.getByText("Aucun pour l'instant.").waitFor();
      await phone.getByRole("heading", { name: "Appairer cet appareil" }).waitFor();
      // The failed link from before is not shown as the reason.
      expect(await phone.getByText("il a expiré").count()).toBe(0);

      // A window still on the old link is shown the door too.
      const other = await (await browser.newContext()).newPage();
      await other.goto(url);
      await other.getByRole("heading", { name: "Appairer cet appareil" }).waitFor();

      expect(errors).toEqual([]);
      await phoneContext.close();
      await context.close();
    },
  );
});
