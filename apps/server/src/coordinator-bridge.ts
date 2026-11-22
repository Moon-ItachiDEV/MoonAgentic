#!/usr/bin/env node
// The MCP server a coordinator's agent starts: it speaks MCP on stdin and stdout, and passes
// each tool call to the MoonAgentic server that started it. What it was started with is
// traded at once for a token kept in memory, and removed from its environment: the token
// only opens the tools of one project, and no command the agent runs can read it.
import { createInterface } from "node:readline";
import {
  BRIDGE_BOOTSTRAP_ENV,
  BRIDGE_URL_ENV,
  COORDINATOR_PATH,
  COORDINATOR_TOOLS,
} from "./coordinator-tools.ts";

const url = process.env[BRIDGE_URL_ENV];
const bootstrap = process.env[BRIDGE_BOOTSTRAP_ENV];
delete process.env[BRIDGE_BOOTSTRAP_ENV];

/** The token of this bridge alone, asked for once with what it was started with. */
const access: Promise<string | undefined> =
  url && bootstrap
    ? fetch(`${url}${COORDINATOR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bootstrap}` },
        body: JSON.stringify({ exchange: true }),
        signal: AbortSignal.timeout(10_000),
      })
        .then(async (response) =>
          response.ok ? ((await response.json()) as { token?: string }).token : undefined,
        )
        .catch(() => undefined)
    : Promise.resolve(undefined);

type Id = string | number;
const reply = (id: Id, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const refuse = (id: Id, code: number, message: string) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
const text = (value: string, isError = false) => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

async function call(tool: string, args: unknown, cancelled: AbortSignal) {
  const token = await access;
  if (!url || !token) return text("MoonAgentic n'a pas donné d'accès à ce pont.", true);
  try {
    const response = await fetch(`${url}${COORDINATOR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, args: args ?? {} }),
      signal: AbortSignal.any([cancelled, AbortSignal.timeout(60_000)]),
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
/** How to give up each call under way, when the agent says it no longer waits for it. */
const underWay = new Map<Id, AbortController>();
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
  if (message.method === "notifications/cancelled" && isRecord(message.params)) {
    const asked = message.params.requestId;
    if (typeof asked === "string" || typeof asked === "number") underWay.get(asked)?.abort();
    return;
  }
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
      const giveUp = new AbortController();
      underWay.set(id, giveUp);
      // A call the agent gave up gets no answer, as MCP asks.
      const work = call(name, params.arguments, giveUp.signal).then((result) => {
        if (!giveUp.signal.aborted) reply(id, result);
      });
      pending.add(work);
      void work.finally(() => {
        pending.delete(work);
        underWay.delete(id);
      });
      return;
    }
    default:
      refuse(id, -32601, `Méthode inconnue : ${message.method}`);
  }
});
lines.on("close", () => void Promise.allSettled(pending).then(() => process.exit(0)));
