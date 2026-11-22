#!/usr/bin/env node
// The MCP server a coordinator's agent starts: it speaks MCP on stdin and stdout, and passes
// each tool call to the MoonAgentic server that gave it its address and its token. It holds
// nothing else: the token only opens the tools of one project.
import { createInterface } from "node:readline";
import {
  BRIDGE_TOKEN_ENV,
  BRIDGE_URL_ENV,
  COORDINATOR_PATH,
  COORDINATOR_TOOLS,
} from "./coordinator-tools.ts";

const url = process.env[BRIDGE_URL_ENV];
const token = process.env[BRIDGE_TOKEN_ENV];

type Id = string | number;
const reply = (id: Id, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const refuse = (id: Id, code: number, message: string) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
const text = (value: string, isError = false) => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

async function call(tool: string, args: unknown) {
  if (!url || !token) return text("MoonAgentic n'a pas donné d'accès à ce pont.", true);
  try {
    const response = await fetch(`${url}${COORDINATOR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, args: args ?? {} }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok || body.error) return text(body.error ?? `Refusé (${response.status}).`, true);
    return text(JSON.stringify(body.result, null, 2));
  } catch (error) {
    return text(
      `MoonAgentic ne répond pas : ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Calls under way, so the bridge only ends once each has been answered. */
const pending = new Set<Promise<unknown>>();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(message) || typeof message.method !== "string") return;
  const id = message.id;
  // A notification, such as « initialized », asks for no answer.
  if (typeof id !== "string" && typeof id !== "number") return;
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case "initialize":
      reply(id, {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "moonagentic", version: "1" },
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: COORDINATOR_TOOLS });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!COORDINATOR_TOOLS.some((t) => t.name === name)) {
        refuse(id, -32602, `Outil inconnu : ${name}`);
        return;
      }
      const work = call(name, params.arguments).then((result) => reply(id, result));
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return;
    }
    default:
      refuse(id, -32601, `Méthode inconnue : ${message.method}`);
  }
});
lines.on("close", () => void Promise.allSettled(pending).then(() => process.exit(0)));
