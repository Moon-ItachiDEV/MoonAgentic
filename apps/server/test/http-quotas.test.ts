// Audit of 2026-11-25, N8 and N17: what one page, one name or one device does to the quotas
// and places the others count on, and a connection that no longer reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RemoteAccess, Workspace } from "@moonagentic/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ArtifactLinks } from "../src/artifacts.ts";
import { Attachments } from "../src/attachments.ts";
import { Devices } from "../src/devices.ts";
import { allowedHost, createHttpServer, MAX_WS_PER_DEVICE, sendOrCut } from "../src/http.ts";
import { CoordinatorRefused, type Hub } from "../src/hub.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  // The latest first: the connections a test holds close before its server.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TOKEN = "jeton-du-proprietaire-quotas";

async function serve(onConnect: (client: { send: (m: unknown) => void }) => () => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-quotas-"));
  const webDir = path.join(root, "web");
  const folder = path.join(root, "fil");
  mkdirSync(webDir);
  mkdirSync(folder);
  writeFileSync(path.join(webDir, "index.html"), "<title>MoonAgentic</title>");
  writeFileSync(path.join(folder, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const workspace = { path: folder, branch: "main", isolated: false } as unknown as Workspace;
  const links = new ArtifactLinks(() => workspace);
  const hub = {
    attachments: new Attachments(path.join(root, "images")),
    artifactLinks: links,
    push: { forget: vi.fn() },
    lockedThread: () => false,
    connect: onConnect,
    handle: async () => undefined,
    coordinatorExchange: () => {
      throw new CoordinatorRefused();
    },
    coordinatorCall: async () => {
      throw new CoordinatorRefused();
    },
  } as unknown as Hub;
  const server = createHttpServer({
    hub,
    token: TOKEN,
    webDir,
    devices: new Devices(),
    rateLimit: { maxApiRequests: 50 },
    remoteAccess: async (_h, port): Promise<RemoteAccess> => ({
      port,
      exposed: false,
      tailscale: "absent",
      addresses: [],
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `127.0.0.1:${port}`;
  const status = (url: string, init?: RequestInit) =>
    fetch(`http://${origin}${url}`, init).then(async (r) => {
      await r.body?.cancel();
      return r.status;
    });
  const ticket = async (token = TOKEN) => {
    const res = await fetch(`http://${origin}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    return res.status === 200 ? ((await res.json()) as { ticket: string }).ticket : res.status;
  };
  const pair = async () => {
    const start = await fetch(`http://${origin}/api/pair/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { code } = (await start.json()) as { code: string };
    const res = await fetch(`http://${origin}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "iPhone" }),
    });
    return ((await res.json()) as { token: string }).token;
  };
  const image = path.join(folder, "image.png");
  return { origin, port, links, image, status, ticket, pair };
}

const open = (url: string) =>
  new Promise<WebSocket | number>((resolve) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(-1));
  });

describe("the quota of artifacts (N8)", () => {
  it("serves a page's many images without taking the next connection's ticket", async () => {
    const { links, image, status, ticket } = await serve(() => () => undefined);
    const { ticket: link } = links.issueFile("fil", image);
    for (let i = 0; i < 120; i++)
      expect(await status(`/api/artifacts/${link}/image.png`)).toBe(200);
    // Above the 50 requests the test gives the rest: still a ticket for the next connection.
    expect(typeof (await ticket())).toBe("string");
  });

  it("counts nothing for an address never given", async () => {
    const { status, ticket } = await serve(() => () => undefined);
    const other = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" };
    for (let i = 0; i < 120; i++)
      expect(await status(`/api/artifacts/x${i}/y.png`, { headers: other })).toBe(404);
    expect(typeof (await ticket())).toBe("string");
  });
});

describe("the name a request is sent to (N8)", () => {
  it("takes the names of this server, and no other", () => {
    for (const host of [
      "127.0.0.1:4747",
      "[::1]:4747",
      "localhost:4747",
      "app.localhost",
      "192.168.1.20:4747",
      "nucbox-k12.tailff7a09.ts.net",
      "nucbox-k12",
      "NucBox-K12.home",
    ])
      expect(allowedHost(host, "nucbox-k12", ""), host).toBe(true);
    for (const host of ["attaquant.example:4747", "evil.ts.net.example", "nucbox-k12x.example"])
      expect(allowedHost(host, "nucbox-k12", ""), host).toBe(false);
    expect(allowedHost("moon.maison.lan", "pc", "moon.maison.lan")).toBe(true);
    expect(allowedHost("a.maison.lan", "pc", ".maison.lan")).toBe(true);
  });

  it("takes the machine's name under a local suffix only, not under any domain", () => {
    // A public domain made of the machine's name: its owner could point it at this machine.
    for (const host of ["nucbox-k12.attacker.com:4747", "nucbox-k12.example", "pc.evil.io"])
      expect(allowedHost(host, host.startsWith("pc") ? "pc" : "nucbox-k12", ""), host).toBe(false);
    for (const host of [
      "nucbox-k12.local",
      "nucbox-k12.lan",
      "nucbox-k12.home",
      "nucbox-k12.home.arpa",
      "nucbox-k12.internal:4747",
    ])
      expect(allowedHost(host, "nucbox-k12", ""), host).toBe(true);
    // On a Mac the machine's name already ends in .local.
    expect(allowedHost("macbook.local:4747", "MacBook.local", "")).toBe(true);
    expect(allowedHost("macbook.lan", "MacBook.local", "")).toBe(true);
    expect(allowedHost("macbook.attacker.com", "MacBook.local", "")).toBe(false);
  });

  it("takes a name alone, not one with a user, a path, a query or a fragment", () => {
    for (const host of [
      "evil.com@localhost:4747",
      "localhost/evil",
      "localhost?x=1",
      "localhost#x",
      "a:b@127.0.0.1",
    ])
      expect(allowedHost(host, "nucbox-k12", ""), host).toBe(false);
  });

  it("answers nothing to a page whose name was pointed at this machine", async () => {
    const { port, status } = await serve(() => () => undefined);
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) {
      codes.push(
        await new Promise<number>((resolve) => {
          const req = request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/pair",
              method: "POST",
              headers: {
                host: `attaquant.example:${port}`,
                "content-type": "application/json",
              },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.end(JSON.stringify({ code: "AAAA2222", name: "x" }));
        }),
      );
    }
    expect(new Set(codes)).toEqual(new Set([421]));
    // Its wrong codes were never counted: the computer is let in.
    expect(await status("/api/auth", { headers: { authorization: `Bearer ${TOKEN}` } })).toBe(204);
  });
});

describe("the WebSocket places (N17)", () => {
  it("leaves the computer its places when a device opened all of its own", async () => {
    const { origin, ticket, pair } = await serve(() => () => undefined);
    const phone = await pair();
    const held: WebSocket[] = [];
    cleanups.push(() => {
      for (const ws of held) ws.terminate();
    });
    for (let i = 0; i < MAX_WS_PER_DEVICE + 4; i++) {
      const ws = await open(`ws://${origin}/ws?ticket=${await ticket(phone)}`);
      if (typeof ws !== "number") held.push(ws);
    }
    expect(held).toHaveLength(MAX_WS_PER_DEVICE);
    const computer = await open(`ws://${origin}/ws?ticket=${await ticket()}`);
    expect(typeof computer).not.toBe("number");
    if (typeof computer !== "number") computer.terminate();
    // One closed, the device has a place again.
    held.pop()!.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = await open(`ws://${origin}/ws?ticket=${await ticket(phone)}`);
    expect(typeof again).not.toBe("number");
    if (typeof again !== "number") held.push(again);
  });

  it("cuts a connection that no longer reads, before it holds 100 MB", async () => {
    let client: { send: (m: unknown) => void } | undefined;
    let cut = false;
    const { origin, ticket } = await serve((c) => {
      client = c;
      return () => void (cut = true);
    });
    const ws = new WebSocket(`ws://${origin}/ws?ticket=${await ticket()}`);
    await new Promise((resolve) => ws.once("open", resolve));
    cleanups.push(() => ws.terminate());
    // As an iPhone asleep: the connection stays, nothing is read from it any more.
    (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const chunk = { type: "item", threadId: "t", item: { text: "x".repeat(1024 * 1024) } };
    for (let i = 0; i < 100 && !cut; i++) {
      client!.send(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cut).toBe(true);
  });
  it("cuts at once a connection a single message leaves over its limit", () => {
    // How much the system takes before Node holds anything differs (Windows took 8 MB at once):
    // a connection whose buffer grows by what is sent stands for one that no longer reads.
    const ws = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      cut: false,
      send(data: string) {
        this.bufferedAmount += data.length;
      },
      terminate() {
        this.cut = true;
      },
    };
    sendOrCut(ws, "x".repeat(1024), 64 * 1024);
    expect(ws.cut).toBe(false);
    // One message far over the limit, and none after it.
    sendOrCut(ws, "x".repeat(8 * 1024 * 1024), 64 * 1024);
    expect(ws.cut).toBe(true);
  });
});
