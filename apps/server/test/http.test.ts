import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RemoteAccess } from "@moonagentic/protocol";
import { createHttpServer, TOKEN_RENEWED } from "../src/http.ts";
import type { Hub } from "../src/hub.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const TOKEN = "jeton-de-test";

async function serve() {
  const webDir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-web-"));
  writeFileSync(path.join(webDir, "index.html"), "<title>MoonAgentic</title>");
  let connected = 0;
  const hub = {
    connect: () => {
      connected += 1;
      return () => undefined;
    },
    handle: async () => undefined,
  } as unknown as Hub;
  const renewed: string[] = [];
  const asked: { host: string; port: number }[] = [];
  const server = createHttpServer({
    hub,
    token: TOKEN,
    webDir,
    onTokenRenewed: (token) => renewed.push(token),
    remoteAccess: async (host, port): Promise<RemoteAccess> => {
      asked.push({ host, port });
      return { port, exposed: false, tailscale: "absent", addresses: [] };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(webDir, { recursive: true, force: true });
  });
  const origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, webDir, connections: () => connected, renewed, asked };
}

/** Opens a socket and tells whether the server let it in. */
const socketOpens = (url: string) =>
  new Promise<boolean>((resolve) => {
    const socket = new WebSocket(url);
    socket.once("open", () => {
      socket.close();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

describe("the HTTP server", () => {
  it("answers addresses it cannot read with an error, and keeps running", async () => {
    const { origin } = await serve();
    for (const bad of ["/%E0%A4%A", "/%", "/a%00b"]) {
      expect((await fetch(`http://${origin}${bad}`)).status).toBe(400);
    }
    const page = await fetch(`http://${origin}/t/un-fil`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("MoonAgentic");
  });

  it("answers a missing built file with 404, not the app's page", async () => {
    const { origin, webDir } = await serve();
    mkdirSync(path.join(webDir, "assets"));
    writeFileSync(path.join(webDir, "assets", "index-nouveau.js"), "export {}");
    const old = await fetch(`http://${origin}/assets/Planner-ancien.js`);
    expect(old.status).toBe(404);
    expect(old.headers.get("cache-control")).toBe("no-store");
    const kept = await fetch(`http://${origin}/assets/index-nouveau.js`);
    expect(kept.status).toBe(200);
    expect(kept.headers.get("content-type")).toBe("text/javascript");
    // Only the built files are strict: an app route still gets the page.
    expect((await fetch(`http://${origin}/assets-du-projet`)).status).toBe(200);
  });

  it("tells which build it serves, and notices a new one", async () => {
    const { origin, webDir } = await serve();
    const page = (id: string) =>
      `<head><meta name="moonagentic-build" content="${id}"><title>MoonAgentic</title></head>`;
    const ask = async () =>
      ((await (await fetch(`http://${origin}/api/build`)).json()) as { id: unknown }).id;
    expect(await ask()).toBeNull();
    const index = path.join(webDir, "index.html");
    writeFileSync(index, page("build-1"));
    utimesSync(index, new Date(), new Date(Date.now() + 2_000));
    expect(await ask()).toBe("build-1");
    writeFileSync(index, page("build-22"));
    utimesSync(index, new Date(), new Date(Date.now() + 4_000));
    expect(await ask()).toBe("build-22");
  });

  it("serves nothing from outside the web app's folder", async () => {
    const { origin } = await serve();
    const escaped = await fetch(`http://${origin}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(await escaped.text()).toContain("MoonAgentic");
  });

  it("keeps the app out of frames and its page from loading anything from elsewhere", async () => {
    const { origin } = await serve();
    const { headers } = await fetch(`http://${origin}/`);
    const policy = headers.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain(`connect-src 'self' ws://${origin}`);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("lets in only who holds the token", async () => {
    const { origin, connections } = await serve();
    const auth = (token: string) =>
      fetch(`http://${origin}/api/auth`, { headers: { authorization: `Bearer ${token}` } });
    expect((await auth("autre")).status).toBe(401);
    expect((await auth(TOKEN)).status).toBe(204);

    expect(await socketOpens(`ws://${origin}/ws?token=autre`)).toBe(false);
    expect(await socketOpens(`ws://${origin}/ws`)).toBe(false);
    expect(await socketOpens(`ws://${origin}/autre?token=${TOKEN}`)).toBe(false);
    expect(connections()).toBe(0);
    expect(await socketOpens(`ws://${origin}/ws?token=${TOKEN}`)).toBe(true);
    expect(connections()).toBe(1);
  });

  it("tells how to reach it only to who holds the token", async () => {
    const { origin, asked } = await serve();
    const get = (token: string, method = "GET") =>
      fetch(`http://${origin}/api/remote`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await get("autre")).status).toBe(401);
    expect((await get(TOKEN, "POST")).status).toBe(405);
    expect(asked).toEqual([]);
    const response = await get(TOKEN);
    const port = Number(origin.split(":")[1]);
    expect(await response.json()).toEqual({
      port,
      exposed: false,
      tailscale: "absent",
      addresses: [],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(asked).toEqual([{ host: "127.0.0.1", port }]);
  });

  it("renews the token: the old one stops working and its connections are closed", async () => {
    const { origin, renewed } = await serve();
    const renew = (token: string, method = "POST") =>
      fetch(`http://${origin}/api/remote/token`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await renew("autre")).status).toBe(401);
    expect((await renew(TOKEN, "GET")).status).toBe(405);
    expect(renewed).toEqual([]);

    const socket = new WebSocket(`ws://${origin}/ws?token=${TOKEN}`);
    await new Promise((resolve) => socket.once("open", resolve));
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));

    const response = await renew(TOKEN);
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(token).not.toBe(TOKEN);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(renewed).toEqual([token]);
    expect(await closed).toBe(TOKEN_RENEWED);

    expect(await socketOpens(`ws://${origin}/ws?token=${TOKEN}`)).toBe(false);
    expect(await socketOpens(`ws://${origin}/ws?token=${token}`)).toBe(true);
    expect((await renew(TOKEN)).status).toBe(401);
  });
});
