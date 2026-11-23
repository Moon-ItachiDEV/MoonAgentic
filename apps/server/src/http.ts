import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { ClientMessage, type RemoteAccess, type ServerMessage } from "@moonagentic/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { COORDINATOR_PATH } from "./coordinator-tools.ts";
import { type Client, CoordinatorRefused, type Hub } from "./hub.ts";
import { findRemoteAccess } from "./remote.ts";

/** How often each connection is pinged. */
const HEARTBEAT_MS = 30_000;
/** Default ceiling on simultaneous WebSocket clients. */
export const MAX_WS_CLIENTS = 64;
/** Lifetime of a single-use WebSocket upgrade ticket returned by `POST /api/ws-ticket`. */
export const WS_TICKET_TTL_MS = 30_000;
const MAX_WS_TICKETS = 256;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_AUTH_FAILURES = 20;
const DEFAULT_MAX_API_REQUESTS = 240;
const DEFAULT_MAX_COORDINATOR_REQUESTS = 120;
const DEFAULT_MAX_WS_UPGRADES = 120;

/** A fresh access token: long enough that it cannot be guessed. */
export const newToken = () => randomBytes(24).toString("base64url");
/** Why a connection is closed when the token it came in with is replaced. */
export const TOKEN_RENEWED = 4001;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Where a request from this very machine comes from. */
const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** A coordinator's call is a tool name and a brief: never large. */
const MAX_COORDINATOR_BODY = 256 * 1024;

/** Extracts the credential from a strict `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? null;
}

const sameToken = (given: string | null, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw, "http://localhost");
  } catch {
    return undefined;
  }
};

/**
 * Validates the `Origin` header on a WebSocket upgrade against the request's `Host`, blocking
 * cross-site WebSocket hijacking (CSWSH) from other web pages. Requests without an `Origin`
 * header (non-browser clients) are allowed and still require authentication.
 */
export function allowedWsOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
): boolean {
  if (originHeader === undefined) return true;
  if (!hostHeader) return false;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  let target: URL;
  try {
    target = new URL(`${origin.protocol}//${hostHeader}`);
  } catch {
    return false;
  }
  if (
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    return false;
  }
  return origin.host.toLowerCase() === target.host.toLowerCase();
}

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSec: number };

/** Bounded sliding-window per-key rate limiter. */
export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number, maxKeys = 1024) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  private prune(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    const recent = list.filter((t) => t > cutoff);
    if (recent.length === 0) this.hits.delete(key);
    else if (recent.length !== list.length) this.hits.set(key, recent);
    return recent;
  }

  /** Checks whether `key` is already over the limit without counting a new hit. */
  check(key: string, now = Date.now()): RateLimitVerdict {
    const recent = this.prune(key, now);
    if (recent.length < this.max) return { ok: true };
    const retryAfterSec = Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }

  /** Records one hit for `key` (used for auth failures). */
  record(key: string, now = Date.now()): void {
    const recent = this.prune(key, now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    recent.push(now);
    this.hits.set(key, recent);
  }

  /** Checks and consumes one slot for `key`. */
  take(key: string, now = Date.now()): RateLimitVerdict {
    const verdict = this.check(key, now);
    if (!verdict.ok) return verdict;
    this.record(key, now);
    return verdict;
  }
}

export interface RateLimitOptions {
  windowMs?: number;
  maxAuthFailures?: number;
  maxApiRequests?: number;
  maxCoordinatorRequests?: number;
  maxWsUpgrades?: number;
}

/** What `staticFile` answers for a built file that is not there (an old tab's asset). */
export const MISSING = Symbol("missing");

/**
 * The file of the built web app a request asks for, or the app's page for any other path
 * (the app has its own routes). A missing file under `/assets/` is `MISSING`, never the page:
 * a tab left open across an update asks for its old chunks, and HTML in their place would
 * break it in ways no one can read. Undefined when the address cannot be read.
 */
export function staticFile(webDir: string, rawUrl: string): string | typeof MISSING | undefined {
  const url = parseUrl(rawUrl);
  if (!url) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0")) return undefined;
  const requested = path.join(webDir, path.normalize(pathname));
  const inside = requested.startsWith(webDir + path.sep);
  if (inside && statSync(requested, { throwIfNoEntry: false })?.isFile()) return requested;
  if (inside && requested.startsWith(path.join(webDir, "assets") + path.sep)) return MISSING;
  return path.join(webDir, "index.html");
}

let builtPage: { file: string; stamp: string; id: string | null } | undefined;
/**
 * The id the build wrote in the app's page (`<meta name="moonagentic-build">`), read again
 * only when the page changes on disk. Null without a built page or without the mark.
 */
export function buildId(webDir: string): string | null {
  const file = path.join(webDir, "index.html");
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (builtPage?.file === file && builtPage.stamp === stamp) return builtPage.id;
  let id: string | null = null;
  try {
    const found = /<meta\s+name="moonagentic-build"\s+content="([\w.-]{1,64})"/.exec(
      readFileSync(file, "utf8"),
    );
    id = found?.[1] ?? null;
  } catch {
    // Being rewritten by a build: asked again on the next call.
    return null;
  }
  builtPage = { file, stamp, id };
  return id;
}

/**
 * Keeps the app out of other sites' frames (a hidden frame could collect a click on
 * "Autoriser"), and keeps an agent's answer from loading anything from elsewhere, which
 * would let it send data out through an image address.
 */
export function securityHeaders(host: string | undefined): Record<string, string> {
  // Some browsers do not count the page's own WebSocket address as 'self'.
  const sockets = host && /^[\w.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : "";
  return {
    "content-security-policy": [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self'${sockets}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Reads a client message. A rejected request still names its `requestId`, so the client
 * waiting on it hears back instead of waiting forever.
 */
export function decode(data: string): { message: ClientMessage } | { error: ServerMessage } {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { error: { type: "error", message: "Message illisible." } };
  }
  const parsed = ClientMessage.safeParse(raw);
  if (parsed.success) return { message: parsed.data };
  const requestId =
    typeof raw === "object" && raw !== null && "requestId" in raw ? raw.requestId : undefined;
  return {
    error: {
      type: "error",
      ...(typeof requestId === "string" && requestId.length <= 200 ? { requestId } : {}),
      message: "Message invalide.",
    },
  };
}

/**
 * Serves the built web app (when there is one), the `/ws` endpoint clients talk to, and what
 * the settings need about the server itself: how to reach it from another device, and a new
 * token on request.
 */
export function createHttpServer(options: {
  hub: Hub;
  token: string;
  webDir?: string;
  /** Keeps a renewed token, so it is still the one after a restart. */
  onTokenRenewed?: (token: string) => void;
  /** How often each connection is pinged; one that has not answered by the next is closed. */
  heartbeatMs?: number;
  /** How the server can be reached from elsewhere; asked again each time, as it changes. */
  remoteAccess?: (host: string, port: number) => Promise<RemoteAccess>;
  /** Maximum number of simultaneous WebSocket clients. */
  maxClients?: number;
  /** Lifetime of a single-use WebSocket ticket issued by `POST /api/ws-ticket`. */
  wsTicketTtlMs?: number;
  /** Custom rate-limiting parameters (for tests or hardened deployments). */
  rateLimit?: RateLimitOptions;
}): Server {
  const { hub, webDir } = options;
  let token = options.token;
  const remote = options.remoteAccess ?? findRemoteAccess;
  const maxClients = options.maxClients ?? MAX_WS_CLIENTS;
  const wsTicketTtlMs = options.wsTicketTtlMs ?? WS_TICKET_TTL_MS;
  const rateWindowMs = options.rateLimit?.windowMs ?? DEFAULT_RATE_WINDOW_MS;
  const authFailures = new RateLimiter(
    options.rateLimit?.maxAuthFailures ?? DEFAULT_MAX_AUTH_FAILURES,
    rateWindowMs,
  );
  const apiLimiter = new RateLimiter(
    options.rateLimit?.maxApiRequests ?? DEFAULT_MAX_API_REQUESTS,
    rateWindowMs,
  );
  const coordLimiter = new RateLimiter(
    options.rateLimit?.maxCoordinatorRequests ?? DEFAULT_MAX_COORDINATOR_REQUESTS,
    rateWindowMs,
  );
  const coordAuthFailures = new RateLimiter(
    options.rateLimit?.maxAuthFailures ?? DEFAULT_MAX_AUTH_FAILURES,
    rateWindowMs,
  );
  const wsLimiter = new RateLimiter(
    options.rateLimit?.maxWsUpgrades ?? DEFAULT_MAX_WS_UPGRADES,
    rateWindowMs,
  );
  /** Single-use short-lived tickets issued for WebSocket upgrades, keyed by ticket -> expiresAt. */
  const wsTickets = new Map<string, number>();
  const issueWsTicket = (): string => {
    const now = Date.now();
    for (const [key, expiresAt] of wsTickets) {
      if (expiresAt <= now) wsTickets.delete(key);
    }
    while (wsTickets.size >= MAX_WS_TICKETS) {
      const oldest = wsTickets.keys().next().value;
      if (oldest === undefined) break;
      wsTickets.delete(oldest);
    }
    const ticket = newToken();
    wsTickets.set(ticket, now + wsTicketTtlMs);
    return ticket;
  };
  const consumeWsTicket = (given: string | null): boolean => {
    if (!given) return false;
    const expiresAt = wsTickets.get(given);
    if (expiresAt === undefined) return false;
    wsTickets.delete(given);
    return expiresAt > Date.now();
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const tooMany = (res: ServerResponse, retryAfterSec: number) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": String(retryAfterSec),
    });
    res.end(JSON.stringify({ message: "Trop de requêtes. Réessaie dans un instant." }));
  };

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders(req.headers.host)))
      res.setHeader(name, value);
    const given = bearerToken(req.headers.authorization);
    const remoteIp = req.socket.remoteAddress ?? "unknown";
    if (req.url === "/api/auth") {
      const limit = apiLimiter.take(remoteIp);
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      const authLimit = authFailures.check(remoteIp);
      if (!authLimit.ok) return tooMany(res, authLimit.retryAfterSec);
      if (!sameToken(given, token)) {
        authFailures.record(remoteIp);
        res.writeHead(401).end();
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/api/ws-ticket") {
      const limit = apiLimiter.take(remoteIp);
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      const authLimit = authFailures.check(remoteIp);
      if (!authLimit.ok) return tooMany(res, authLimit.retryAfterSec);
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!sameToken(given, token)) {
        authFailures.record(remoteIp);
        res.writeHead(401).end();
        return;
      }
      json(res, 200, { ticket: issueWsTicket() });
      return;
    }
    if (req.url === COORDINATOR_PATH) {
      // Only a coordinator's bridge, started on this machine, comes here: never a browser,
      // never through the remote access. Its own token says which project it may touch;
      // the app's token opens nothing here.
      const from = req.socket.remoteAddress ?? "";
      if (!LOCAL.has(from) || req.headers["x-forwarded-for"] || req.headers.origin) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const limit = coordLimiter.take(remoteIp);
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      const authLimit = coordAuthFailures.check(remoteIp);
      if (!authLimit.ok) return tooMany(res, authLimit.retryAfterSec);
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_COORDINATOR_BODY) req.destroy();
        else chunks.push(chunk);
      });
      req.on("error", () => undefined);
      req.on("end", () => {
        let body: { tool?: unknown; args?: unknown; exchange?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
        } catch {
          json(res, 400, { error: "Requête illisible." });
          return;
        }
        if (body?.exchange === true) {
          // The bridge's first words: what it was started with, for the token it will use.
          try {
            json(res, 200, { token: hub.coordinatorExchange(given ?? "") });
          } catch {
            coordAuthFailures.record(remoteIp);
            json(res, 401, { error: "Accès refusé." });
          }
          return;
        }
        const abort = new AbortController();
        res.once("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        hub.coordinatorCall(given ?? "", String(body?.tool ?? ""), body?.args, abort.signal).then(
          (result) => {
            if (!res.writableEnded) json(res, 200, { result });
          },
          (error: unknown) => {
            if (error instanceof CoordinatorRefused) coordAuthFailures.record(remoteIp);
            if (!res.writableEnded) {
              json(res, error instanceof CoordinatorRefused ? 401 : 400, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        );
      });
      return;
    }
    if (req.url === "/api/remote" || req.url === "/api/remote/token") {
      const limit = apiLimiter.take(remoteIp);
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      const authLimit = authFailures.check(remoteIp);
      if (!authLimit.ok) return tooMany(res, authLimit.retryAfterSec);
      if (!sameToken(given, token)) {
        authFailures.record(remoteIp);
        res.writeHead(401).end();
        return;
      }
      const renew = req.url === "/api/remote/token";
      if (req.method !== (renew ? "POST" : "GET")) {
        res.writeHead(405).end();
        return;
      }
      if (renew) {
        const next = newToken();
        try {
          options.onTokenRenewed?.(next);
        } catch (error) {
          // The old token stays: one that a restart would forget must not be handed out.
          json(res, 500, { message: error instanceof Error ? error.message : String(error) });
          return;
        }
        token = next;
        wsTickets.clear();
        // Every device still on the old token is shown out, once this one has the new one.
        res.once("close", () => {
          for (const socket of wss.clients) socket.close(TOKEN_RENEWED, "token renewed");
        });
        json(res, 200, { token });
        return;
      }
      const address = server.address();
      const listening = typeof address === "object" && address ? address : undefined;
      remote(listening?.address ?? "127.0.0.1", listening?.port ?? 0).then(
        (access) => json(res, 200, access),
        (error: unknown) =>
          json(res, 500, { message: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    if (!webDir) {
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/api/build") {
      // Which version of the app is built here, so a tab opened before an update offers to
      // reload. It says no more than the page itself, which anyone reaching the server reads.
      json(res, 200, { id: buildId(webDir) });
      return;
    }
    const file = staticFile(webDir, req.url ?? "/");
    if (!file) {
      res.writeHead(400).end();
      return;
    }
    if (file === MISSING) {
      res.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    const stream = createReadStream(file);
    // A file that vanished or cannot be read ends this response, not the server.
    stream.on("error", () => res.destroy());
    // A reader who leaves before the end would otherwise leave the file open.
    res.on("close", () => stream.destroy());
    stream.once("open", () => {
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": file.includes(`${path.sep}assets${path.sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      stream.pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let upgrading = 0;
  // A phone that left the network never says goodbye: a connection that does not answer a
  // ping by the next one is closed, so nothing is kept for a window that is gone.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  server.on("upgrade", (req, socket, head) => {
    const url = parseUrl(req.url ?? "/");
    if (url?.pathname !== "/ws") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (!allowedWsOrigin(req.headers.origin, req.headers.host)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const remoteIp = req.socket.remoteAddress ?? "unknown";
    const limit = wsLimiter.take(remoteIp);
    if (!limit.ok) {
      socket.end(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${limit.retryAfterSec}\r\n\r\n`);
      return;
    }
    const authLimit = authFailures.check(remoteIp);
    if (!authLimit.ok) {
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${authLimit.retryAfterSec}\r\n\r\n`,
      );
      return;
    }
    const authorized =
      consumeWsTicket(url.searchParams.get("ticket")) ||
      sameToken(bearerToken(req.headers.authorization), token);
    if (!authorized) {
      authFailures.record(remoteIp);
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (wss.clients.size + upgrading >= maxClients) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    upgrading += 1;
    let settled = false;
    const finishUpgrade = () => {
      if (settled) return;
      settled = true;
      upgrading -= 1;
    };
    socket.once("close", finishUpgrade);
    socket.once("error", finishUpgrade);
    wss.handleUpgrade(req, socket, head, (ws) => {
      finishUpgrade();
      const client: Client = {
        send: (message: ServerMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        },
      };
      const disconnect = hub.connect(client);
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      ws.on("close", disconnect);
      // A broken connection closes on its own; without a listener its error would stop the server.
      ws.on("error", () => ws.terminate());
      ws.on("message", (data) => {
        const decoded = decode(data.toString());
        if ("error" in decoded) {
          client.send(decoded.error);
          return;
        }
        const message = decoded.message;
        hub.handle(client, message).catch((error: unknown) => {
          client.send({
            type: "error",
            ...("requestId" in message ? { requestId: message.requestId } : {}),
            message: error instanceof Error ? error.message : String(error),
          });
        });
      });
    });
  });
  // A coordinator's bridge runs on this machine: it reaches the server on the loopback.
  server.on("listening", () => {
    const address = server.address();
    if (typeof address === "object" && address) {
      // Listening on the IPv6 loopback alone, nothing answers on 127.0.0.1.
      const host =
        address.address === "::1"
          ? "[::1]"
          : address.address === "::" || address.address === "0.0.0.0" || LOCAL.has(address.address)
            ? "127.0.0.1"
            : undefined;
      // Bound to one outside address only: no loopback to answer on, so no coordinator tools.
      hub.coordinatorUrl = host ? `http://${host}:${address.port}` : undefined;
    }
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    wsTickets.clear();
    wss.close();
  });
  return server;
}
