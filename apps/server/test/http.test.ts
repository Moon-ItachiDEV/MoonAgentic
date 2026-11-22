import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createHttpServer } from "../src/http.ts";
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
  const server = createHttpServer({ hub, token: TOKEN, webDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(webDir, { recursive: true, force: true });
  });
  const origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, connections: () => connected };
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
});
