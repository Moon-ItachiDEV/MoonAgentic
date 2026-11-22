import { timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { ClientMessage, type ServerMessage } from "@moonagentic/protocol";
import { WebSocketServer } from "ws";
import type { Client, Hub } from "./hub.ts";

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

/** Serves the built web app (when there is one) and the `/ws` endpoint clients talk to. */
export function createHttpServer(options: { hub: Hub; token: string; webDir?: string }): Server {
  const { hub, token, webDir } = options;
  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders(req.headers.host)))
      res.setHeader(name, value);
    if (req.url === "/api/auth") {
      const given = req.headers.authorization?.replace(/^Bearer /, "") ?? null;
      res.writeHead(sameToken(given, token) ? 204 : 401).end();
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
  server.on("close", () => wss.close());
  return server;
}
