// Listing an MCP server's tools: started by a command, or called at its address.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMcpTools, rpcFromBody } from "../src/mcp-probe.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stdioRecord = (script: string) => ({
  id: "s",
  name: "s",
  enabled: true,
  transport: { type: "stdio" as const, command: process.execPath, args: [script], env: [] },
});

/** A server at an address, answering each POST as `answer` says. */
async function httpServer(
  answer: (m: { id?: number; method: string }, res: import("node:http").ServerResponse) => void,
  onDelete?: (req: import("node:http").IncomingMessage) => void,
) {
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.method === "DELETE") return onDelete ? onDelete(req) : res.end();
      const m = JSON.parse(body) as { id?: number; method: string };
      if (m.id === undefined) {
        res.statusCode = 202;
        return res.end();
      }
      answer(m, res);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  );
  return {
    id: "h",
    name: "h",
    enabled: true,
    transport: {
      type: "http" as const,
      url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
      headers: [],
    },
  };
}

const event = (id: number | undefined, result: unknown) =>
  `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A server on stdin/stdout that lists its tools on two pages, and logs a line first. */
const STDIO_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
console.log("serveur prêt");
if (process.env.MCP_TOKEN !== "s3cret") { console.error("MCP_TOKEN manquant"); process.exit(3); }
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
  if (m.method === "tools/list" && !m.params?.cursor)
    return reply({ tools: [{ name: "browser_click", description: "Clique.\\nEn détail…" }], nextCursor: "2" });
  if (m.method === "tools/list") return reply({ tools: [{ name: "browser_type" }] });
});
`;

describe("probeMcpTools", () => {
  it("starts a command server with its secrets, reads every page of tools, then stops it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-probe-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, "server.cjs");
    writeFileSync(script, STDIO_SERVER);
    const record = (value: string) => ({
      id: "s",
      name: "s",
      enabled: true,
      transport: {
        type: "stdio" as const,
        command: process.execPath,
        args: [script],
        env: [{ name: "MCP_TOKEN", value }],
      },
    });
    expect(await probeMcpTools(record("s3cret"))).toEqual([
      { name: "browser_click", description: "Clique." },
      { name: "browser_type" },
    ]);
    await expect(probeMcpTools(record("faux"))).rejects.toThrow("MCP_TOKEN manquant");
  });

  it("calls an address server, its answers as events, keeping its session", async () => {
    const seen: { method: string; session?: string; auth?: string }[] = [];
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        if (req.method === "DELETE") return res.end();
        const m = JSON.parse(body) as { id?: number; method: string };
        seen.push({
          method: m.method,
          ...(req.headers["mcp-session-id"]
            ? { session: String(req.headers["mcp-session-id"]) }
            : {}),
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        });
        if (req.headers.authorization !== "Bearer ok") {
          res.statusCode = 401;
          return res.end();
        }
        if (m.id === undefined) {
          res.statusCode = 202;
          return res.end();
        }
        const result =
          m.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : { tools: [{ name: "get_state", description: "Lit un état." }] };
        res.setHeader("content-type", "text/event-stream");
        if (m.method === "initialize") res.setHeader("mcp-session-id", "abc");
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`,
        );
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => http.close(() => r())));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const record = (value: string) => ({
      id: "h",
      name: "h",
      enabled: true,
      transport: { type: "http" as const, url, headers: [{ name: "Authorization", value }] },
    });
    expect(await probeMcpTools(record("Bearer ok"))).toEqual([
      { name: "get_state", description: "Lit un état." },
    ]);
    expect(seen.map((s) => [s.method, s.session])).toEqual([
      ["initialize", undefined],
      ["notifications/initialized", "abc"],
      ["tools/list", "abc"],
    ]);
    await expect(probeMcpTools(record("Bearer non"))).rejects.toThrow("vérifie ses secrets");
  });

  it("finds the answer among a body's events", () => {
    const body =
      'data: {"jsonrpc":"2.0","method":"note"}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":1}}\n\n';
    expect(rpcFromBody(body, "text/event-stream", 2)).toMatchObject({ result: { ok: 1 } });
    expect(rpcFromBody('{"jsonrpc":"2.0","id":1,"result":3}', "application/json", 1)).toMatchObject(
      {
        result: 3,
      },
    );
  });

  it("does not bring the server down when the command stops listening", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-probe-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, "gone.cjs");
    // Answers the first question, then closes its input: what is written next fails (EPIPE).
    writeFileSync(
      script,
      `const fs = require("node:fs");
const b = Buffer.alloc(65536);
const n = fs.readSync(0, b);
fs.closeSync(0);
const m = JSON.parse(b.subarray(0, n).toString().split("\\n")[0]);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
setTimeout(() => process.exit(4), 300);`,
    );
    const errors: unknown[] = [];
    const caught = (error: unknown) => errors.push(error);
    process.on("uncaughtException", caught);
    cleanups.push(() => void process.off("uncaughtException", caught));
    for (let i = 0; i < 3; i++) {
      await expect(probeMcpTools(stdioRecord(script), 5_000)).rejects.toThrow("s'est arrêté");
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(errors).toEqual([]);
  });

  it("stops what the command started too, even when it will not stop on its own", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-probe-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = path.join(dir, "pids");
    const script = path.join(dir, "tree.cjs");
    writeFileSync(
      script,
      `const { spawn } = require("node:child_process");
const keep = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
const grandchild = spawn(process.execPath, ["-e", keep], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
process.on("SIGTERM", () => {});
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { tools: [{ name: "t" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
    );
    expect(await probeMcpTools(stdioRecord(script), 5_000)).toEqual([{ name: "t" }]);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    cleanups.push(() => {
      if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
    });
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 6_000 });
  });

  it("takes the answer from an event stream the server keeps open", async () => {
    const record = await httpServer((m, res) => {
      const result =
        m.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {} }
          : { tools: [{ name: "ouvert" }] };
      res.setHeader("content-type", "text/event-stream");
      res.write(event(m.id, result));
      // The stream stays open, as a server that would send more later does.
    });
    const start = Date.now();
    expect(await probeMcpTools(record, 10_000)).toEqual([{ name: "ouvert" }]);
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  it("gives up on a body that never ends and holds no answer", async () => {
    const record = await httpServer((_m, res) => {
      res.setHeader("content-type", "application/json");
      const chunk = "x".repeat(64 * 1024);
      const pour = () => {
        if (res.destroyed) return;
        res.write(chunk);
        setImmediate(pour);
      };
      pour();
    });
    const start = Date.now();
    await expect(probeMcpTools(record, 10_000)).rejects.toThrow("trop longue");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("lets go of a session the server does not close", async () => {
    let aborted = false;
    const record = await httpServer(
      (m, res) => {
        const result =
          m.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {} }
            : { tools: [] };
        res.setHeader("content-type", "application/json");
        if (m.method === "initialize") res.setHeader("mcp-session-id", "abc");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      },
      (req) => req.socket.on("close", () => (aborted = true)),
    );
    expect(await probeMcpTools(record, 10_000)).toEqual([]);
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 8_000 });
  });
});
