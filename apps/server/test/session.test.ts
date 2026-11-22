import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, jsonLines, needsSignIn } from "../src/session.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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
