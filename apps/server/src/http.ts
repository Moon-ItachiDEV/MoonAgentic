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
    if (req.url === "/api/auth") {
      const given = req.headers.authorization?.replace(/^Bearer /, "") ?? null;
      res.writeHead(sameToken(given, token) ? 204 : 401).end();
      return;
    }
    if (!webDir) {
      res.writeHead(404).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const requested = path.join(webDir, path.normalize(decodeURIComponent(url.pathname)));
    const inside = requested.startsWith(webDir + path.sep);
    const file =
      inside && statSync(requested, { throwIfNoEntry: false })?.isFile()
        ? requested
        : path.join(webDir, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": file.includes(`${path.sep}assets${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !sameToken(url.searchParams.get("token"), token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = {
        send: (message: ServerMessage) => ws.send(JSON.stringify(message)),
      };
      const disconnect = hub.connect(client);
      ws.on("close", disconnect);
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
