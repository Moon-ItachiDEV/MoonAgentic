// A small, free ACP agent for development and tests. It streams text, runs a fake tool,
// asks permission before a fake edit, and shares a plan, like a real coding agent would.
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";

const pause = Number(process.env.MOONAGENTIC_DEMO_DELAY_MS ?? 0);
const cancelled = new Set<string>();

const app = acp
  .agent({ name: "demo" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "moonagentic-demo", version: "0.1.0" },
  }))
  .onRequest("session/new", () => ({ sessionId: randomUUID() }))
  .onNotification("session/cancel", ({ params }) => {
    cancelled.add(params.sessionId);
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params;
    cancelled.delete(sessionId);
    const ask = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    const update = async (u: acp.SessionUpdate) => {
      if (pause) await delay(pause);
      await client.notify("session/update", { sessionId, update: u });
    };
    const say = async (text: string, kind: "agent_message_chunk" | "agent_thought_chunk") => {
      for (const word of text.split(/(?<= )/)) {
        await update({ sessionUpdate: kind, content: { type: "text", text: word } });
      }
    };

    if (ask.includes("boom")) throw new Error("Le démo a planté exprès.");

    await say("Je regarde le projet avant de toucher quoi que ce soit.", "agent_thought_chunk");
    await update({
      sessionUpdate: "plan",
      entries: [
        { content: "Lire le code concerné", priority: "high", status: "in_progress" },
        { content: "Proposer la modification", priority: "high", status: "pending" },
      ],
    });
    await update({
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Lire src/app.ts",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "export const answer = 41;" } }],
    });
    await say(`Tu m'as demandé : « ${ask} ». `, "agent_message_chunk");

    const edit = {
      toolCallId: "edit-1",
      title: "Modifier src/app.ts",
      kind: "edit" as const,
      status: "pending" as const,
      content: [
        {
          type: "diff" as const,
          path: "src/app.ts",
          oldText: "export const answer = 41;",
          newText: "export const answer = 42;",
        },
      ],
    };
    await update({ sessionUpdate: "tool_call", ...edit });
    const request = {
      sessionId,
      toolCall: edit,
      options: [
        { optionId: "allow", name: "Autoriser", kind: "allow_once" },
        { optionId: "reject", name: "Refuser", kind: "reject_once" },
      ],
    } satisfies acp.RequestPermissionRequest;
    const permission: acp.RequestPermissionResponse = await client.request(
      "session/request_permission",
      request,
    );
    if (cancelled.has(sessionId) || permission.outcome.outcome === "cancelled") {
      return { stopReason: "cancelled" };
    }
    const allowed = permission.outcome.optionId === "allow";
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: allowed ? "completed" : "failed",
    });
    await update({
      sessionUpdate: "plan",
      entries: [
        { content: "Lire le code concerné", priority: "high", status: "completed" },
        { content: "Proposer la modification", priority: "high", status: "completed" },
      ],
    });
    await say(
      allowed ? "C'est fait, la réponse vaut 42." : "D'accord, je ne touche à rien.",
      "agent_message_chunk",
    );
    return { stopReason: "end_turn" };
  });

const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
