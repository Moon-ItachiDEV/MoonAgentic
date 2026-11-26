// Lists the tools an MCP server offers: it is started (or called) briefly, as an agent would,
// asked for its tools, then let go. Kept apart from the hub to be tested on its own.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpTool } from "@moonagentic/protocol";
import { findCommand } from "./agents.ts";
import type { McpServerRecord } from "./mcp.ts";
import { killTree, spawnPlan } from "./spawn.ts";

/** A server that has not listed its tools by then is said not to answer. */
export const PROBE_TIMEOUT_MS = 30_000;
/** Pages of tools read at most, and tools kept. */
const MAX_PAGES = 20;
const MAX_TOOLS = 500;
const DESCRIPTION_LIMIT = 300;
const PROTOCOL = "2025-06-18";
/** A server's answer read at most, in characters. */
const MAX_BODY = 4 * 1024 * 1024;
/** Time a stopped command has to end on its own, and the server to let its session go. */
const STOP_GRACE_MS = 2_000;
const DELETE_TIMEOUT_MS = 3_000;

type Ask = (method: string, params?: unknown) => Promise<unknown>;
type Tell = (method: string) => Promise<void>;

interface RpcAnswer {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

const cut = (text: string) =>
  text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text;

/** What `tools/list` pages say, put together: names, and the first line of what each does. */
export async function listTools(ask: Ask): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = (await ask("tools/list", cursor ? { cursor } : {})) as {
      tools?: { name?: unknown; description?: unknown }[];
      nextCursor?: unknown;
    };
    for (const tool of result?.tools ?? []) {
      if (typeof tool.name !== "string" || !tool.name) continue;
      const line =
        typeof tool.description === "string" ? tool.description.trim().split("\n")[0]!.trim() : "";
      tools.push({ name: tool.name, ...(line ? { description: cut(line) } : {}) });
      if (tools.length >= MAX_TOOLS) return tools;
    }
    if (typeof result?.nextCursor !== "string" || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return tools;
}

const answerOf = (message: RpcAnswer): unknown => {
  if (message.error) throw new Error(message.error.message || "Le serveur MCP a refusé.");
  return message.result;
};

/** Talks to a server started by a command, one JSON message per line. */
async function overStdio(
  t: Extract<McpServerRecord["transport"], { type: "stdio" }>,
  signal: AbortSignal,
  run: (ask: Ask, tell: Tell) => Promise<McpTool[]>,
): Promise<McpTool[]> {
  // On Windows, `npx` and its kind are `.cmd` files: found on the PATH, then started by
  // cmd.exe with plain words only (see spawnPlan), never through a shell.
  const windows = process.platform === "win32";
  const plan = spawnPlan(windows ? (findCommand(t.command) ?? t.command) : t.command, t.args);
  const child = spawn(plan.command, plan.args, {
    env: { ...process.env, ...Object.fromEntries(t.env.map((e) => [e.name, e.value ?? ""])) },
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group on Unix, so stopping it also stops what it started.
    detached: !windows,
    windowsHide: true,
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  // Writes racing the server's end fail with EPIPE; its exit says why it ended.
  child.stdin.on("error", () => undefined);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const fail = (error: Error) => {
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  const ended = new Promise<never>((_, reject) => {
    const why = (code: number | null) => {
      const last = stderr.trim().split("\n").at(-1)?.trim();
      return new Error(
        last ? `Le serveur s'est arrêté : ${last}` : `Le serveur s'est arrêté (code ${code}).`,
      );
    };
    child.on("error", (e) => reject(new Error(`Impossible de lancer le serveur : ${e.message}`)));
    child.on("exit", (code) => reject(why(code)));
  });
  ended.catch(fail);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: RpcAnswer;
    try {
      message = JSON.parse(line) as RpcAnswer;
    } catch {
      // A server that writes its logs on stdout: not an answer.
      return;
    }
    if (typeof message.id !== "number") return;
    const w = waiting.get(message.id);
    if (!w) return;
    waiting.delete(message.id);
    try {
      w.resolve(answerOf(message));
    } catch (error) {
      w.reject(error as Error);
    }
  });
  let next = 0;
  const write = (body: object) => child.stdin.write(`${JSON.stringify(body)}\n`);
  const ask: Ask = (method, params) =>
    new Promise((resolve, reject) => {
      next += 1;
      waiting.set(next, { resolve, reject });
      write({ jsonrpc: "2.0", id: next, method, ...(params === undefined ? {} : { params }) });
    });
  const tell: Tell = async (method) => void write({ jsonrpc: "2.0", method });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void killTree(child, "SIGTERM");
    // What will not end on its own, or was started by it, is ended for good a moment later.
    setTimeout(() => void killTree(child, "SIGKILL"), STOP_GRACE_MS).unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([run(ask, tell), ended]);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

/** The answer to `id` in a body sent as plain JSON or as a stream of events. */
export function rpcFromBody(body: string, type: string, id: number): RpcAnswer | undefined {
  const all: RpcAnswer[] = [];
  const take = (text: string) => {
    try {
      const parsed: unknown = JSON.parse(text);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) all.push(m as RpcAnswer);
    } catch {
      // Not JSON: an event of another kind.
    }
  };
  if (type.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) take(data);
    }
  } else take(body);
  return all.find((m) => m.id === id);
}

/**
 * The answer to `id` in a response, read as it comes: a stream of events the server keeps
 * open is let go as soon as the answer is in it, and no body is read past MAX_BODY.
 */
async function answerIn(response: Response, id: number): Promise<RpcAnswer | undefined> {
  const type = response.headers.get("content-type") ?? "";
  const events = type.includes("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_BODY) throw new Error("La réponse du serveur est trop longue.");
      if (!events) continue;
      // Only whole events are looked at, each once.
      const ends = [...text.slice(read).matchAll(/\r?\n\r?\n/g)].at(-1);
      if (!ends) continue;
      const cut = read + ends.index + ends[0].length;
      const found = rpcFromBody(text.slice(read, cut), type, id);
      read = cut;
      if (found) return found;
    }
    text += decoder.decode();
    return rpcFromBody(text.slice(read), type, id);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Talks to a server at an address, each message a POST, as « Streamable HTTP » says. */
async function overHttp(
  t: Extract<McpServerRecord["transport"], { type: "http" }>,
  signal: AbortSignal,
  run: (ask: Ask, tell: Tell) => Promise<McpTool[]>,
): Promise<McpTool[]> {
  let session: string | undefined;
  let next = 0;
  const post = async (body: object) => {
    const response = await fetch(t.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...Object.fromEntries(t.headers.map((h) => [h.name, h.value ?? ""])),
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    session = response.headers.get("mcp-session-id") ?? session;
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? `Le serveur refuse l'accès (${response.status}) : vérifie ses secrets.`
          : `Le serveur a répondu ${response.status}.`,
      );
    }
    return response;
  };
  const ask: Ask = async (method, params) => {
    next += 1;
    const id = next;
    const response = await post({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const message = await answerIn(response, id);
    if (!message) throw new Error("Le serveur n'a pas répondu à la question posée.");
    return answerOf(message);
  };
  const tell: Tell = async (method) => {
    const response = await post({ jsonrpc: "2.0", method });
    await response.body?.cancel();
  };
  try {
    return await run(ask, tell);
  } finally {
    // The session is let go; a server that keeps none says so, and that is fine.
    if (session) {
      void fetch(t.url, {
        method: "DELETE",
        headers: {
          "mcp-session-id": session,
          ...Object.fromEntries(t.headers.map((h) => [h.name, h.value ?? ""])),
        },
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
}

/** Starts (or calls) the server, lists its tools, and lets it go. */
export async function probeMcpTools(
  server: McpServerRecord,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<McpTool[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const run = async (ask: Ask, tell: Tell) => {
    await ask("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "MoonAgentic", version: "1" },
    });
    await tell("notifications/initialized");
    return listTools(ask);
  };
  const timedOut = new Promise<never>((_, reject) =>
    signal.addEventListener(
      "abort",
      () => reject(new Error("Le serveur n'a pas donné ses outils à temps.")),
      { once: true },
    ),
  );
  const t = server.transport;
  const work = t.type === "stdio" ? overStdio(t, signal, run) : overHttp(t, signal, run);
  return Promise.race([work, timedOut]);
}
