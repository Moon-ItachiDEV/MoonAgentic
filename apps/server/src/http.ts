import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import {
  ClientMessage,
  MAX_IMAGE_BYTES,
  type RemoteAccess,
  type ServerMessage,
} from "@moonagentic/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { AttachmentRefused } from "./attachments.ts";
import { ARTIFACTS_PATH } from "./artifacts.ts";
import { COORDINATOR_PATH } from "./coordinator-tools.ts";
import { Devices } from "./devices.ts";
import type { DiagnosticsMonitor } from "./diagnostics.ts";
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
const DEFAULT_MAX_COORDINATOR_REQUESTS = 240;
const DEFAULT_MAX_WS_UPGRADES = 120;

/** A fresh access token: long enough that it cannot be guessed. */
export const newToken = () => randomBytes(24).toString("base64url");
/** Why a connection is closed when the token it came in with is replaced. */
export const TOKEN_RENEWED = 4001;
/** Why a device's connections are closed when it is revoked. */
export const DEVICE_REVOKED = 4003;
/** A pairing request is a code and a device name: never large. */
const MAX_PAIR_BODY = 4 * 1024;
/** A browser error report is a short message and clipped stack: never large. */
const MAX_CLIENT_ERROR_BODY = 8 * 1024;

/** Who a request comes from: the computer's own token, or a paired device. */
type Who = { owner: true } | { owner: false; deviceId: string };

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

/** Where the images sent with messages are received and read back. */
export const ATTACHMENTS_PATH = "/api/attachments";

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
 * Who the rate limiters count against: when a request arrives through loopback with
 * `X-Forwarded-For` (e.g. `tailscale serve`), count against the rightmost forwarded address
 * added by the local proxy rather than `127.0.0.1`, so a remote device cannot lock out the
 * computer itself or other devices.
 */
export function rateKey(req: Pick<IncomingMessage, "socket" | "headers">): string {
  const remoteIp = req.socket.remoteAddress ?? "unknown";
  if (LOCAL.has(remoteIp)) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    if (raw) {
      const forwarded = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1)
        ?.slice(0, 64);
      if (forwarded) return `forwarded:${forwarded}`;
    }
    return "local";
  }
  return remoteIp;
}

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
  let isFile = false;
  if (inside) {
    try {
      isFile = statSync(requested, { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      // Long names (ENAMETOOLONG), unreadable segments, etc.: refuse cleanly, never crash.
      return undefined;
    }
  }
  if (isFile) return requested;
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

/** How much of a refused upload is still read, and for how long, before it is cut. */
const REFUSED_DRAIN_BYTES = 2 * MAX_IMAGE_BYTES;
const REFUSED_DRAIN_MS = 30_000;

/**
 * Reads and drops what is left of an upload already refused. Closing on a sender that is
 * still writing resets the connection on Windows before it has read the answer, and it
 * would see a network failure instead of the reason. Within limits: one that never stops
 * is cut.
 */
function dropRest(req: IncomingMessage): void {
  let left = REFUSED_DRAIN_BYTES;
  const cut = () => req.socket.destroy();
  const timer = setTimeout(cut, REFUSED_DRAIN_MS);
  timer.unref();
  req.on("data", (chunk: Buffer) => {
    left -= chunk.length;
    if (left < 0) cut();
  });
  req.once("close", () => clearTimeout(timer));
  req.resume();
}

/** Said when a paired device asks for what only the computer may do. */
const ONLY_ON_COMPUTER = "Seul l'ordinateur où tourne MoonAgentic peut faire ça.";

/** Reads a small JSON object; anything else, too large or unreadable, gives undefined. */
function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    });
    req.on("error", () => resolve(undefined));
    req.on("end", () => {
      if (size > max) return resolve(undefined);
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(body && typeof body === "object" ? (body as Record<string, unknown>) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
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
      // `blob:` is an image this page read itself, with the token: one joined to a message.
      "img-src 'self' data: blob:",
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
 * How an artifact is served: inside the app's own frame alone, as a sandbox with no script
 * and nothing loaded from elsewhere, so a page an agent wrote can neither run code with the
 * app's rights nor send anything out. A PDF is shown by the browser's own reader, which a
 * sandbox would turn away: nothing in it runs with the app's rights either.
 */
export function artifactHeaders(type: string): Record<string, string> {
  const pdf = type === "application/pdf";
  return {
    "content-security-policy": (pdf
      ? ["default-src 'none'", "frame-ancestors 'self'"]
      : [
          "sandbox",
          "default-src 'none'",
          "img-src 'self' data: blob:",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "media-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'self'",
        ]
    ).join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    // No resource policy: the page, sandboxed, has an origin of its own, and loads its images
    // and styles from here. Only its address, secret and short-lived, lets them be read.
    "content-disposition": "inline",
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
  /** The paired devices; kept in memory alone when not given. */
  devices?: Devices;
  /** Runtime crash & performance diagnostics monitor. */
  diagnostics?: DiagnosticsMonitor;
}): Server {
  const { hub, webDir, diagnostics } = options;
  let token = options.token;
  const devices = options.devices ?? new Devices();
  const identify = (given: string | null): Who | undefined => {
    if (sameToken(given, token)) return { owner: true };
    const deviceId = devices.authenticate(given);
    return deviceId ? { owner: false, deviceId } : undefined;
  };
  /** Each open connection, with who opened it: a revoked device's are closed. */
  const sockets = new Map<WebSocket, Who>();
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
  /** Single-use short-lived tickets issued for WebSocket upgrades, with whom each is for. */
  const wsTickets = new Map<string, { expiresAt: number; who: Who }>();
  const issueWsTicket = (who: Who): string => {
    const now = Date.now();
    for (const [key, { expiresAt }] of wsTickets) {
      if (expiresAt <= now) wsTickets.delete(key);
    }
    while (wsTickets.size >= MAX_WS_TICKETS) {
      const oldest = wsTickets.keys().next().value;
      if (oldest === undefined) break;
      wsTickets.delete(oldest);
    }
    const ticket = newToken();
    wsTickets.set(ticket, { expiresAt: now + wsTicketTtlMs, who });
    return ticket;
  };
  const consumeWsTicket = (given: string | null): Who | undefined => {
    if (!given) return undefined;
    const found = wsTickets.get(given);
    if (found === undefined) return undefined;
    wsTickets.delete(given);
    return found.expiresAt > Date.now() ? found.who : undefined;
  };
  /** Drops the tickets and closes the connections that `whose` says are no longer let in. */
  const shutOut = (whose: (who: Who) => boolean, code: number, reason: string) => {
    for (const [key, { who }] of wsTickets) if (whose(who)) wsTickets.delete(key);
    for (const [socket, who] of sockets) if (whose(who)) socket.close(code, reason);
    // The addresses it was given to show artifacts stop too.
    hub.artifactLinks.forget((deviceId) =>
      whose(deviceId ? { owner: false, deviceId } : { owner: true }),
    );
  };
  const ofDevice = (id: string) => (who: Who) => !who.owner && who.deviceId === id;

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

  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(securityHeaders(req.headers.host)))
      res.setHeader(name, value);
    const given = bearerToken(req.headers.authorization);
    const remoteIp = req.socket.remoteAddress ?? "unknown";
    const clientKey = rateKey(req);
    const crossSite =
      !allowedWsOrigin(req.headers.origin, req.headers.host) ||
      req.headers["sec-fetch-site"] === "cross-site";
    // Requests from another site, or with no token at all, never consume the local API quota.
    const authGate = (): Who | undefined => {
      if (crossSite) {
        dropRest(req);
        res.writeHead(403).end();
        return undefined;
      }
      if (!given) {
        dropRest(req);
        res.writeHead(401).end();
        return undefined;
      }
      const limit = apiLimiter.take(clientKey);
      if (!limit.ok) {
        dropRest(req);
        tooMany(res, limit.retryAfterSec);
        return undefined;
      }
      const authLimit = authFailures.check(clientKey);
      if (!authLimit.ok) {
        dropRest(req);
        tooMany(res, authLimit.retryAfterSec);
        return undefined;
      }
      const who = identify(given);
      if (!who) {
        authFailures.record(clientKey);
        dropRest(req);
        res.writeHead(401).end();
        return undefined;
      }
      return who;
    };
    if (req.url === "/api/auth") {
      if (!authGate()) return;
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/api/ws-ticket") {
      const who = authGate();
      if (!who) return;
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      json(res, 200, { ticket: issueWsTicket(who) });
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
      const who = authGate();
      if (!who) return;
      const renew = req.url === "/api/remote/token";
      if (req.method !== (renew ? "POST" : "GET")) {
        res.writeHead(405).end();
        return;
      }
      if (renew && !who.owner) return json(res, 403, { message: ONLY_ON_COMPUTER });
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
        // Every window still on the old token is shown out, once this one has the new one.
        // Those are the ones open now: one this window opens with the new token stays. Paired
        // devices have tokens of their own: they stay too.
        for (const [key, { who: w }] of wsTickets) if (w.owner) wsTickets.delete(key);
        // So do the addresses given to show artifacts, which the old token was enough to get.
        hub.artifactLinks.forget((deviceId) => deviceId === undefined);
        // And the browsers it subscribed to Web Push: the computer's own say so again when they
        // connect with the new token.
        hub.push.forget((deviceId) => deviceId === undefined);
        const old = [...sockets].filter(([, w]) => w.owner).map(([socket]) => socket);
        res.once("close", () => {
          for (const socket of old) socket.close(TOKEN_RENEWED, "token renewed");
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
    if (req.url === "/api/diagnostics") {
      const who = authGate();
      if (!who) return;
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (!diagnostics) {
        return json(res, 503, { message: "Diagnostic indisponible sur ce serveur." });
      }
      diagnostics.buildReport().then(
        (report) => {
          if (!res.writableEnded) json(res, 200, report);
        },
        (error: unknown) => {
          if (!res.writableEnded) {
            json(res, 500, { message: error instanceof Error ? error.message : String(error) });
          }
        },
      );
      return;
    }
    if (req.url === "/api/client-error") {
      const who = authGate();
      if (!who) return;
      if (req.method !== "POST") {
        dropRest(req);
        res.writeHead(405).end();
        return;
      }
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
        dropRest(req);
        return json(res, 415, { message: "Rapport d'erreur attendu en JSON." });
      }
      void readJson(req, MAX_CLIENT_ERROR_BODY).then((body) => {
        if (diagnostics && body) {
          const device = who.owner
            ? "ordinateur"
            : (devices.list().find((d) => d.id === who.deviceId)?.name ?? "appareil jumelé");
          diagnostics.recordClientError(body, device);
        }
        if (!res.writableEnded) res.writeHead(204).end();
      });
      return;
    }
    if (req.url === "/api/pair") {
      // A device with a code shown on the computer: the only call here without a token.
      if (crossSite) {
        dropRest(req);
        res.writeHead(403).end();
        return;
      }
      const limit = apiLimiter.take(clientKey);
      if (!limit.ok) {
        dropRest(req);
        return tooMany(res, limit.retryAfterSec);
      }
      const authLimit = authFailures.check(clientKey);
      if (!authLimit.ok) {
        dropRest(req);
        return tooMany(res, authLimit.retryAfterSec);
      }
      if (req.method !== "POST") {
        dropRest(req);
        res.writeHead(405).end();
        return;
      }
      // JSON only: another site cannot send it without the browser asking first, which this
      // server never allows, so it cannot try codes from a page open on this computer.
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
        dropRest(req);
        return json(res, 415, { message: "Une demande d'appairage s'envoie en JSON." });
      }
      void readJson(req, MAX_PAIR_BODY).then((body) => {
        const code = typeof body?.code === "string" ? body.code : "";
        const name = typeof body?.name === "string" ? body.name : "";
        let paired: ReturnType<Devices["pair"]>;
        try {
          paired = devices.pair(code, name);
        } catch (error) {
          return json(res, 409, {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (!paired) {
          authFailures.record(clientKey);
          return json(res, 401, {
            message: "Ce code ne marche pas : il a expiré ou a déjà servi. Demandes-en un nouveau.",
          });
        }
        json(res, 200, paired);
      });
      return;
    }
    if (req.url === "/api/pair/start" || req.url?.startsWith("/api/devices")) {
      // Only the computer pairs and revokes devices: a phone that was lost cannot add others.
      const who = authGate();
      if (!who) return;
      if (!who.owner) return json(res, 403, { message: ONLY_ON_COMPUTER });
      if (req.url === "/api/pair/start" && req.method === "POST") {
        return json(res, 200, devices.startPairing());
      }
      if (req.url === "/api/devices" && req.method === "GET") {
        return json(res, 200, { devices: devices.list() });
      }
      if (req.url === "/api/devices/revoke" && req.method === "POST") {
        void readJson(req, MAX_PAIR_BODY).then((body) => {
          const id = typeof body?.id === "string" ? body.id : "";
          if (!devices.revoke(id))
            return json(res, 404, { message: "Cet appareil n'est plus là." });
          shutOut(ofDevice(id), DEVICE_REVOKED, "device revoked");
          json(res, 200, { devices: devices.list() });
        });
        return;
      }
      const known = ["/api/pair/start", "/api/devices", "/api/devices/revoke"];
      res.writeHead(known.includes(req.url ?? "") ? 405 : 404).end();
      return;
    }
    const asked = parseUrl(req.url ?? "/")?.pathname ?? "";
    if (asked.startsWith(`${ARTIFACTS_PATH}/`)) {
      // An artifact shown in the app (inside a sandboxed iframe with an opaque origin):
      // its short-lived ticket in the URL is the permission, not same-origin headers.
      const limit = apiLimiter.take(clientKey);
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const notFound = () => void res.writeHead(404, { "cache-control": "no-store" }).end();
      const [ticket, ...rest] = asked.slice(ARTIFACTS_PATH.length + 1).split("/");
      let file: string;
      try {
        const parts = rest.map(decodeURIComponent);
        // A part may not hide a separator of its own.
        if (!ticket || !parts.length || parts.some((p) => !p || /[\\/]/.test(p))) return notFound();
        file = parts.join("/");
      } catch {
        return notFound();
      }
      void hub.artifactLinks.resolve(ticket, file).then(
        (found) => {
          if (!found) return notFound();
          for (const [name, value] of Object.entries(artifactHeaders(found.type)))
            res.setHeader(name, value);
          res.removeHeader("x-frame-options");
          res.writeHead(200, { "content-type": found.type, "content-length": found.size });
          if (req.method === "HEAD") return void res.end();
          const stream = createReadStream(found.file);
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
        },
        () => (res.headersSent ? res.destroy() : notFound()),
      );
      return;
    }
    if (asked === ATTACHMENTS_PATH || asked.startsWith(`${ATTACHMENTS_PATH}/`)) {
      // The images sent with messages: received before the message, read back by its thread.
      if (!authGate()) return;
      const refused = (error: unknown) => {
        if (res.writableEnded) return;
        if (error instanceof AttachmentRefused) json(res, error.status, { message: error.message });
        else json(res, 500, { message: error instanceof Error ? error.message : String(error) });
      };
      const parts = asked.slice(ATTACHMENTS_PATH.length).split("/").filter(Boolean);
      if (parts.length === 0 && req.method === "POST") {
        const tooLarge = () =>
          refused(
            new AttachmentRefused(
              `Image trop lourde : ${MAX_IMAGE_BYTES / 1024 / 1024} Mo au plus.`,
              413,
            ),
          );
        if (Number(req.headers["content-length"] ?? 0) > MAX_IMAGE_BYTES) {
          // Said before any of it is kept.
          tooLarge();
          dropRest(req);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const keep = (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_IMAGE_BYTES) return void chunks.push(chunk);
          // A sender that lied about the length, or gave none: refused as soon as it shows.
          chunks.length = 0;
          req.off("data", keep);
          tooLarge();
          dropRest(req);
        };
        req.on("data", keep);
        req.on("error", () => undefined);
        req.on("end", () => {
          if (size > MAX_IMAGE_BYTES) return;
          let name: string | undefined;
          try {
            name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")) || undefined;
          } catch {
            // A name that cannot be read: one is made up from the kind of image.
          }
          try {
            json(res, 201, hub.attachments.add(Buffer.concat(chunks), name));
          } catch (error) {
            refused(error);
          }
        });
        return;
      }
      if (parts.length === 1 && req.method === "DELETE") {
        // Taken off the message before it was sent; one already sent belongs to its thread.
        hub.attachments.discard(parts[0]!);
        res.writeHead(204).end();
        return;
      }
      if (parts.length === 2 && req.method === "GET") {
        // A locked project's images stay on this computer, like the rest of its threads.
        const found = hub.lockedThread(parts[0]!)
          ? undefined
          : hub.attachments.find(parts[0]!, parts[1]!);
        if (!found) {
          res.writeHead(404, { "cache-control": "no-store" }).end();
          return;
        }
        const stream = createReadStream(found.file);
        stream.on("error", () => {
          // Gone between the look and the read, such as with its thread: not there, said so.
          if (res.headersSent) res.destroy();
          else res.writeHead(404, { "cache-control": "no-store" }).end();
        });
        res.on("close", () => stream.destroy());
        stream.once("open", () => {
          res.writeHead(200, {
            "content-type": found.image.mime,
            "content-length": found.image.size,
            // Never kept in browser disk cache so locking a project leaves nothing readable behind.
            "cache-control": "private, no-store",
            "content-disposition": "inline",
            "cross-origin-resource-policy": "same-origin",
          });
          stream.pipe(res);
        });
        return;
      }
      res.writeHead(parts.length <= 2 ? 405 : 404).end();
      return;
    }
    if (!webDir) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/api/build") {
      // Which version of the app is built here, so a tab opened before an update offers to
      // reload. It says no more than the page itself, which anyone reaching the server reads.
      if (req.method === "HEAD") {
        res
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end();
        return;
      }
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
        // The page is never kept: an iPhone app on the home screen that kept an old one
        // would ask for files a newer build no longer has.
        "cache-control": file.includes(`${path.sep}assets${path.sep}`)
          ? "public, max-age=31536000, immutable"
          : path.extname(file) === ".html"
            ? "no-store"
            : "no-cache",
      });
      if (req.method === "HEAD") {
        stream.destroy();
        res.end();
        return;
      }
      stream.pipe(res);
    });
  };

  const server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (error) {
      console.error("Requête HTTP :", error);
      if (!res.headersSent) res.writeHead(500, { "cache-control": "no-store" }).end();
      else res.destroy();
    }
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
    try {
      const url = parseUrl(req.url ?? "/");
      if (url?.pathname !== "/ws") {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      if (!allowedWsOrigin(req.headers.origin, req.headers.host)) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const clientKey = rateKey(req);
      const limit = wsLimiter.take(clientKey);
      if (!limit.ok) {
        socket.end(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${limit.retryAfterSec}\r\n\r\n`);
        return;
      }
      const authLimit = authFailures.check(clientKey);
      if (!authLimit.ok) {
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${authLimit.retryAfterSec}\r\n\r\n`,
        );
        return;
      }
      const who =
        consumeWsTicket(url.searchParams.get("ticket")) ??
        identify(bearerToken(req.headers.authorization));
      if (!who) {
        authFailures.record(clientKey);
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
          ...(who.owner ? {} : { deviceId: who.deviceId }),
        };
        const disconnect = hub.connect(client);
        sockets.set(ws, who);
        ws.on("close", () => sockets.delete(ws));
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
    } catch (error) {
      console.error("Upgrade WebSocket :", error);
      socket.destroy();
    }
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
