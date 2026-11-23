import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RemoteAccess } from "@moonagentic/protocol";
import { MAX_IMAGE_BYTES } from "@moonagentic/protocol";
import { ArtifactLinks } from "../src/artifacts.ts";
import { Attachments } from "../src/attachments.ts";
import { COORDINATOR_PATH } from "../src/coordinator-tools.ts";
import {
  allowedWsOrigin,
  bearerToken,
  createHttpServer,
  decode,
  DEVICE_REVOKED,
  type RateLimitOptions,
  TOKEN_RENEWED,
} from "../src/http.ts";
import { Devices } from "../src/devices.ts";
import { CoordinatorRefused, type Hub } from "../src/hub.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const TOKEN = "jeton-de-test";

async function serve(
  options: {
    heartbeatMs?: number;
    maxClients?: number;
    wsTicketTtlMs?: number;
    rateLimit?: RateLimitOptions;
    devices?: Devices;
  } = {},
) {
  const webDir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-web-"));
  writeFileSync(path.join(webDir, "index.html"), "<title>MoonAgentic</title>");
  let connected = 0;
  const images = new Attachments(path.join(webDir, "..", `${path.basename(webDir)}-images`));
  const links = new ArtifactLinks(() => undefined);
  const push = { forget: vi.fn() };
  const hub = {
    attachments: images,
    artifactLinks: links,
    push,
    lockedThread: (threadId: string) => threadId === "verrouille",
    connect: () => {
      connected += 1;
      return () => undefined;
    },
    handle: async () => undefined,
    coordinatorExchange: () => {
      throw new CoordinatorRefused();
    },
    coordinatorCall: async () => {
      throw new CoordinatorRefused();
    },
  } as unknown as Hub;
  const renewed: string[] = [];
  const asked: { host: string; port: number }[] = [];
  const server = createHttpServer({
    hub,
    token: TOKEN,
    webDir,
    onTokenRenewed: (token) => renewed.push(token),
    ...options,
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
    rmSync(`${webDir}-images`, { recursive: true, force: true });
  });
  const origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ticket = async (authToken = TOKEN) => {
    const res = await fetch(`http://${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { ticket: string }).ticket;
  };
  return {
    origin,
    webDir,
    connections: () => connected,
    renewed,
    asked,
    ticket,
    images,
    links,
    push,
  };
}

/** Opens a socket and returns the HTTP status on rejection, or `"open"` on success. */
const socketStatus = (url: string, headers?: Record<string, string>) =>
  new Promise<"open" | number | "error">((resolve) => {
    const socket = new WebSocket(url, headers ? { headers } : undefined);
    socket.once("open", () => {
      socket.close();
      resolve("open");
    });
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => resolve("error"));
  });

const socketOpens = async (url: string, headers?: Record<string, string>) =>
  (await socketStatus(url, headers)) === "open";

describe("the HTTP server", () => {
  it("parses Authorization headers strictly with the Bearer prefix", () => {
    expect(bearerToken("Bearer abc-123")).toBe("abc-123");
    expect(bearerToken("abc-123")).toBeNull();
    expect(bearerToken("Basic abc-123")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("validates WebSocket Origin headers against Host", () => {
    expect(allowedWsOrigin(undefined, "127.0.0.1:4747")).toBe(true);
    expect(allowedWsOrigin("http://127.0.0.1:4747", "127.0.0.1:4747")).toBe(true);
    expect(allowedWsOrigin("https://mini.tail1234.ts.net", "mini.tail1234.ts.net")).toBe(true);
    expect(allowedWsOrigin("https://mini.tail1234.ts.net", "mini.tail1234.ts.net:443")).toBe(true);
    expect(allowedWsOrigin("http://localhost:5173", "localhost:5173")).toBe(true);
    expect(allowedWsOrigin("https://evil.example", "127.0.0.1:4747")).toBe(false);
    expect(allowedWsOrigin("http://127.0.0.1:9999", "127.0.0.1:4747")).toBe(false);
    expect(allowedWsOrigin("null", "127.0.0.1:4747")).toBe(false);
    expect(allowedWsOrigin("javascript:alert(1)", "127.0.0.1:4747")).toBe(false);
    expect(allowedWsOrigin("http://127.0.0.1:4747", undefined)).toBe(false);
  });

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
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain(`connect-src 'self' ws://${origin}`);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("lets in only who holds the Bearer token or a single-use WS ticket, and rejects ?token=", async () => {
    const { origin, connections, ticket } = await serve({ wsTicketTtlMs: 80 });
    const auth = (header: string) =>
      fetch(`http://${origin}/api/auth`, { headers: { authorization: header } });
    expect((await auth("Bearer autre")).status).toBe(401);
    // Missing Bearer prefix is refused.
    expect((await auth(TOKEN)).status).toBe(401);
    expect((await auth(`Bearer ${TOKEN}`)).status).toBe(204);

    // /api/ws-ticket requires POST and valid Bearer auth.
    expect(
      (
        await fetch(`http://${origin}/api/ws-ticket`, {
          method: "GET",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await fetch(`http://${origin}/api/ws-ticket`, {
          method: "POST",
          headers: { authorization: TOKEN },
        })
      ).status,
    ).toBe(401);

    // Master token in /ws query string is no longer accepted.
    expect(await socketStatus(`ws://${origin}/ws?token=${TOKEN}`)).toBe(401);
    expect(await socketStatus(`ws://${origin}/ws?ticket=autre`)).toBe(401);
    expect(await socketStatus(`ws://${origin}/ws`)).toBe(401);
    expect(await socketStatus(`ws://${origin}/autre?ticket=${await ticket()}`)).toBe(401);
    expect(connections()).toBe(0);

    // Single-use ticket opens once, then cannot be replayed.
    const t1 = await ticket();
    expect(await socketOpens(`ws://${origin}/ws?ticket=${t1}`)).toBe(true);
    expect(await socketStatus(`ws://${origin}/ws?ticket=${t1}`)).toBe(401);
    expect(connections()).toBe(1);

    // Expired ticket is refused.
    const expiring = await ticket();
    await new Promise((r) => setTimeout(r, 120));
    expect(await socketStatus(`ws://${origin}/ws?ticket=${expiring}`)).toBe(401);

    // Non-browser WS clients may also authenticate with an Authorization: Bearer header.
    expect(await socketOpens(`ws://${origin}/ws`, { authorization: `Bearer ${TOKEN}` })).toBe(true);
    expect(await socketStatus(`ws://${origin}/ws`, { authorization: TOKEN })).toBe(401);
    expect(connections()).toBe(2);
  });

  it("rejects cross-origin WebSocket upgrades with 403", async () => {
    const { origin, ticket } = await serve();
    expect(
      await socketStatus(`ws://${origin}/ws?ticket=${await ticket()}`, {
        origin: "https://evil.example",
      }),
    ).toBe(403);
    expect(
      await socketStatus(`ws://${origin}/ws?ticket=${await ticket()}`, { origin: "null" }),
    ).toBe(403);
    expect(
      await socketOpens(`ws://${origin}/ws?ticket=${await ticket()}`, {
        origin: `http://${origin}`,
      }),
    ).toBe(true);
  });

  it("caps simultaneous WebSocket connections with 503", async () => {
    const { origin, ticket } = await serve({ maxClients: 2 });
    const [t1, t2] = await Promise.all([ticket(), ticket()]);
    const s1 = new WebSocket(`ws://${origin}/ws?ticket=${t1}`);
    const s2 = new WebSocket(`ws://${origin}/ws?ticket=${t2}`);
    cleanups.push(() => {
      s1.terminate();
      s2.terminate();
    });
    await Promise.all([s1, s2].map((s) => new Promise((resolve) => s.once("open", resolve))));
    expect(await socketStatus(`ws://${origin}/ws?ticket=${await ticket()}`)).toBe(503);
    const closed = new Promise((resolve) => s1.once("close", resolve));
    s1.close();
    await closed;
    // Wait a tick for the server-side close handler to remove s1 from wss.clients.
    await expect
      .poll(() => ticket().then((t) => socketOpens(`ws://${origin}/ws?ticket=${t}`)))
      .toBe(true);
    s2.close();
  });

  it("rate-limits auth failures, API floods, coordinator calls and WS upgrades with 429", async () => {
    const { origin } = await serve({
      rateLimit: {
        windowMs: 60_000,
        maxAuthFailures: 2,
        maxApiRequests: 10,
        maxCoordinatorRequests: 2,
        maxWsUpgrades: 10,
      },
    });
    expect(
      (await fetch(`http://${origin}/api/auth`, { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`http://${origin}/api/auth`, { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    const blocked = await fetch(`http://${origin}/api/auth`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Shared auth-failure limiter also blocks /ws upgrades from the same IP.
    expect(await socketStatus(`ws://${origin}/ws`, { authorization: `Bearer ${TOKEN}` })).toBe(429);

    // Coordinator endpoint enforces its own per-IP cap.
    const coord = () =>
      fetch(`http://${origin}${COORDINATOR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bad" },
        body: JSON.stringify({ tool: "list_threads" }),
      });
    expect((await coord()).status).toBe(401);
    expect((await coord()).status).toBe(401);
    expect((await coord()).status).toBe(429);
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

  it("renews the token: the old one and its pending tickets stop working and connections close", async () => {
    const { origin, renewed, ticket } = await serve();
    const renew = (token: string, method = "POST") =>
      fetch(`http://${origin}/api/remote/token`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await renew("autre")).status).toBe(401);
    expect((await renew(TOKEN, "GET")).status).toBe(405);
    expect(renewed).toEqual([]);

    const pendingTicket = await ticket(TOKEN);
    const socket = new WebSocket(`ws://${origin}/ws?ticket=${await ticket(TOKEN)}`);
    await new Promise((resolve) => socket.once("open", resolve));
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));

    const response = await renew(TOKEN);
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(token).not.toBe(TOKEN);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(renewed).toEqual([token]);
    expect(await closed).toBe(TOKEN_RENEWED);

    // Tickets minted before renewal are invalidated.
    expect(await socketStatus(`ws://${origin}/ws?ticket=${pendingTicket}`)).toBe(401);
    expect(await socketOpens(`ws://${origin}/ws?ticket=${await ticket(token)}`)).toBe(true);
    expect((await renew(TOKEN)).status).toBe(401);
  });

  it("pairs a device with a one-time code: its own token works, the computer's stays", async () => {
    const devices = new Devices();
    const { origin, ticket, links, push } = await serve({ devices });
    const call = (url: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      fetch(`http://${origin}${url}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          "content-type": "application/json",
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });

    expect((await call("/api/pair/start", { method: "POST" })).status).toBe(401);
    const start = await call("/api/pair/start", { method: "POST", token: TOKEN });
    expect(start.status).toBe(200);
    const { code } = (await start.json()) as { code: string };

    const wrong = await call("/api/pair", {
      method: "POST",
      body: { code: "AAAA2222", name: "x" },
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { message: string }).message).toMatch(/expiré/);
    const pair = await call("/api/pair", { method: "POST", body: { code, name: "iPhone" } });
    expect(pair.status).toBe(200);
    const { token: phone, device } = (await pair.json()) as {
      token: string;
      device: { id: string; name: string };
    };
    expect(device.name).toBe("iPhone");
    // Used once only.
    expect((await call("/api/pair", { method: "POST", body: { code, name: "x" } })).status).toBe(
      401,
    );

    // The phone's token opens the app, but not what only the computer may do.
    expect((await call("/api/auth", { token: phone })).status).toBe(204);
    expect((await call("/api/remote", { token: phone })).status).toBe(200);
    expect((await call("/api/devices", { token: phone })).status).toBe(403);
    expect((await call("/api/pair/start", { method: "POST", token: phone })).status).toBe(403);
    expect((await call("/api/remote/token", { method: "POST", token: phone })).status).toBe(403);
    const listed = await call("/api/devices", { token: TOKEN });
    expect(((await listed.json()) as { devices: { name: string }[] }).devices).toMatchObject([
      { name: "iPhone" },
    ]);

    // Renewing the computer's token leaves the phone connected.
    const phoneSocket = new WebSocket(`ws://${origin}/ws?ticket=${await ticket(phone)}`);
    await new Promise((resolve) => phoneSocket.once("open", resolve));
    const ownerSocket = new WebSocket(`ws://${origin}/ws?ticket=${await ticket(TOKEN)}`);
    await new Promise((resolve) => ownerSocket.once("open", resolve));
    const ownerClosed = new Promise<number>((resolve) => ownerSocket.once("close", resolve));
    const forget = vi.spyOn(links, "forget");
    const renewed = await call("/api/remote/token", { method: "POST", token: TOKEN });
    const { token: owner } = (await renewed.json()) as { token: string };
    expect(await ownerClosed).toBe(TOKEN_RENEWED);
    // The computer's addresses to show artifacts stop with its old token; the phone's stay.
    const renewedWhose = forget.mock.calls.at(-1)![0];
    expect(renewedWhose(undefined)).toBe(true);
    expect(renewedWhose(device.id)).toBe(false);
    // So do the computer's browsers subscribed to Web Push: one with the old token may be a thief's.
    const pushWhose = push.forget.mock.calls.at(-1)![0] as (id: string | undefined) => boolean;
    expect(pushWhose(undefined)).toBe(true);
    expect(pushWhose(device.id)).toBe(false);
    expect(phoneSocket.readyState).toBe(WebSocket.OPEN);

    // Revoked: its connection closes, its pending ticket and token stop working.
    const pending = await ticket(phone);
    const phoneClosed = new Promise<number>((resolve) => phoneSocket.once("close", resolve));
    expect(
      (await call("/api/devices/revoke", { method: "POST", token: owner, body: { id: "nope" } }))
        .status,
    ).toBe(404);
    const revoked = await call("/api/devices/revoke", {
      method: "POST",
      token: owner,
      body: { id: device.id },
    });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { devices: unknown[] }).devices).toEqual([]);
    expect(await phoneClosed).toBe(DEVICE_REVOKED);
    // So do the phone's addresses to show artifacts, and only its.
    const revokedWhose = forget.mock.calls.at(-1)![0];
    expect(revokedWhose(device.id)).toBe(true);
    expect(revokedWhose(undefined)).toBe(false);
    expect(revokedWhose("autre")).toBe(false);
    expect(await socketStatus(`ws://${origin}/ws?ticket=${pending}`)).toBe(401);
    expect((await call("/api/auth", { token: phone })).status).toBe(401);
  });

  it("takes a pairing only as JSON from its own page, and no token is not a wrong one", async () => {
    const { origin } = await serve({ rateLimit: { maxAuthFailures: 3 } });
    // What another site open in the browser could send without asking first.
    const plain = await fetch(`http://${origin}/api/pair`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ code: "AAAA2222", name: "x" }),
    });
    expect(plain.status).toBe(415);
    const elsewhere = await fetch(`http://${origin}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://exemple.com" },
      body: JSON.stringify({ code: "AAAA2222", name: "x" }),
    });
    expect(elsewhere.status).toBe(403);
    // Requests with no token at all never lock the user out.
    for (let i = 0; i < 6; i++) {
      expect((await fetch(`http://${origin}/api/auth`)).status).toBe(401);
      expect((await fetch(`http://${origin}/api/ws-ticket`, { method: "POST" })).status).toBe(401);
    }
    expect(
      (await fetch(`http://${origin}/api/auth`, { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(204);
    expect(
      (
        await fetch(`http://${origin}/api/devices/revoke`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(405);
  });

  it("counts wrong pairing codes as failed sign-ins", async () => {
    const { origin } = await serve({ rateLimit: { maxAuthFailures: 3 } });
    const pair = () =>
      fetch(`http://${origin}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "AAAA2222", name: "x" }),
      });
    for (let i = 0; i < 3; i++) expect((await pair()).status).toBe(401);
    expect((await pair()).status).toBe(429);
    expect(
      (await fetch(`http://${origin}/api/pair`, { method: "POST", body: "pas du json" })).status,
    ).toBe(429);
  });

  it("takes an image only from who holds the token, and reads it back by its thread", async () => {
    const { origin, images } = await serve();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const post = (body: Buffer, authToken = TOKEN, name = "capture d'écran.png") =>
      fetch(`http://${origin}/api/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
        },
        body,
      });
    const auth = { authorization: `Bearer ${TOKEN}` };

    expect((await post(png, "autre-jeton")).status).toBe(401);
    expect(
      (await fetch(`http://${origin}/api/attachments`, { method: "POST", body: png })).status,
    ).toBe(401);
    // What the sender calls it does not make it an image.
    const script = await post(Buffer.from("<script>alert(1)</script>"), TOKEN, "photo.png");
    expect(script.status).toBe(415);
    expect(((await script.json()) as { message: string }).message).toContain("PNG, JPEG");
    const heavy = await post(Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]));
    expect(heavy.status).toBe(413);
    // The reason is read, not a connection cut while the image was still being sent.
    expect(((await heavy.json()) as { message: string }).message).toContain("10 Mo");

    const taken = await post(png);
    expect(taken.status).toBe(201);
    const image = (await taken.json()) as { id: string; name: string; mime: string; size: number };
    expect(image).toMatchObject({ name: "capture d'écran.png", mime: "image/png", size: 12 });

    // Until its message is sent, it belongs to no thread: nothing reads it.
    const address = (thread: string, id = image.id) =>
      `http://${origin}/api/attachments/${thread}/${id}`;
    expect((await fetch(address("fil-1"), { headers: auth })).status).toBe(404);
    images.bind("fil-1", [image.id]);
    expect((await fetch(address("fil-1"))).status).toBe(401);
    expect((await fetch(address("fil-2"), { headers: auth })).status).toBe(404);
    expect(
      (await fetch(address("fil-1", "..%2F..%2Fstate.sqlite"), { headers: auth })).status,
    ).toBe(404);
    const read = await fetch(address("fil-1"), { headers: auth });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(read.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(png);
    // A locked project's thread shows none of its images.
    const hidden = ((await (await post(png)).json()) as { id: string }).id;
    images.bind("verrouille", [hidden]);
    expect(images.find("verrouille", hidden)).toBeDefined();
    expect((await fetch(address("verrouille", hidden), { headers: auth })).status).toBe(404);
    // Gone between the look and the read, as when its thread is deleted: not there, said so.
    const found = images.find("fil-1", image.id)!;
    vi.spyOn(images, "find").mockReturnValueOnce({ ...found, file: `${found.file}.parti` });
    expect((await fetch(address("fil-1"), { headers: auth })).status).toBe(404);

    // Taken off before sending: thrown away. One already sent stays its thread's.
    const dropped = (await (await post(png)).json()) as { id: string };
    const drop = (id: string, headers: Record<string, string> = auth) =>
      fetch(`http://${origin}/api/attachments/${id}`, { method: "DELETE", headers });
    expect((await drop(dropped.id, {})).status).toBe(401);
    expect((await drop(dropped.id)).status).toBe(204);
    expect(() => images.bind("fil-1", [dropped.id])).toThrow("n'est plus là");
    expect((await drop(image.id)).status).toBe(204);
    expect((await fetch(address("fil-1"), { headers: auth })).status).toBe(200);
    expect((await fetch(`http://${origin}/api/attachments`, { headers: auth })).status).toBe(405);

    // A sender that gives no length is stopped as soon as it has sent too much.
    const [host, port] = origin.split(":") as [string, string];
    const endless = await new Promise<number>((resolve) => {
      const req = request(
        { host, port: Number(port), path: "/api/attachments", method: "POST", headers: auth },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => undefined);
      const megabyte = Buffer.alloc(1024 * 1024);
      req.write(png);
      for (let n = 0; n <= MAX_IMAGE_BYTES / megabyte.length; n++) req.write(megabyte);
    });
    expect(endless).toBe(413);
  });

  it("takes a message without text only when images come with it", () => {
    const send = (more: object) =>
      decode(JSON.stringify({ type: "thread.send", threadId: "fil-1", ...more }));
    expect(send({ text: "Bonjour" })).toHaveProperty("message");
    expect(send({ text: "" })).toHaveProperty("error");
    expect(send({ text: "  ", attachments: [] })).toHaveProperty("error");
    expect(send({ text: "", attachments: ["image-1"] })).toHaveProperty("message");
    const tooMany = Array.from({ length: 9 }, (_, n) => `image-${n}`);
    expect(send({ text: "Regarde", attachments: tooMany })).toHaveProperty("error");
  });

  it("closes a connection that stops answering pings, and keeps one that answers", async () => {
    const { origin, ticket } = await serve({ heartbeatMs: 60 });
    const [t1, t2] = await Promise.all([ticket(), ticket()]);
    // As a phone gone out of reach: the connection is there, nothing answers.
    const gone = new WebSocket(`ws://${origin}/ws?ticket=${t1}`, { autoPong: false });
    const here = new WebSocket(`ws://${origin}/ws?ticket=${t2}`);
    cleanups.push(() => {
      gone.terminate();
      here.terminate();
    });
    await Promise.all([gone, here].map((s) => new Promise((resolve) => s.once("open", resolve))));
    const started = Date.now();
    await new Promise((resolve) => gone.once("close", resolve));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(here.readyState).toBe(WebSocket.OPEN);
    here.close();
  });
});
