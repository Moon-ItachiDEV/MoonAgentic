import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { ClientMessage, type RemoteAccess, type ServerMessage } from "@moonagentic/protocol";
import { WebSocketServer } from "ws";
import { COORDINATOR_PATH } from "./coordinator-tools.ts";
import { type Client, CoordinatorRefused, type Hub } from "./hub.ts";
import { findRemoteAccess } from "./remote.ts";

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
 * The file of the built web app a request asks for, or the app's page for any other path
 * (the app has its own routes). Undefined when the address cannot be read.
 */
export function staticFile(webDir: string, rawUrl: string): string | undefined {
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
  return inside && statSync(requested, { throwIfNoEntry: false })?.isFile()
    ? requested
    : path.join(webDir, "index.html");
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
  /** How the server can be reached from elsewhere; asked again each time, as it changes. */
  remoteAccess?: (host: string, port: number) => Promise<RemoteAccess>;
}): Server {
  const { hub, webDir } = options;
  let token = options.token;
  const remote = options.remoteAccess ?? findRemoteAccess;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders(req.headers.host)))
      res.setHeader(name, value);
    const given = req.headers.authorization?.replace(/^Bearer /, "") ?? null;
    if (req.url === "/api/auth") {
      res.writeHead(sameToken(given, token) ? 204 : 401).end();
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
            json(res, 401, { error: "Accès refusé." });
          }
          return;
        }
        hub.coordinatorCall(given ?? "", String(body?.tool ?? ""), body?.args).then(
          (result) => json(res, 200, { result }),
          (error: unknown) =>
            json(res, error instanceof CoordinatorRefused ? 401 : 400, {
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      });
      return;
    }
    if (req.url === "/api/remote" || req.url === "/api/remote/token") {
      if (!sameToken(given, token)) {
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
    const file = staticFile(webDir, req.url ?? "/");
    if (!file) {
      res.writeHead(400).end();
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
  server.on("upgrade", (req, socket, head) => {
    const url = parseUrl(req.url ?? "/");
    if (url?.pathname !== "/ws" || !sameToken(url.searchParams.get("token"), token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = {
        send: (message: ServerMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        },
      };
      const disconnect = hub.connect(client);
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
  server.on("close", () => wss.close());
  return server;
}
