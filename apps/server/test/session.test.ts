import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentEnv,
  AgentSession,
  electronEnv,
  jsonLines,
  needsSignIn,
  PROMPT_INACTIVITY_MS,
  PROMPT_QUIET_MS,
  settingOptions,
} from "../src/session.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Runs chunks of an agent's output through the filter. */
async function filtered(chunks: string[]): Promise<{ passed: string; others: string[] }> {
  const others: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }).pipeThrough(jsonLines((line) => others.push(line)));
  let passed = "";
  const decoder = new TextDecoder();
  for await (const piece of stream) passed += decoder.decode(piece, { stream: true });
  return { passed, others };
}

describe("an agent's output", () => {
  it("keeps the messages and sets the plain text aside", async () => {
    const { passed, others } = await filtered([
      'Bienvenue\r\n{"id":1}\n',
      "Open the following link to authenticate the ACP server: https://exa",
      'mple.test/o\n\n  {"id":2,"te',
      'xt":"Open the following link"}\r\n{"id":3}\ndernière ligne sans fin',
    ]);
    expect(passed).toBe('{"id":1}\n{"id":2,"text":"Open the following link"}\r\n{"id":3}\n');
    expect(others).toEqual([
      "Bienvenue",
      "Open the following link to authenticate the ACP server: https://example.test/o",
      "dernière ligne sans fin",
    ]);
  });

  it("keeps only the start of a very long line of text", async () => {
    const { passed, others } = await filtered(["x".repeat(5000), "y".repeat(5000), '\n{"id":1}\n']);
    expect(passed).toBe('{"id":1}\n');
    expect(others).toEqual(["x".repeat(2000)]);
  });
});

describe("an agent that asks to sign in on its output", () => {
  const start = (login?: string, output = "log") => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-session-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    const agent = path.join(dir, "agent.mjs");
    // As `agy acp` does when nobody is signed in: a line of text, then it waits.
    writeFileSync(
      agent,
      `process.stdin.once("data", () => {
        console.${output}("Avant");
        console.${output}("Open the following link to authenticate the ACP server:");
        console.${output}("https://example.test/o?x=1");
      });
      setInterval(() => {}, 1000);`,
    );
    return AgentSession.start({
      launch: { command: process.execPath, args: [agent], ...(login ? { login } : {}) },
      cwd: dir,
      previousSessionId: null,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    });
  };

  it("stops at once and tells how to sign in, without the link", async () => {
    const error = await start("lance « agy »").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Connecte-toi d'abord avec ton compte : lance « agy ».");
    expect(needsSignIn(error)).toBe(true);
  });

  it("does the same when the agent writes it on its error output", async () => {
    const error = await start("lance « agy »", "error").catch((e: unknown) => e);
    expect((error as Error).message).toBe("Connecte-toi d'abord avec ton compte : lance « agy ».");
    expect(needsSignIn(error)).toBe(true);
  });

  it("never keeps the link, on either output", async () => {
    for (const output of ["log", "error"]) {
      const error = await start(undefined, output).catch((e: unknown) => e);
      expect((error as Error).message).toContain("Avant");
      expect((error as Error).message).not.toContain("example.test");
    }
  });

  it("says so for an agent whose sign-in command is not known", async () => {
    const error = await start().catch((e: unknown) => e);
    expect((error as Error).message).toContain("L'agent demande d'abord une connexion");
    expect((error as Error).message).not.toContain("example.test");
    expect(needsSignIn(error)).toBe(true);
  });
});

describe("an agent that lists its sign-in methods whatever the user set up", () => {
  /** Answers like an ACP agent, and tells on its error output when it is asked to sign in. */
  const start = (
    signedIn: boolean,
    authWhenAsked: boolean,
    previousSessionId: string | null = null,
  ) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-session-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    const agent = path.join(dir, "agent.mjs");
    writeFileSync(
      agent,
      `import { createInterface } from "node:readline";
      let signedIn = ${signedIn};
      const reply = (id, body) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
      createInterface({ input: process.stdin }).on("line", (line) => {
        const { id, method } = JSON.parse(line);
        if (method === "initialize") {
          reply(id, { result: { protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
            authMethods: [
            { id: "oauth-personal", name: "Compte" }, { id: "gemini-api-key", name: "Clé" } ] } });
        } else if (method === "authenticate") {
          signedIn = true;
          reply(id, { result: {} });
        } else if (method === "session/new") {
          if (signedIn) reply(id, { result: { sessionId: "s1" } });
          else reply(id, { error: { code: -32000, message: "Authentication required" } });
        } else if (method === "session/resume" || method === "session/load") {
          if (signedIn) reply(id, { result: {} });
          else reply(id, { error: { code: -32000, message: "Authentication required" } });
        }
        if (method !== "initialize") console.error(method.toUpperCase());
        if (method.startsWith("session/") && signedIn) process.exit(3);
      });`,
    );
    let exit!: (reason: string | undefined) => void;
    const exited = new Promise<string | undefined>((resolve) => (exit = resolve));
    const session = AgentSession.start({
      launch: {
        command: process.execPath,
        args: [agent],
        authMethodId: "oauth-personal",
        ...(authWhenAsked ? { authWhenAsked } : {}),
      },
      cwd: dir,
      previousSessionId,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: exit,
      },
    });
    // The agent stops itself once the session is open: what it wrote says what it was asked.
    return session.then(async ({ fresh }) => ({ fresh, asked: (await exited) ?? "" }));
  };

  it("leaves the user's own set-up alone when the session opens without signing in", async () => {
    expect((await start(true, true)).asked).not.toContain("AUTHENTICATE");
  });

  it("signs in once the agent asks for it, then opens the session", async () => {
    expect((await start(false, true)).asked).toContain("AUTHENTICATE");
  });

  it("still signs in first with agents that expect it", async () => {
    expect((await start(true, false)).asked).toMatch(/^AUTHENTICATE\s+SESSION\/NEW/);
  });

  it("continues the earlier session once signed in, instead of opening a new one", async () => {
    const { fresh, asked } = await start(false, true, "s0");
    expect(fresh).toBe(false);
    expect(asked.split(/\s+/).filter(Boolean)).toEqual([
      "SESSION/RESUME",
      "AUTHENTICATE",
      "SESSION/RESUME",
    ]);
  });
});

describe("an agent started with an overlapped stdin (Hermes)", () => {
  it("still talks to MoonAgentic", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-overlapped-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const session = await AgentSession.start({
      launch: {
        command: process.execPath,
        args: [path.join(import.meta.dirname, "../src/demo-agent.ts")],
        overlappedStdin: true,
      },
      cwd: dir,
      previousSessionId: null,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    });
    expect(session.sessionId).toBeTruthy();
    await session.close();
  });
});

describe("prompt inactivity watchdog", () => {
  async function startMockAgent(options: {
    inactivityMs?: number;
    quietMs?: number;
    onQuiet?: (since: number | undefined) => void;
    onUpdate?: (update: acp.SessionUpdate) => void;
    onConfig?: (config: { model: unknown; settings: unknown }) => void;
    requestPermission?: (
      request: acp.RequestPermissionRequest,
      signal: AbortSignal,
    ) => Promise<acp.RequestPermissionResponse>;
  }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-watchdog-"));
    const agent = path.join(dir, "agent.mjs");
    writeFileSync(
      agent,
      `import { createInterface } from "node:readline";
      const send = (msg) => console.log(JSON.stringify({ jsonrpc: "2.0", ...msg }));
      const notify = (update) => send({ method: "session/update", params: { sessionId: "s1", update } });
      const timers = [];
      let pendingPermission = null;
      const clearAll = () => {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
      };
      createInterface({ input: process.stdin }).on("line", (line) => {
        const msg = JSON.parse(line);
        if (!msg.method) {
          if (msg.id === 99 && pendingPermission) {
            const resolve = pendingPermission;
            pendingPermission = null;
            resolve(msg.result);
          }
          return;
        }
        const { id, method, params } = msg;
        if (method === "initialize") {
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (method === "session/new") {
          send({
            id,
            result: {
              sessionId: "s1",
              modes: {
                availableModes: [{ id: "a", name: "Mode A" }, { id: "b", name: "Mode B" }],
                currentModeId: "a",
              },
              configOptions: [
                {
                  id: "model",
                  name: "Modèle",
                  category: "model",
                  type: "select",
                  currentValue: "m1",
                  options: [{ value: "m1", name: "M1" }, { value: "m2", name: "M2" }],
                },
              ],
            },
          });
        } else if (method === "session/cancel") {
          clearAll();
        } else if (method === "session/prompt") {
          const mode = params.prompt[0]?.text ?? "";
          if (mode === "hang") return;
          if (mode === "progress") {
            const steps = [
              () => notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }),
              () => notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "b" } }),
              () => notify({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Outil", kind: "read", status: "in_progress" }),
              () => notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
              () => notify({ sessionUpdate: "plan", entries: [{ content: "Étape", priority: "high", status: "in_progress" }] }),
              () => send({ id, result: { stopReason: "end_turn" } }),
            ];
            steps.forEach((fn, i) => timers.push(setTimeout(fn, 110 * (i + 1))));
          } else if (mode === "usage") {
            timers.push(setInterval(() => {
              notify({ sessionUpdate: "usage_update", used: 100, size: 1000 });
            }, 60));
          } else if (mode === "config") {
            let tick = 0;
            timers.push(setInterval(() => {
              tick += 1;
              if (tick % 2 === 1) {
                notify({
                  sessionUpdate: "config_option_update",
                  configOptions: [
                    {
                      id: "model",
                      name: "Modèle",
                      category: "model",
                      type: "select",
                      currentValue: tick % 4 === 1 ? "m2" : "m1",
                      options: [{ value: "m1", name: "M1" }, { value: "m2", name: "M2" }],
                    },
                  ],
                });
              } else {
                notify({
                  sessionUpdate: "current_mode_update",
                  currentModeId: tick % 4 === 2 ? "b" : "a",
                });
              }
            }, 60));
          } else if (mode === "permission-finish" || mode === "permission-hang") {
            pendingPermission = () => {
              if (mode === "permission-finish") {
                send({ id, result: { stopReason: "end_turn" } });
              }
            };
            send({
              id: 99,
              method: "session/request_permission",
              params: {
                sessionId: "s1",
                toolCall: { toolCallId: "t1", title: "Éditer", kind: "edit", status: "pending" },
                options: [{ optionId: "allow", name: "Autoriser", kind: "allow_once" }],
              },
            });
          }
        }
      });`,
    );
    let session: AgentSession | undefined;
    let exited!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      exited = resolve;
    });
    cleanups.push(async () => {
      await session?.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    session = await AgentSession.start({
      launch: { command: process.execPath, args: [agent] },
      cwd: dir,
      previousSessionId: null,
      ...(options.inactivityMs !== undefined ? { inactivityMs: options.inactivityMs } : {}),
      ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
      handlers: {
        onUpdate: (u) => options.onUpdate?.(u),
        onQuiet: (since) => options.onQuiet?.(since),
        onConfig: (c) => options.onConfig?.(c),
        requestPermission:
          options.requestPermission ?? (async () => ({ outcome: { outcome: "cancelled" } })),
        onExit: () => exited(),
      },
    });
    return { session, exitPromise };
  }

  it("warns after 10 minutes of silence and stops after 30", () => {
    expect(PROMPT_QUIET_MS).toBe(600_000);
    expect(PROMPT_INACTIVITY_MS).toBe(1_800_000);
  });

  it("says when a prompt goes quiet, then that it is over once the prompt fails", async () => {
    const quiet: (number | undefined)[] = [];
    const started = Date.now();
    const { session, exitPromise } = await startMockAgent({
      inactivityMs: 400,
      quietMs: 150,
      onQuiet: (since) => quiet.push(since),
    });
    await expect(session.prompt("hang")).rejects.toThrow(/inactivité/i);
    expect(quiet).toHaveLength(2);
    // Quiet since the prompt was sent, not since the warning.
    expect(quiet[0]).toBeGreaterThanOrEqual(started);
    expect(Date.now() - (quiet[0] ?? 0)).toBeGreaterThanOrEqual(380);
    expect(quiet[1]).toBeUndefined();
    await exitPromise;
  });

  it("is not quiet while the user is asked for permission", async () => {
    const quiet: (number | undefined)[] = [];
    const { session } = await startMockAgent({
      inactivityMs: 1_000,
      quietMs: 150,
      onQuiet: (since) => quiet.push(since),
      requestPermission: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });
    expect(await session.prompt("permission-finish")).toBe("end_turn");
    expect(quiet).toEqual([]);
  });

  it("cancels and closes the session when no progress arrives before the deadline", async () => {
    const { session, exitPromise } = await startMockAgent({ inactivityMs: 220 });
    const events: string[] = [];
    const origCancel = session.cancel.bind(session);
    const origClose = session.close.bind(session);
    const cancelSpy = vi.spyOn(session, "cancel").mockImplementation(async () => {
      events.push("cancel");
      return origCancel();
    });
    const closeSpy = vi.spyOn(session, "close").mockImplementation(async () => {
      events.push("close");
      return origClose();
    });

    await expect(session.prompt("hang")).rejects.toThrow(/inactivité/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["cancel", "close"]);
    await exitPromise;
  });

  it("resets the deadline on each real progress update", async () => {
    const updates: acp.SessionUpdate["sessionUpdate"][] = [];
    const { session } = await startMockAgent({
      inactivityMs: 300,
      onUpdate: (u) => updates.push(u.sessionUpdate),
    });

    const stopReason = await session.prompt("progress");
    expect(stopReason).toBe("end_turn");
    expect(updates).toEqual([
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
    ]);
  });

  it("does not reset the deadline on usage_update", async () => {
    const updates: acp.SessionUpdate["sessionUpdate"][] = [];
    const { session, exitPromise } = await startMockAgent({
      inactivityMs: 220,
      onUpdate: (u) => updates.push(u.sessionUpdate),
    });
    const closeSpy = vi.spyOn(session, "close");

    await expect(session.prompt("usage")).rejects.toThrow(/inactivité/i);
    expect(updates.filter((u) => u === "usage_update").length).toBeGreaterThanOrEqual(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await exitPromise;
  });

  it("does not reset the deadline on config_option_update or current_mode_update", async () => {
    const configs: { model: unknown; settings: unknown }[] = [];
    const { session, exitPromise } = await startMockAgent({
      inactivityMs: 220,
      onConfig: (c) => configs.push(c),
    });
    const closeSpy = vi.spyOn(session, "close");

    await expect(session.prompt("config")).rejects.toThrow(/inactivité/i);
    expect(configs.length).toBeGreaterThanOrEqual(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await exitPromise;
  });

  it("pauses during requestPermission and resumes once the user answers", async () => {
    const { session } = await startMockAgent({
      inactivityMs: 220,
      requestPermission: async () => {
        await new Promise((r) => setTimeout(r, 420));
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });
    expect(await session.prompt("permission-finish")).toBe("end_turn");

    let answeredAt = 0;
    const stuck = await startMockAgent({
      inactivityMs: 220,
      requestPermission: async () => {
        await new Promise((r) => setTimeout(r, 400));
        answeredAt = Date.now();
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });
    const closeSpy = vi.spyOn(stuck.session, "close");
    await expect(stuck.session.prompt("permission-hang")).rejects.toThrow(/inactivité/i);
    expect(answeredAt).toBeGreaterThan(0);
    expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(180);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await stuck.exitPromise;
  });
});

describe("agentEnv", () => {
  it("strips MoonAgentic, GitHub, git credential and service-manager variables while keeping tool/LLM env", () => {
    const clean = agentEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-keep",
      MOONAGENTIC_DEMO_MODELS: "options",
      MOONAGENTIC_DEMO_DELAY_MS: "0",
      MOONAGENTIC_TOKEN: "root-secret",
      MOONAGENTIC_GITHUB_TOKEN: "gho_secret",
      MOONAGENTIC_COORDINATOR_BOOTSTRAP: "boot",
      MOONAGENTIC_COORDINATOR_URL: "http://127.0.0.1:4747",
      MOONAGENTIC_HOME: "/home/u/.moonagentic",
      GH_TOKEN: "ghp_host",
      GITHUB_TOKEN: "ghp_host2",
      gh_enterprise_token: "ghe_host",
      GIT_ASKPASS: "/bin/askpass",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!secret",
      TAILSCALE_AUTHKEY: "tskey-secret",
      NPM_TOKEN: "npm_secret",
      NOTIFY_SOCKET: "/run/systemd/notify",
    });
    expect(clean).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-keep",
      MOONAGENTIC_DEMO_MODELS: "options",
      MOONAGENTIC_DEMO_DELAY_MS: "0",
    });
  });

  it("never passes stripped host secrets to a spawned ACP agent process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-env-"));
    let session: AgentSession | undefined;
    cleanups.push(async () => {
      await session?.close().catch(() => undefined);
      delete process.env.MOONAGENTIC_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.MOONAGENTIC_TOKEN;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    process.env.MOONAGENTIC_GITHUB_TOKEN = "gho_must_not_leak";
    process.env.GH_TOKEN = "ghp_must_not_leak";
    process.env.MOONAGENTIC_TOKEN = "root_must_not_leak";

    const agent = path.join(dir, "env-agent.mjs");
    writeFileSync(
      agent,
      `import { createInterface } from "node:readline";
      const send = (msg) => console.log(JSON.stringify({ jsonrpc: "2.0", ...msg }));
      createInterface({ input: process.stdin }).on("line", (line) => {
        const { id, method } = JSON.parse(line);
        if (method === "initialize") {
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (method === "session/new") {
          send({ id, result: { sessionId: "s1" } });
        } else if (method === "session/prompt") {
          const leaked = ["MOONAGENTIC_GITHUB_TOKEN", "GH_TOKEN", "MOONAGENTIC_TOKEN"].filter(
            (k) => process.env[k] !== undefined,
          );
          send({
            method: "session/update",
            params: {
              sessionId: "s1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: JSON.stringify(leaked) },
              },
            },
          });
          send({ id, result: { stopReason: "end_turn" } });
        }
      });`,
    );

    let reply = "";
    session = await AgentSession.start({
      launch: { command: process.execPath, args: [agent] },
      cwd: dir,
      previousSessionId: null,
      handlers: {
        onUpdate: (u) => {
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            reply += u.content.text;
          }
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    });
    await session.prompt("check env");
    expect(JSON.parse(reply)).toEqual([]);
  });
});

describe("electronEnv", () => {
  const env = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" };

  it("keeps ELECTRON_RUN_AS_NODE only for adapters run by the app's own program", () => {
    expect(electronEnv("/app/MoonAgentic", env, "/app/MoonAgentic")).toEqual(env);
    expect(electronEnv("/usr/local/bin/agy", env, "/app/MoonAgentic")).toEqual({ PATH: "/bin" });
  });

  it("leaves the environment as is outside the desktop app", () => {
    const plain = { PATH: "/bin" };
    expect(electronEnv("/usr/local/bin/agy", plain, "/usr/bin/node")).toBe(plain);
  });
});

describe("settingOptions", () => {
  const select = (
    id: string,
    category: acp.SessionConfigOption["category"],
    values: string[],
  ): acp.SessionConfigOption => ({
    id,
    name: id,
    ...(category !== undefined ? { category } : {}),
    type: "select",
    currentValue: values[0]!,
    options: values.map((value) => ({ value, name: value })),
  });

  it("recognizes mode and thought_level categories, plus effort ids when category is other/model_config/omitted", () => {
    const parsed = settingOptions([
      select("model", "model", ["gemini-4-neon"]),
      select("mode", "mode", ["default", "plan"]),
      select("thought_level", "thought_level", ["low", "medium", "high"]),
      select("thinking_level", "model_config", ["low", "high"]),
      select("reasoning_effort", "other", ["minimal", "max"]),
      select("effort", undefined, ["bas", "haut"]),
      // A model selector whose id happens to match a setting name is never treated as effort.
      select("effort", "model", ["a", "b"]),
    ]);
    expect(parsed.map((s) => ({ id: s.id, kind: s.kind }))).toEqual([
      { id: "mode", kind: "mode" },
      { id: "thought_level", kind: "effort" },
      { id: "thinking_level", kind: "effort" },
      { id: "reasoning_effort", kind: "effort" },
      { id: "effort", kind: "effort" },
    ]);
  });
});
