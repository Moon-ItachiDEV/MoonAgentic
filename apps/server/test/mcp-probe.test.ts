// Listing an MCP server's tools: started by a command, or called at its address.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeMcpTools, rpcFromBody } from "../src/mcp-probe.ts";

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
});
