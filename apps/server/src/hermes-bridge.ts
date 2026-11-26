#!/usr/bin/env node
// The MCP server Hermes Agent starts, from its `config.yaml`: it speaks MCP on stdin and
// stdout, and passes each tool call to MoonAgentic on this computer. Started with MoonAgentic's
// address and the file holding Hermes's access, read again at each call: an access renewed or
// taken away in the settings counts at once, without restarting Hermes.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ASK_WAIT_MS, HERMES_PATH, HERMES_TOOLS } from "./hermes-tools.ts";

const [url, tokenFile] = process.argv.slice(2);

type Id = string | number;
const reply = (id: Id, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const refuse = (id: Id, code: number, message: string) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
const text = (value: string, isError = false) => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

function token(): string | undefined {
  if (!tokenFile) return undefined;
  try {
    return readFileSync(tokenFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function call(tool: string, args: unknown, cancelled: AbortSignal) {
  const access = token();
  if (!url || !access) {
    return text(
      "MoonAgentic n'a pas donné d'accès à Hermes : Réglages › Hermes · Discord › Connecter Hermes.",
      true,
    );
  }
  try {
    const response = await fetch(`${url}${HERMES_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ tool, args: args ?? {} }),
      signal: AbortSignal.any([
        cancelled,
        AbortSignal.timeout(tool === "ask_coordinator" ? ASK_WAIT_MS + 60_000 : 60_000),
      ]),
    });
    // A refusal before MoonAgentic reads the call (403, 405, 429) may have no JSON body.
    const body = (await response.json().catch(() => ({}))) as {
      result?: unknown;
      error?: string;
      message?: string;
    };
    if (!response.ok || body.error) {
      return text(body.error ?? body.message ?? `MoonAgentic a refusé (${response.status}).`, true);
    }
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

const pending = new Set<Promise<unknown>>();
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
      reply(id, { tools: HERMES_TOOLS });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!HERMES_TOOLS.some((t) => t.name === name)) {
        refuse(id, -32602, `Outil inconnu : ${name}`);
        return;
      }
      const giveUp = new AbortController();
      underWay.set(id, giveUp);
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
lines.on("close", () => {
  for (const giveUp of underWay.values()) giveUp.abort();
  void Promise.allSettled(pending).then(() => process.exit(0));
});
