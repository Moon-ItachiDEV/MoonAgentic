import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
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
  pickEncoding,
  rateKey,
  type RateLimitOptions,
  TOKEN_RENEWED,
} from "../src/http.ts";
import { Devices } from "../src/devices.ts";
import { Store } from "../src/store.ts";
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
    handle?: Hub["handle"];
  } = {},
) {
  const webDir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-web-"));
  writeFileSync(path.join(webDir, "index.html"), "<title>MoonAgentic</title>");
  let connected = 0;
  const images = new Attachments(path.join(webDir, "..", `${path.basename(webDir)}-images`));
  const links = new ArtifactLinks(() => undefined);
  const push = { forget: vi.fn() };
  const storageFailed = vi.fn();
  const hub = {
    attachments: images,
    storageFailed,
    artifactLinks: links,
    push,
    lockedThread: (threadId: string) => threadId === "verrouille",
    connect: () => {
      connected += 1;
      return () => undefined;
    },
    handle: options.handle ?? (async () => undefined),
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
    storageFailed,
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
    expect(kept.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // Only the built files are strict: an app route still gets the page.
    expect((await fetch(`http://${origin}/assets-du-projet`)).status).toBe(200);
    // So is a file at the root, such as an icon an iPhone looks for by itself.
    expect((await fetch(`http://${origin}/apple-touch-icon-precomposed.png`)).status).toBe(404);
    expect((await fetch(`http://${origin}/favicon.ico?v=2`)).status).toBe(404);
    expect((await fetch(`http://${origin}/reglages`)).status).toBe(200);
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
    expect(read.headers.get("cache-control")).toBe("private, no-store");
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

  // Audit of 2026-11-25, N25: a request for a ticket may go on a connection that died too.
  it("gives each connection the single-use ticket of the one that replaces it", async () => {
    const { origin, ticket } = await serve({ heartbeatMs: 200 });
    const spares = (socket: WebSocket) => {
      const given: { ticket: string; ttlMs: number }[] = [];
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as { type: string; ticket: string; ttlMs: number };
        if (message.type === "ws.ticket") given.push(message);
      });
      return given;
    };
    const first = new WebSocket(`ws://${origin}/ws?ticket=${await ticket()}`);
    cleanups.push(() => first.terminate());
    const given = spares(first);
    await expect.poll(() => given.length).toBe(1);
    expect(given[0]!.ttlMs).toBe(400);
    // Renewed with each heartbeat, one at a time: the one before no longer opens.
    await expect.poll(() => given.length).toBe(2);
    expect(await socketStatus(`ws://${origin}/ws?ticket=${given[0]!.ticket}`)).toBe(401);
    // Its connection gone, the last one still opens the next, once.
    first.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const spare = given.at(-1)!.ticket;
    expect(await socketOpens(`ws://${origin}/ws?ticket=${spare}`)).toBe(true);
    expect(await socketStatus(`ws://${origin}/ws?ticket=${spare}`)).toBe(401);
  });

  it("keeps a silent socket's spare ticket alive across a missed heartbeat and ignores unsolicited pongs", async () => {
    const { origin, ticket } = await serve({ heartbeatMs: 300 });
    const silent = new WebSocket(`ws://${origin}/ws?ticket=${await ticket()}`, { autoPong: false });
    cleanups.unshift(() => silent.terminate());
    const given: string[] = [];
    silent.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { type: string; ticket?: string };
      if (msg.type === "ws.ticket" && msg.ticket) given.push(msg.ticket);
    });
    await expect.poll(() => given.length).toBe(1);
    const firstTicket = given[0]!;

    // An unsolicited pong while already alive does not rotate the spare ticket.
    silent.pong();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(given).toEqual([firstTicket]);

    // After one missed heartbeat (still within 2 * heartbeatMs TTL), the last ticket received stays valid.
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(given).toEqual([firstTicket]);
    expect(await socketOpens(`ws://${origin}/ws?ticket=${firstTicket}`)).toBe(true);
    silent.terminate();
  });

  it("invalidates old owner spare tickets immediately on token renewal without minting new ones", async () => {
    const { origin, ticket } = await serve({ heartbeatMs: 40 });
    const oldSocket = new WebSocket(`ws://${origin}/ws?ticket=${await ticket()}`);
    cleanups.unshift(() => oldSocket.terminate());
    const tickets: string[] = [];
    oldSocket.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { type: string; ticket?: string };
      if (msg.type === "ws.ticket" && msg.ticket) tickets.push(msg.ticket);
    });
    const closed = new Promise<number>((resolve) => oldSocket.once("close", resolve));
    await expect.poll(() => tickets.length).toBeGreaterThanOrEqual(1);

    const res = await fetch(`http://${origin}/api/remote/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await closed).toBe(TOKEN_RENEWED);
    for (const oldTicket of tickets) {
      expect(await socketStatus(`ws://${origin}/ws?ticket=${oldTicket}`)).toBe(401);
    }
  });

  it("delivers an ordered action's error before a pipelined ping's pong, and runs setArchived before send", async () => {
    let archived = true;
    const order: string[] = [];
    const { origin, ticket } = await serve({
      handle: async (client, message) => {
        if (message.type === "ping") {
          client.send({ type: "pong" });
          return;
        }
        if (message.type === "thread.setArchived") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          archived = message.archived;
          order.push(`archived:${String(archived)}`);
          return;
        }
        if (message.type === "thread.send") {
          if (message.text === "boom") throw new Error("Disque plein");
          if (archived) throw new Error("Ce fil est résolu.");
          order.push(`send:${message.text}`);
        }
      },
    });
    const ws = new WebSocket(`ws://${origin}/ws?ticket=${await ticket()}`);
    cleanups.unshift(() => ws.terminate());
    const received: { type: string; message?: string }[] = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { type: string; message?: string };
      if (msg.type !== "ws.ticket") received.push(msg);
    });
    await new Promise((resolve) => ws.once("open", resolve));

    // A failing send followed immediately by ping must report the error before the pong.
    ws.send(JSON.stringify({ type: "thread.send", threadId: "t1", text: "boom", sendId: "s-1" }));
    ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => received.length).toBe(2);
    expect(received.map((m) => m.type)).toEqual(["error", "pong"]);
    expect(received[0]!.message).toBe("Disque plein");

    // Pipelined async unarchive + send + ping must complete unarchive before send and pong last.
    received.length = 0;
    ws.send(
      JSON.stringify({
        type: "thread.setArchived",
        threadId: "t1",
        archived: false,
        sendId: "s-2",
      }),
    );
    ws.send(JSON.stringify({ type: "thread.send", threadId: "t1", text: "ok", sendId: "s-3" }));
    ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => received.length).toBe(1);
    expect(received.map((m) => m.type)).toEqual(["pong"]);
    expect(order).toEqual(["archived:false", "send:ok"]);
    ws.terminate();
  });

  it("validates sendId characters and accepts sendId on setArchived, cancel, and resume", () => {
    expect(
      decode(
        JSON.stringify({
          type: "thread.setArchived",
          threadId: "t1",
          archived: false,
          sendId: "ok_1-a",
        }),
      ),
    ).toHaveProperty("message");
    expect(
      decode(JSON.stringify({ type: "thread.cancel", threadId: "t1", sendId: "ok-2" })),
    ).toHaveProperty("message");
    expect(
      decode(JSON.stringify({ type: "thread.resume", threadId: "t1", sendId: "ok-3" })),
    ).toHaveProperty("message");
    expect(
      decode(JSON.stringify({ type: "thread.send", threadId: "t1", text: "hi", sendId: "bad:id" })),
    ).toHaveProperty("error");
    expect(
      decode(JSON.stringify({ type: "thread.send", threadId: "t1", text: "hi", sendId: "bad id" })),
    ).toHaveProperty("error");
  });

  it("survives overlong paths without crashing and rejects non-GET/HEAD on static files and /api/build", async () => {
    const { origin, images } = await serve();
    const longPath = await fetch(`http://${origin}/${"a".repeat(350)}`);
    if (process.platform === "win32") expect([200, 400]).toContain(longPath.status);
    else expect(longPath.status).toBe(400);

    // Non-read methods on static files and /api/build are refused with 405; HEAD returns headers only.
    expect((await fetch(`http://${origin}/index.html`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`http://${origin}/index.html`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`http://${origin}/api/build`, { method: "POST" })).status).toBe(405);
    const headPage = await fetch(`http://${origin}/index.html`, { method: "HEAD" });
    expect(headPage.status).toBe(200);
    expect(await headPage.text()).toBe("");
    const headBuild = await fetch(`http://${origin}/api/build`, { method: "HEAD" });
    expect(headBuild.status).toBe(200);
    expect(await headBuild.text()).toBe("");

    // An unexpected synchronous error inside a route answers 500 instead of stopping the server.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(images, "find").mockImplementationOnce(() => {
      throw new Error("panne inattendue");
    });
    const boom = await fetch(`http://${origin}/api/attachments/fil-1/img-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(boom.status).toBe(500);
    spy.mockRestore();

    // The server is still alive and serves normal requests.
    const page = await fetch(`http://${origin}/t/apres-erreur`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("MoonAgentic");
  });

  it("derives rate-limit keys per forwarded client on loopback and ignores X-Forwarded-For from non-loopback", () => {
    const fakeReq = (remoteAddress: string | undefined, xff?: string | string[]) => ({
      socket: { remoteAddress } as never,
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    });
    expect(rateKey(fakeReq("127.0.0.1"))).toBe("local");
    expect(rateKey(fakeReq("::1"))).toBe("local");
    expect(rateKey(fakeReq("127.0.0.1", "100.64.0.9"))).toBe("forwarded:100.64.0.9");
    expect(rateKey(fakeReq("127.0.0.1", "1.2.3.4, 100.64.0.9"))).toBe("forwarded:100.64.0.9");
    expect(rateKey(fakeReq("127.0.0.1", "100.64.0.9, "))).toBe("forwarded:100.64.0.9");
    expect(rateKey(fakeReq("127.0.0.1", ["1.2.3.4", "100.64.0.9"]))).toBe("forwarded:100.64.0.9");
    // Direct LAN clients cannot spoof X-Forwarded-For to evade rate limits.
    expect(rateKey(fakeReq("192.168.1.42", "100.64.0.9"))).toBe("192.168.1.42");
  });

  it("isolates a remote device behind a loopback proxy from locking out the computer or other devices", async () => {
    const { origin } = await serve({
      rateLimit: { windowMs: 60_000, maxAuthFailures: 3, maxApiRequests: 10 },
    });
    const badPair = (xff: string) =>
      fetch(`http://${origin}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff },
        body: JSON.stringify({ code: "AAAA2222", name: "intrus" }),
      });
    for (let i = 0; i < 3; i++) expect((await badPair("100.64.0.9")).status).toBe(401);
    expect((await badPair("100.64.0.9")).status).toBe(429);
    // The abusive remote device is blocked on /api/auth and /ws.
    expect(
      (
        await fetch(`http://${origin}/api/auth`, {
          headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "100.64.0.9" },
        })
      ).status,
    ).toBe(429);
    expect(
      await socketStatus(`ws://${origin}/ws`, {
        authorization: `Bearer ${TOKEN}`,
        "x-forwarded-for": "100.64.0.9",
      }),
    ).toBe(429);

    // The local computer (no X-Forwarded-For) and another remote device stay unaffected.
    expect(
      (await fetch(`http://${origin}/api/auth`, { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(204);
    expect(await socketOpens(`ws://${origin}/ws`, { authorization: `Bearer ${TOKEN}` })).toBe(true);
    expect(
      (
        await fetch(`http://${origin}/api/auth`, {
          headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "100.64.0.10" },
        })
      ).status,
    ).toBe(204);
  });

  it("does not let cross-site or unauthenticated floods exhaust the local API rate limit", async () => {
    const { origin } = await serve({
      rateLimit: { windowMs: 60_000, maxAuthFailures: 3, maxApiRequests: 4 },
    });
    // Cross-origin and unauthenticated requests exceed maxApiRequests without consuming the local bucket.
    for (let i = 0; i < 8; i++) {
      expect(
        (
          await fetch(`http://${origin}/api/auth`, {
            headers: { origin: "https://evil.example", authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`http://${origin}/api/auth`, {
            headers: { "sec-fetch-site": "cross-site", authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(403);
      expect((await fetch(`http://${origin}/api/auth`)).status).toBe(401);
      expect(
        (
          await fetch(`http://${origin}/api/pair`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://evil.example" },
            body: JSON.stringify({ code: "AAAA2222", name: "x" }),
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await fetch(`http://${origin}/api/auth`, { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(204);
  });
});

describe("a database that refuses a write behind a route", () => {
  /** A real database, held by another program: its writes are refused at once. */
  const heldStore = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-http-db-"));
    const file = path.join(dir, "state.sqlite");
    const store = new Store(file);
    store.waitOnHold(false);
    let other: DatabaseSync | undefined;
    cleanups.push(() => {
      other?.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return {
      file,
      store,
      hold: () => {
        other = new DatabaseSync(file);
        other.exec("BEGIN IMMEDIATE");
      },
      release: () => {
        other?.exec("ROLLBACK");
        other?.close();
        other = undefined;
      },
    };
  };
  const caller =
    (origin: string) =>
    (url: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      fetch(`http://${origin}${url}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          "content-type": "application/json",
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        // On main this request was never answered.
        signal: AbortSignal.timeout(5_000),
      });

  it("answers a revocation it could not write, and keeps the device as the database does", async () => {
    const db = heldStore();
    const devices = new Devices(db.store);
    const { origin, storageFailed } = await serve({ devices });
    const call = caller(origin);
    const { code } = (await (
      await call("/api/pair/start", { method: "POST", token: TOKEN })
    ).json()) as { code: string };
    const paired = await call("/api/pair", { method: "POST", body: { code, name: "iPhone" } });
    const { token: phone, device } = (await paired.json()) as {
      token: string;
      device: { id: string };
    };

    db.hold();
    const refused = await call("/api/devices/revoke", {
      method: "POST",
      token: TOKEN,
      body: { id: device.id },
    });
    db.release();

    expect(refused.status).toBe(500);
    expect(((await refused.json()) as { message: string }).message).toBe(
      "Base verrouillée par un autre programme : rien n'a été enregistré.",
    );
    expect(storageFailed).toHaveBeenCalled();
    // Still paired, here as in the database: it does not come back at the next start
    // after the computer was told it was gone.
    expect((await call("/api/auth", { token: phone })).status).toBe(204);
    expect(new Devices(db.store).list().map((d) => d.id)).toEqual([device.id]);
    // Once the database writes again, the revocation goes through.
    const revoked = await call("/api/devices/revoke", {
      method: "POST",
      token: TOKEN,
      body: { id: device.id },
    });
    expect(revoked.status).toBe(200);
    expect(new Devices(db.store).list()).toEqual([]);
  });

  it("gives the new token even when forgetting the old one's notifications is refused", async () => {
    const { origin, push, renewed } = await serve();
    push.forget.mockImplementation(() => {
      const failure = new Error("database is locked") as Error & { code: string; errcode: number };
      failure.code = "ERR_SQLITE_ERROR";
      failure.errcode = 5;
      throw failure;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const answer = await caller(origin)("/api/remote/token", { method: "POST", token: TOKEN });

    // The new token is the one in use from here: without it, the window that asked is locked out.
    expect(answer.status).toBe(200);
    const { token } = (await answer.json()) as { token: string };
    expect(renewed).toEqual([token]);
    expect((await caller(origin)("/api/auth", { token })).status).toBe(204);
  });

  it("still lets a paired device in when noting when it was last seen is refused", async () => {
    const db = heldStore();
    let now = 1_000;
    const devices = new Devices(db.store, () => now);
    const { origin } = await serve({ devices });
    const call = caller(origin);
    const { code } = (await (
      await call("/api/pair/start", { method: "POST", token: TOKEN })
    ).json()) as { code: string };
    const { token: phone } = (await (
      await call("/api/pair", { method: "POST", body: { code, name: "iPhone" } })
    ).json()) as { token: string };

    now += 24 * 3_600_000;
    db.hold();
    const ticket = await call("/api/ws-ticket", { method: "POST", token: phone });
    db.release();

    expect(ticket.status).toBe(200);
  });
});

describe("compression HTTP et WebSocket", () => {
  it("picks the right content-encoding from Accept-Encoding quality weights", () => {
    expect(pickEncoding(undefined)).toBeUndefined();
    expect(pickEncoding("identity")).toBeUndefined();
    expect(pickEncoding("gzip, deflate, br")).toBe("br");
    expect(pickEncoding("gzip, deflate")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0.4, gzip;q=0.9")).toBe("gzip");
    expect(pickEncoding("br;q=0, *;q=1")).toBe("gzip");
    expect(pickEncoding("*;q=0")).toBeUndefined();
    expect(pickEncoding("br;q=0, gzip;q=0")).toBeUndefined();
    expect(pickEncoding("br;q=2, gzip;q=0.5")).toBe("gzip");
  });

  const rawGet = (
    origin: string,
    pathname: string,
    headers: Record<string, string> = {},
    method: "GET" | "HEAD" = "GET",
  ) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }>((resolve, reject) => {
      const req = request(`http://${origin}${pathname}`, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });

  it("compresses text assets with br/gzip, caches immutable hits, respects HEAD, and skips fonts", async () => {
    const { origin, webDir } = await serve();
    mkdirSync(path.join(webDir, "assets"), { recursive: true });
    const jsBody = `export const payload = ${JSON.stringify("MoonAgentic ".repeat(400))};\n`;
    const jsPath = path.join(webDir, "assets", "app-abc123.js");
    const fontBody = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);
    writeFileSync(jsPath, jsBody);
    writeFileSync(path.join(webDir, "assets", "font-xyz.woff2"), fontBody);

    // First Brotli request streams & populates immutable cache
    const br1 = await rawGet(origin, "/assets/app-abc123.js", { "accept-encoding": "gzip, br" });
    expect(br1.status).toBe(200);
    expect(br1.headers["content-encoding"]).toBe("br");
    expect(br1.headers["vary"]).toBe("Accept-Encoding");
    expect(br1.body.byteLength).toBeLessThan(jsBody.length / 4);
    expect(brotliDecompressSync(br1.body).toString("utf8")).toBe(jsBody);

    // Second Brotli request hits memory cache and includes exact compressed content-length
    const br2 = await rawGet(origin, "/assets/app-abc123.js", { "accept-encoding": "br" });
    expect(br2.status).toBe(200);
    expect(br2.headers["content-encoding"]).toBe("br");
    expect(Number(br2.headers["content-length"])).toBe(br2.body.byteLength);
    expect(brotliDecompressSync(br2.body).toString("utf8")).toBe(jsBody);

    // Gzip fallback
    const gz = await rawGet(origin, "/assets/app-abc123.js", { "accept-encoding": "gzip" });
    expect(gz.status).toBe(200);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).toString("utf8")).toBe(jsBody);

    // Explicit refusal keeps Vary header and sends raw bytes
    const raw = await rawGet(origin, "/assets/app-abc123.js", {
      "accept-encoding": "br;q=0, gzip;q=0",
    });
    expect(raw.status).toBe(200);
    expect(raw.headers["content-encoding"]).toBeUndefined();
    expect(raw.headers["vary"]).toBe("Accept-Encoding");
    expect(raw.body.toString("utf8")).toBe(jsBody);

    // HEAD returns headers with empty body
    const head = await rawGet(origin, "/assets/app-abc123.js", { "accept-encoding": "br" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("br");
    expect(head.body.byteLength).toBe(0);

    // Already-compressed binary font is served untouched
    const font = await rawGet(origin, "/assets/font-xyz.woff2", { "accept-encoding": "br, gzip" });
    expect(font.status).toBe(200);
    expect(font.headers["content-encoding"]).toBeUndefined();
    expect(font.body.equals(fontBody)).toBe(true);

    // Updating the asset invalidates the mtime:size cache key
    const updatedJs = `export const payload = "updated";\n`;
    writeFileSync(jsPath, updatedJs);
    const future = new Date(Date.now() + 5_000);
    utimesSync(jsPath, future, future);
    const br3 = await rawGet(origin, "/assets/app-abc123.js", { "accept-encoding": "br" });
    expect(brotliDecompressSync(br3.body).toString("utf8")).toBe(updatedJs);
  });

  it("negotiates WebSocket perMessageDeflate while still enforcing maxPayload on inflated frames", async () => {
    const { origin } = await serve();
    const wsUrl = `ws://${origin}/ws`;

    // Negotiates permessage-deflate when offered by the client
    const negotiated = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${TOKEN}` },
        perMessageDeflate: true,
      });
      ws.on("upgrade", (res) => resolve(String(res.headers["sec-websocket-extensions"] ?? "")));
      ws.on("open", () => ws.close());
      ws.on("error", reject);
    });
    expect(negotiated).toContain("permessage-deflate");

    // A highly compressible >1 MB frame is still rejected with 1009 (Message Too Big)
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${TOKEN}` },
        perMessageDeflate: true,
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping", pad: "a".repeat(1_200_000) }));
      });
      ws.on("close", (code) => resolve(code));
      ws.on("error", reject);
    });
    expect(closeCode).toBe(1009);
  });
});
