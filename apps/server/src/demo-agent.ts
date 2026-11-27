// A small, free ACP agent for development and tests. It streams text, runs a fake tool,
// asks permission before a fake edit, and shares a plan, like a real coding agent would.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";

const pause = Number(process.env.MOONAGENTIC_DEMO_DELAY_MS ?? 0);
// How the demo offers models: as a config option (default), the older `models` field, or not at all.
const modelStyle = process.env.MOONAGENTIC_DEMO_MODELS ?? "options";
const cancelled = new Set<string>();
const models = new Map<string, string>();
const modes = new Map<string, string>();
const efforts = new Map<string, string>();
const used = new Map<string, number>();
const mcpNames = new Map<string, string[]>();
/** The MCP servers each session was given, to call the tools of one as a real agent does. */
const mcpServers = new Map<string, acp.McpServer[]>();

type Ask = (method: string, params: unknown) => Promise<unknown>;
/** The « moonagentic » server of each session, started once and kept, as a real agent does. */
const bridges = new Map<string, Promise<Ask>>();

function bridgeOf(sessionId: string, server: acp.McpServerStdio): Promise<Ask> {
  const known = bridges.get(sessionId);
  if (known) return known;
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const answers = createInterface({ input: child.stdout });
  const waiting = new Map<number, (result: unknown) => void>();
  answers.on("line", (line) => {
    const message = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
    waiting.get(message.id)?.(message.result ?? message.error);
  });
  let next = 0;
  const ask: Ask = (method, params) =>
    new Promise<unknown>((resolve) => {
      next += 1;
      waiting.set(next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    });
  const started = ask("initialize", { protocolVersion: "2025-06-18", capabilities: {} }).then(
    () => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      return ask;
    },
  );
  bridges.set(sessionId, started);
  return started;
}

/**
 * Calls a tool of the « moonagentic » MCP server the session was given, as a real agent
 * would: through the server it started for the session. Returns what the tool said.
 */
async function callMoonAgentic(sessionId: string, name: string, args: unknown): Promise<string> {
  const server = mcpServers.get(sessionId)?.find((m) => m.name === "moonagentic");
  if (!server || !("command" in server)) return "Aucun outil MoonAgentic dans cette session.";
  const ask = await bridgeOf(sessionId, server);
  const result = (await ask("tools/call", { name, arguments: args })) as {
    content?: { text: string }[];
  };
  return result.content?.[0]?.text ?? JSON.stringify(result);
}

/** The folder each session works in. */
const cwds = new Map<string, string>();
/** The demo's generated image: 480 by 320 pixels, a sky over the ice, drawn as a PNG. */
const DEMO_PNG = (() => {
  const [width, height] = [480, 320];
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const ice = y > height * 0.62;
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const t = y / height;
      rows[at] = ice ? 225 : Math.round(40 + 120 * t);
      rows[at + 1] = ice ? 238 : Math.round(80 + 110 * t);
      rows[at + 2] = ice ? 248 : Math.round(190 + 50 * t);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 2; // red, green, blue
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

/** A file of 1,200 lines: a result too large to travel with the timeline. */
const BIG_FILE = Array.from(
  { length: 1200 },
  (_, n) => `export const ligne${n + 1} = ${n + 1};`,
).join("\n");

/** A long answer with all that Markdown costs to draw: titles, lists, a table, code. */
const LONG_ANSWER = Array.from(
  { length: 12 },
  (_, n) =>
    `## Partie ${n + 1}\n\n` +
    "Voici une explication assez longue pour ressembler à une vraie réponse, avec du **gras**, " +
    "du `code` en ligne et un [lien](https://example.com). Elle continue sur plusieurs phrases " +
    "pour que le texte grandisse pendant que tu le lis.\n\n" +
    "- un premier point, avec quelques mots de plus\n- un deuxième point\n- un troisième\n\n" +
    "| Fichier | Rôle |\n| --- | --- |\n| `app.ts` | le point d'entrée |\n| `hub.ts` | l'état |\n\n" +
    "```ts\nexport function answer(): number {\n  return 42;\n}\n```\n\n",
).join("");

const CONTEXT_SIZE = 200_000;
/** Characters that are not seen and change how a text reads, for « /trompeur ». */
const RLO = "\u202E";
const PDF = "\u202C";
const ZWSP = "\u200B";

const modeChoices = [
  { id: "agent", name: "Agent", description: "Lit et modifie le code" },
  { id: "plan", name: "Plan", description: "Propose sans rien modifier" },
];

const configOptions = (sessionId: string): acp.SessionConfigOption[] => [
  {
    id: "model",
    name: "Modèle",
    category: "model",
    type: "select",
    currentValue: models.get(sessionId) ?? "rapide",
    options: [
      { value: "rapide", name: "Démo rapide" },
      { value: "precis", name: "Démo précis", description: "Prend son temps" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: modes.get(sessionId) ?? "agent",
    options: modeChoices.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: efforts.get(sessionId) ?? "moyen",
    options: [
      { value: "bas", name: "Bas" },
      { value: "moyen", name: "Moyen" },
      { value: "haut", name: "Haut" },
      // Like real agents, a bigger model offers more effort levels.
      ...(models.get(sessionId) === "precis" ? [{ value: "max", name: "Max" }] : []),
    ],
  },
];

const legacyModes = (sessionId: string): acp.SessionModeState => ({
  availableModes: modeChoices,
  currentModeId: modes.get(sessionId) ?? "agent",
});

const legacyModels = (sessionId: string) => ({
  availableModels: [
    { modelId: "rapide", name: "Démo rapide" },
    { modelId: "precis", name: "Démo précis" },
  ],
  currentModelId: models.get(sessionId) ?? "rapide",
});

const app = acp
  .agent({ name: "demo" })
  .onRequest("initialize", async () => {
    // Stands for an agent stuck at startup, such as one waiting for a sign-in.
    if (modelStyle === "hang") await new Promise(() => undefined);
    if (modelStyle === "fail") throw new Error("Connecte-toi d'abord.");
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: modelStyle === "load" || modelStyle === "resume-fail",
        // Stands for an agent that says it resumes sessions but fails to, and can reload them.
        ...(modelStyle === "resume-fail" ? { sessionCapabilities: { resume: {} } } : {}),
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          embeddedContext: process.env.MOONAGENTIC_DEMO_EMBED !== "0",
          image: process.env.MOONAGENTIC_DEMO_IMAGES !== "0",
        },
      },
      agentInfo: { name: "moonagentic-demo", version: "0.1.0" },
    };
  })
  .onRequest("session/new", ({ params, client }) => {
    // Stands for an agent whose user has not signed in with its own tool yet.
    if (modelStyle === "auth") throw acp.RequestError.authRequired();
    const sessionId = randomUUID();
    cwds.set(sessionId, params.cwd);
    mcpNames.set(
      sessionId,
      params.mcpServers.map((m) => m.name).filter((name) => name !== "moonagentic"),
    );
    mcpServers.set(sessionId, params.mcpServers);
    // Lists its commands right behind the reply naming the session, often in the same read.
    queueMicrotask(() => {
      void client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "Résume la conversation" },
            { name: "init", description: "Écrit le fichier d'instructions du dépôt (démo)" },
            {
              name: "explique",
              description: "Explique un fichier (démo)",
              input: { hint: "fichier à expliquer" },
            },
          ],
        },
      });
    });
    if (modelStyle === "legacy")
      return { sessionId, models: legacyModels(sessionId), modes: legacyModes(sessionId) };
    if (modelStyle === "none") return { sessionId };
    return { sessionId, configOptions: configOptions(sessionId) };
  })
  .onRequest(
    "session/set_model",
    (params) => params as { sessionId: string; modelId: string },
    ({ params }) => {
      models.set(params.sessionId, params.modelId);
      return {};
    },
  )
  .onRequest("session/resume", () => {
    throw new Error("Session introuvable.");
  })
  // Like a real agent reloading a saved session: it replays the model the session last ran.
  .onRequest("session/load", async ({ params, client }) => {
    const { sessionId } = params;
    cwds.set(sessionId, params.cwd);
    mcpNames.set(
      sessionId,
      params.mcpServers.map((m) => m.name),
    );
    await client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: configOptions(sessionId) },
    });
    // Then where its reloaded context stands, as current state rather than history.
    used.set(sessionId, 99_000);
    await client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 99_000, size: CONTEXT_SIZE },
    });
    return { configOptions: configOptions(sessionId) };
  })
  .onRequest("session/set_config_option", ({ params }) => {
    if ("value" in params && typeof params.value === "string") {
      const settings = { model: models, mode: modes, effort: efforts }[params.configId];
      settings?.set(params.sessionId, params.value);
    }
    return { configOptions: configOptions(params.sessionId) };
  })
  .onRequest("session/set_mode", ({ params }) => {
    modes.set(params.sessionId, params.modeId);
    return {};
  })
  .onNotification("session/cancel", ({ params }) => {
    cancelled.add(params.sessionId);
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params;
    cancelled.delete(sessionId);
    const texts = params.prompt.flatMap((b) => (b.type === "text" ? [b.text] : []));
    // Files and skills the message points at come after its text, as links or as content.
    const attached = params.prompt.flatMap((b) =>
      b.type === "image"
        ? [`${b.mimeType}, ${Buffer.from(b.data, "base64").length} octets (image)`]
        : b.type === "resource_link"
          ? [`${b.name} (lien)`]
          : b.type === "resource" && "text" in b.resource
            ? [`${decodeURIComponent(b.resource.uri.split("/").pop() ?? "")} (texte)`]
            : [],
    );
    // The last block is the user's message; one before it carries project memory and/or earlier conversation.
    const ask = texts.at(-1) ?? "";
    const firstAsk = texts.length > 1 ? texts[0]?.match(/^Utilisateur : (.*)$/m)?.[1] : undefined;
    const memoryLine =
      texts.length > 1
        ? texts[0]
            ?.match(
              /^Mémoire partagée du projet[^\n]*:\n\n([\s\S]*?)(?:\n\nTu reprends une conversation|$)/,
            )?.[1]
            ?.trim()
        : undefined;
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
    // A subscription quota run out, for the models the file lists (« model » or « model|words »):
    // read at every message, so a test can spend a quota and give it back.
    const quotaFile = process.env.MOONAGENTIC_DEMO_QUOTA_FILE;
    if (quotaFile && existsSync(quotaFile)) {
      const model = models.get(sessionId) ?? "rapide";
      for (const line of readFileSync(quotaFile, "utf8").split("\n")) {
        const [spent, words] = line.trim().split("|");
        if (spent === model) {
          throw new Error(words || "You've hit your usage limit. Try again in 2 hours.");
        }
      }
    }

    // As Hydrogen does out of any project: its tool at work for a while, the image made in its
    // own folder, and an answer that only links to it by its name.
    if (ask.includes("dessine une image")) {
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "image",
        title: "generate_image",
        kind: "other",
        status: "in_progress",
      });
      await delay(Number(process.env.MOONAGENTIC_DEMO_IMAGE_MS ?? 2500));
      // Started from the command line, as the app does: `antigravity-cli`, not `antigravity`.
      const made = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain", sessionId);
      mkdirSync(made, { recursive: true });
      const name = `lune_${Date.now()}.png`;
      writeFileSync(path.join(made, name), DEMO_PNG);
      await update({ sessionUpdate: "tool_call_update", toolCallId: "image", status: "completed" });
      await say(`Voici l'image de la lune.\n\n[${name}](${name})`, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }

    // As Codex does: the image is told in the tool's result only (its address, `savedPath`),
    // and the answer says « Voici l'image » without naming any file.
    if (ask.includes("peins une image")) {
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "ig_1",
        title: "Image generation",
        kind: "other",
        status: "in_progress",
      });
      await delay(Number(process.env.MOONAGENTIC_DEMO_IMAGE_MS ?? 2500));
      const made = path.join(os.homedir(), ".codex", "generated_images", sessionId);
      mkdirSync(made, { recursive: true });
      const savedPath = path.join(made, `ig_${Date.now()}.png`);
      writeFileSync(savedPath, DEMO_PNG);
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "ig_1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "image",
              data: DEMO_PNG.toString("base64"),
              mimeType: "image/png",
              uri: savedPath,
            },
          },
        ],
        rawOutput: { status: "completed", savedPath },
      });
      await say("Voici la lune au-dessus des toits.", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }

    // As Antigravity does: the image made in its own folder, a copy in the project, and an
    // answer that names both as paths of the computer.
    if (ask.includes("génère une image")) {
      const made = path.join(os.homedir(), ".gemini", "antigravity", "brain", sessionId);
      mkdirSync(made, { recursive: true });
      const original = path.join(made, `pingouin_${Date.now()}.png`);
      writeFileSync(original, DEMO_PNG);
      const cwd = cwds.get(sessionId);
      if (cwd) writeFileSync(path.join(cwd, "pingouin.png"), DEMO_PNG);
      await say(
        `Voici l'image :\n\n![Pingouin qui mange](${original})\n\n` +
          `- [pingouin.png](${pathToFileURL(path.join(cwd ?? made, "pingouin.png")).href})\n` +
          `- Copie d'origine : [${path.basename(original)}](${pathToFileURL(original).href})`,
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }

    // A goal over several turns: reached on the turn its text names (« atteint au tour 3 »),
    // blocked when it says it cannot be done alone, else one more step each turn.
    const goalTurn = /^Objectif fixé par l'utilisateur \(tour (\d+) sur \d+/m.exec(ask);
    if (goalTurn) {
      const turn = Number(goalTurn[1]);
      const at = Number(/atteint au tour (\d+)/.exec(ask)?.[1] ?? 0);
      await say(
        ask.includes("impossible sans toi")
          ? "Je ne peux pas continuer seul.\n\nOBJECTIF BLOQUÉ : il me faut la clé d'API"
          : at && turn >= at
            ? `Tour ${turn} : tout est vérifié.\n\nOBJECTIF ATTEINT`
            : `Tour ${turn} : j'avance, il reste du travail.`,
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }

    // A longer task in five steps, each with its tool, so a plan can be seen moving on.
    if (ask.includes("en 5 étapes")) {
      const steps: [string, acp.ToolKind, string][] = [
        ["Lire le code concerné", "read", "Lire src/app.ts"],
        ["Chercher où answer est utilisé", "search", "Chercher answer dans src"],
        ["Modifier la valeur de answer", "edit", "Modifier src/app.ts"],
        ["Lancer les tests", "execute", "`pnpm test`"],
        ["Résumer le changement", "think", "Relire le diff"],
      ];
      const plan = (at: number) =>
        update({
          sessionUpdate: "plan",
          entries: steps.map(([content], i) => ({
            content,
            priority: "medium" as const,
            status:
              i < at
                ? ("completed" as const)
                : i === at
                  ? ("in_progress" as const)
                  : ("pending" as const),
          })),
        });
      for (const [i, [, kind, title]] of steps.entries()) {
        await plan(i);
        await update({
          sessionUpdate: "tool_call",
          toolCallId: `step-${i}`,
          title,
          kind,
          status: "in_progress",
        });
        await delay(900 + i * 300);
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: `step-${i}`,
          status: "completed",
        });
      }
      await plan(steps.length);
      await say("Fait en 5 étapes : answer vaut 42 et les tests passent.", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    const usage = async (tokens: number, priced = true) => {
      used.set(sessionId, tokens);
      // Priced like a real agent, which says what the session has cost so far.
      await update({
        sessionUpdate: "usage_update",
        used: tokens,
        size: CONTEXT_SIZE,
        ...(priced ? { cost: { amount: tokens / 100_000, currency: "USD" } } : {}),
      });
    };
    // As a coordinator's agent does: a real call to MoonAgentic's own tools.
    // Its part, given before the message, comes in the same text: the message is the end.
    const opening = ask.match(/(?:^|\n)\/ouvre (.+)$/);
    if (opening) {
      const said = await callMoonAgentic(sessionId, "open_thread", {
        task_key: opening[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        title: opening[1],
        brief: `Corrige : ${opening[1]}`,
        kind: "bug",
      });
      await say(
        said.includes('"opened"') ? `J'ai ouvert le fil « ${opening[1]} ».` : said,
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }
    // As Antigravity does: it asks before its MoonAgentic tool, named only in the title.
    const agy = ask.trim().match(/(?:^|\n)\/fils-agy( commande)?$/);
    if (agy) {
      const call = {
        toolCallId: "agy-list",
        title: "Run mcp_moonagentic_list_threads",
        // A command dressed in that title must still wait for the user.
        kind: agy[1] ? ("execute" as const) : ("other" as const),
      };
      await update({ sessionUpdate: "tool_call", ...call, status: "pending" });
      const permission: acp.RequestPermissionResponse = await client.request(
        "session/request_permission",
        {
          sessionId,
          toolCall: call,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        } satisfies acp.RequestPermissionRequest,
      );
      if (permission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
      await update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      await say("Liste lue.", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (/(?:^|\n)\/fils$/.test(ask.trim())) {
      const said = await callMoonAgentic(sessionId, "list_threads", {});
      let count: number | undefined;
      try {
        count = (JSON.parse(said) as unknown[]).length;
      } catch {
        // not a list: what the tool said is shown as it is
      }
      await say(
        count === undefined ? said : `Ce projet a ${count} fil${count > 1 ? "s" : ""}.`,
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }
    const searching = ask.trim().match(/(?:^|\n)\/cherche (.+)$/);
    if (searching) {
      const said = await callMoonAgentic(sessionId, "search_threads", { query: searching[1] });
      await say(said, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    // `/consignes`: what it was told before the message, as it was told.
    if (ask.trim() === "/consignes") {
      await say(texts.length > 1 ? (texts[0] ?? "") : "Aucune consigne.", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    // `/publie <titre>`: a page of its own, with a script, published as an artifact; then
    // `/publie <titre> = <path>` publishes a file of the thread's folder, and
    // `/publie <titre> # <artifact_id>` a new version of one published before.
    const publishing = ask.trim().match(/(?:^|\n)\/publie ([^=#\n]+?)(?: = (\S+)| # (\S+))?$/);
    if (publishing) {
      const [, title, file, again] = publishing;
      const call = { toolCallId: `publish-${randomUUID()}`, title: "publish_artifact" };
      await update({ sessionUpdate: "tool_call", ...call, kind: "other", status: "in_progress" });
      const said = await callMoonAgentic(sessionId, "publish_artifact", {
        title,
        ...(file
          ? { path: file }
          : {
              content: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><button id="b" onclick="this.textContent='Touché'">Toucher</button><p id="v">${again ? "Version suivante" : "Première version"}</p><script>document.body.insertAdjacentHTML("beforeend", '<p id="lance">script lancé</p>')</script></body></html>`,
            }),
        ...(again ? { artifact_id: again } : {}),
      });
      await update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      await say(said, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (/(?:^|\n)\/memoire$/.test(ask.trim())) {
      const said = await callMoonAgentic(sessionId, "read_memory", {});
      await say(said, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    const noting = ask.trim().match(/(?:^|\n)\/note (.+)$/);
    if (noting) {
      const call = {
        toolCallId: `save-mem-${randomUUID()}`,
        title: "Run mcp_moonagentic_save_memory",
        kind: "other" as const,
      };
      await update({ sessionUpdate: "tool_call", ...call, status: "pending" });
      const permission: acp.RequestPermissionResponse = await client.request(
        "session/request_permission",
        {
          sessionId,
          toolCall: call,
          options: [
            { optionId: "allow", name: "Autoriser", kind: "allow_once" },
            { optionId: "reject", name: "Refuser", kind: "reject_once" },
          ],
        } satisfies acp.RequestPermissionRequest,
      );
      if (permission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
      if (permission.outcome.optionId !== "allow") {
        await update({ sessionUpdate: "tool_call_update", ...call, status: "failed" });
        await say("Refusé.", "agent_message_chunk");
        return { stopReason: "end_turn" };
      }
      const said = await callMoonAgentic(sessionId, "save_memory", { content: noting[1] });
      await update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      await say(said, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (/(?:^|\n)\/mcp-outils$/.test(ask.trim())) {
      const server = mcpServers.get(sessionId)?.find((m) => m.name === "moonagentic");
      if (!server || !("command" in server)) {
        await say("Aucun outil MoonAgentic dans cette session.", "agent_message_chunk");
        return { stopReason: "end_turn" };
      }
      const askBridge = await bridgeOf(sessionId, server);
      const listed = (await askBridge("tools/list", {})) as { tools?: { name: string }[] };
      await say((listed.tools ?? []).map((t) => t.name).join(", "), "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/compact") {
      await say("Contexte compacté.", "agent_message_chunk");
      // Only the tokens this time, as some agents do.
      await usage(3_000, false);
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/flux") {
      // Stands for a fast model: a long Markdown answer, sent word by word without a pause.
      await say(LONG_ANSWER, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/fige") {
      // Stands for a frozen agent: it ignores « Arrêter » and never ends its turn.
      await say("Je réfléchis…", "agent_message_chunk");
      await new Promise(() => undefined);
    }
    if (ask.trim() === "/choix" || ask.trim() === "/apercus") {
      // As Claude Code asks: a tool call, then a form the turn waits on; the answer comes
      // back as the form's content and the turn goes on.
      const previews = ask.trim() === "/apercus";
      const call = { toolCallId: `choice-${randomUUID()}`, title: "AskUserQuestion" };
      await update({ sessionUpdate: "tool_call", ...call, kind: "other", status: "pending" });
      const option = (label: string, description: string, preview?: string) => ({
        const: label,
        title: label,
        ...(previews ? {} : { description }),
        ...(previews && preview ? { _meta: { "_claude/askUserQuestionOption": { preview } } } : {}),
      });
      const answer: acp.CreateElicitationResponse = await client.request("elicitation/create", {
        mode: "form",
        sessionId,
        toolCallId: call.toolCallId,
        message: previews ? "Quelle forme pour l'appel d'envoi ?" : "Quelle file de messages ?",
        requestedSchema: {
          type: "object",
          properties: {
            question_0: {
              type: "string",
              oneOf: previews
                ? [
                    option("Fonction simple", "", 'await send(\n  "ingest",\n  event,\n)'),
                    option(
                      "Client typé (Recommandé)",
                      "",
                      'const q = queue("ingest")\n\nawait q.send(event)\nawait q.flush()',
                    ),
                    option("Par lot", "", 'await sendMany(\n  "ingest",\n  events,\n)'),
                  ]
                : [
                    option("Kafka (Recommandé)", "Journal durable, un jour d'événements à rejouer"),
                    option("SQS", "Géré, rien à faire tourner, mais pas de rejeu"),
                    option("File Postgres", "La base que tu as déjà, elle ne tiendra pas les pics"),
                  ],
            },
            question_0_custom: { type: "string", title: "Other" },
          },
        },
      } as acp.CreateElicitationRequest);
      if (cancelled.has(sessionId) || answer.action === "cancel") {
        return { stopReason: "cancelled" };
      }
      await update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      const content: Record<string, unknown> =
        (answer.action === "accept"
          ? (answer as { content?: Record<string, unknown> | null }).content
          : null) ?? {};
      const said = [content.question_0, content.question_0_custom].filter(Boolean).join(" · ");
      await say(said ? `Compris : ${said}.` : "Pas de réponse.", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/crash") {
      // As an agent whose process is shut down in the middle of a turn: what it said so far
      // stays, then its connection closes.
      await say("Je commence le travail…", "agent_message_chunk");
      setTimeout(() => {
        process.stderr.write("ACP connection closed\n");
        process.exit(1);
      }, 50);
      return new Promise<never>(() => undefined);
    }
    if (ask.trim() === "/trompeur") {
      // As an agent told what to write by a page it read: a tool call and a permission whose
      // words hold characters that reorder them or take no room, and read as something else.
      const call = {
        toolCallId: "read-odd",
        title: `Lire le fichier ${RLO}hs.tixe-lruc${PDF} README.md\n`,
        // A fetch asks even in « Demande d'abord », where a read would pass.
        kind: "fetch" as const,
        status: "pending" as const,
      };
      await update({ sessionUpdate: "tool_call", ...call });
      const odd: acp.RequestPermissionResponse = await client.request(
        "session/request_permission",
        {
          sessionId,
          toolCall: call,
          options: [
            { optionId: "allow", name: `Auto${ZWSP}riser`, kind: "allow_once" },
            { optionId: "reject", name: `${RLO}resufeR`, kind: "reject_once" },
          ],
        } satisfies acp.RequestPermissionRequest,
      );
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: call.toolCallId,
        status: "completed",
      });
      const picked = odd.outcome.outcome === "selected" ? odd.outcome.optionId : "rien";
      await say(`Réponse reçue : ${picked}.`, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/verdict") {
      // As a reviewer answers a coordinator: the verdict in a sentence, then the card's block.
      await say(
        "La PR 155 n'est pas prête : le masquage des secrets laisse encore passer des mots de passe et des cookies. Pas de conflit avec main.\n\n" +
          "```moon-revue\n" +
          JSON.stringify({
            verdict: "a-corriger",
            bloquants: [
              {
                texte: "Les options --token= et --password= ne sont plus masquées",
                ou: "redact.ts:36",
              },
              { texte: "Les cookies écrits en JSON passent en clair", ou: "redact.ts:43" },
            ],
            importants: [
              { texte: "Un guillemet échappé laisse fuiter la fin du secret", ou: "redact.ts:38" },
            ],
            remarques: [{ texte: "Le nom de la fonction ne dit pas ce qu'elle masque" }],
            verifs: [
              { texte: "Pas de conflit avec main", ok: true },
              { texte: "Tests Windows, installeurs Mac et Windows", ok: true },
            ],
          }) +
          "\n```",
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/autorisations") {
      // As a review runs: reads and read-only commands, then a test command twice.
      const calls = [
        { toolCallId: "p-read", title: "Lire README.md", kind: "read" as const },
        {
          toolCallId: "p-diff",
          title: "git diff main",
          kind: "execute" as const,
          rawInput: { command: ["bash", "-lc", "git diff main --stat && git log -3"] },
        },
        {
          toolCallId: "p-test",
          title: "npm test",
          kind: "execute" as const,
          rawInput: { command: "npm test" },
        },
        {
          toolCallId: "p-test2",
          title: "npm test -- --run",
          kind: "execute" as const,
          rawInput: { command: "npm test -- --run" },
        },
        {
          toolCallId: "p-chained",
          title: "npm test && rm -rf dist",
          kind: "execute" as const,
          rawInput: { command: "npm test && rm -rf dist" },
        },
        {
          toolCallId: "p-redirect",
          title: "npm test > out.txt",
          kind: "execute" as const,
          rawInput: { command: "npm test > out.txt" },
        },
        {
          toolCallId: "p-rm",
          title: "rm -rf dist",
          kind: "execute" as const,
          rawInput: { command: "rm -rf dist" },
        },
      ];
      const picked: string[] = [];
      for (const call of calls) {
        await update({ sessionUpdate: "tool_call", ...call, status: "pending" });
        const answer: acp.RequestPermissionResponse = await client.request(
          "session/request_permission",
          {
            sessionId,
            toolCall: call,
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          } satisfies acp.RequestPermissionRequest,
        );
        picked.push(answer.outcome.outcome === "selected" ? answer.outcome.optionId : "rien");
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: call.toolCallId,
          status: "completed",
        });
      }
      await say(`Réponses : ${picked.join(", ")}.`, "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    if (ask.trim() === "/question") {
      // As Antigravity asks: a tool call left unfinished, the question as text, and the
      // turn ends; the answer is the next message.
      const question = {
        toolCallId: "ask-1",
        title: "Run ask_question",
        kind: "other" as const,
        rawInput: {
          questions: [
            {
              question: "Quelle couleur préfères-tu ?",
              options: ["(Recommandé) Bleu", "Vert", "Rouge"],
              is_multi_select: false,
            },
          ],
        },
      };
      await update({ sessionUpdate: "tool_call", ...question, status: "in_progress" });
      await update({ sessionUpdate: "tool_call_update", ...question, status: "pending" });
      await say("Quelle couleur préfères-tu ?", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    await usage((used.get(sessionId) ?? 0) + 24_000);
    if (ask.startsWith("Je n'ai pas trouvé ton plan")) {
      await say("Toujours pas de plan.", "agent_message_chunk");
      return { stopReason: "end_turn" };
    }
    // A team's reviewer and tester answer with the verdict MoonAgentic reads.
    const answer = async (text: string) => {
      await say(text, "agent_message_chunk");
      return { stopReason: "end_turn" as const };
    };
    if (ask.startsWith("Tu relis le travail d'un codeur")) {
      if (ask.includes("toujours refuser") || ask.includes("à arbitrer")) {
        return answer("Il manque une vérification de answer.\n\nVERDICT : À CORRIGER");
      }
      if (ask.includes("sans verdict")) return answer("Ça me paraît correct.");
      return answer("Le travail est fait, sans oubli.\n\nVERDICT : OK");
    }
    if (ask.startsWith("Je n'ai pas trouvé ton verdict")) return answer("**VERDICT : OK**");
    // A team's judge weighs the reviews: the remark does not hold.
    if (ask.startsWith("Tu arbitres les relectures")) {
      return answer("La vérification demandée existe déjà : rien à corriger.\n\nVERDICT : OK");
    }
    // A reviewer of « /revue »: findings on the first file changed, a little different from
    // one model to the other, so they are put together as common and single points.
    if (ask.startsWith("Tu relis la pull request #")) {
      if (ask.includes("sans constats")) return answer("La PR me paraît correcte.");
      const file = /^--- (\S+) \(/m.exec(ask)?.[1] ?? "README.md";
      const precise = models.get(sessionId) === "precis";
      const findings = precise
        ? [
            {
              severity: "majeur",
              file,
              line: 2,
              title: "La nouvelle valeur n'est vérifiée par aucun test",
              detail: "Ajoute un test qui lit la valeur changée.",
            },
            {
              severity: "mineur",
              file,
              line: 40,
              title: "Le message d'erreur ne dit pas quoi faire",
            },
          ]
        : [
            {
              severity: "critique",
              file,
              line: 1,
              title: "Aucun test ne couvre la valeur changée",
              detail: "Une régression passerait inaperçue : couvre-la par un test.",
            },
          ];
      return answer("J'ai relu la PR.\n\n```json\n" + JSON.stringify({ findings }) + "\n```");
    }
    // The confrontation: the fast model disputes what it did not find, the precise one agrees.
    if (ask.startsWith("Les autres relecteurs ont fini.")) {
      const precise = models.get(sessionId) === "precis";
      const verdicts = [...ask.matchAll(/^(\d+)\. \[[^\]]+\] .*, relevé par (.*)$/gm)].map((m) => {
        const mine = /\btoi\b/.test(m[2] ?? "");
        return {
          point: Number(m[1]),
          verdict: precise || mine ? "accord" : "désaccord",
          reason:
            precise || mine ? "Je le vois aussi dans le code." : "Ce cas ne peut pas arriver ici.",
        };
      });
      return answer(
        "Mon avis sur chaque point.\n\n```json\n" + JSON.stringify({ verdicts }) + "\n```",
      );
    }
    // As the judge, it finds each disputed point real, but minor.
    if (ask.startsWith("Tu es l'arbitre")) {
      const rulings = [...ask.matchAll(/^(\d+)\. \[/gm)].map((m) => ({
        point: Number(m[1]),
        verdict: "réel",
        severity: "mineur",
        reason: "Le cas arrive bien, mais sans gros impact.",
      }));
      return answer("J'ai tranché.\n\n```json\n" + JSON.stringify({ rulings }) + "\n```");
    }
    if (ask.startsWith("Je n'ai pas trouvé ton bloc de constats")) {
      return answer('```json\n{"findings": []}\n```');
    }
    // A team's merger cannot settle a conflict, but checks the pieces together.
    // It gives up on a conflict as an agent might: it aborts the merge.
    if (ask.startsWith("Tu fusionnes le travail d'une équipe")) {
      const cwd = cwds.get(sessionId);
      if (cwd) execFileSync("git", ["merge", "--abort"], { cwd, stdio: "ignore" });
      return answer("Je ne sais pas régler ce conflit : j'ai annulé la fusion.");
    }
    if (ask.startsWith("Toutes les sous-tâches de l'équipe sont fusionnées")) {
      return answer("Les tests passent avec toutes les sous-tâches.\n\nVERDICT : OK");
    }
    if (ask.startsWith("Tu testes le travail d'un codeur")) {
      return answer("J'ai lancé les tests : tout passe.\n\nVERDICT : OK");
    }
    // As a lead whose piece is stuck, it rewrites the brief.
    if (ask.startsWith("La sous-tâche « ") && ask.includes("bloque après")) {
      return answer(
        'Nouvelle consigne :\n\n```json\n{"brief": "Passe answer à 42, et rien d\'autre."}\n```',
      );
    }
    // As a team lead given a mission on the way, it adds one piece to its plan.
    if (ask.startsWith("L'utilisateur ajoute une mission")) {
      const plan = {
        tasks: [{ title: "Mission ajoutée", brief: "Ajoute une ligne dans MISSION.md." }],
      };
      return answer("Je l'ajoute au plan.\n\n```json\n" + JSON.stringify(plan) + "\n```");
    }
    // As a team lead, it splits the work into two pieces, the way MoonAgentic asks.
    if (ask.includes("tu es le chef d'une équipe") || ask.includes("Tu es le chef d'une équipe")) {
      if (ask.includes("sans plan")) {
        await say("Je préfère ne pas faire de plan.", "agent_message_chunk");
        return { stopReason: "end_turn" };
      }
      // Two pieces writing the same file, for a team whose branches conflict.
      const clash = ask.includes("en conflit");
      const plan = {
        tasks: clash
          ? [
              { title: "Écrire A", brief: "Écris « A » dans conflit.txt." },
              { title: "Écrire B", brief: "Écris « B » dans conflit.txt." },
            ]
          : [
              { title: "Corriger answer", brief: "Passe answer à 42 dans src/app.ts." },
              { title: "Documenter answer", brief: "Ajoute une ligne sur answer dans le README." },
            ],
      };
      await say(
        "Voici le plan.\n\n```json\n" + JSON.stringify(plan) + "\n```",
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }
    if (modes.get(sessionId) === "plan") {
      await say(
        `Mode plan (modèle ${models.get(sessionId) ?? "rapide"}, effort ${efforts.get(sessionId) ?? "moyen"}) : ` +
          "je lirais src/app.ts puis je passerais answer à 42. Je ne modifie rien.",
        "agent_message_chunk",
      );
      return { stopReason: "end_turn" };
    }

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
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: ask.includes("gros fichier") ? BIG_FILE : "export const answer = 41;",
          },
        },
      ],
    });
    // The code is read: the plan moves on, as a real agent's todo list does.
    await update({
      sessionUpdate: "plan",
      entries: [
        { content: "Lire le code concerné", priority: "high", status: "completed" },
        { content: "Proposer la modification", priority: "high", status: "in_progress" },
      ],
    });
    await say(
      `Tu m'as demandé : « ${ask} » (modèle ${models.get(sessionId) ?? "rapide"}). ` +
        (memoryLine ? `Mémoire reçue : « ${memoryLine.split("\n")[0]} ». ` : "") +
        (firstAsk ? `J'ai reçu l'historique, qui commence par « ${firstAsk} ». ` : "") +
        (attached.length ? `Pièces jointes : ${attached.join(", ")}. ` : "") +
        (mcpNames.get(sessionId)?.length
          ? `Serveurs MCP reçus : ${mcpNames.get(sessionId)?.join(", ")}. `
          : ""),
      "agent_message_chunk",
    );

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
    // As a team's coder, it does its piece for real, so the team has branches to merge.
    const piece = ask.match(/^Ta sous-tâche : (.+)$/m)?.[1];
    const cwd = cwds.get(sessionId);
    if (allowed && piece && cwd) {
      const wanted = ask.match(/^Écris « (.+?) » dans ([\w.-]+?)\.?$/m);
      const file = wanted?.[2] ?? `equipe/${piece.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), `${wanted?.[1] ?? `# ${piece}`}\n`);
    }
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
// The server gone, however it went (a kill leaves nobody to stop it), the agent goes too: its
// MCP servers would keep it alive, and live on with it, holding the server's address.
process.exit(0);
