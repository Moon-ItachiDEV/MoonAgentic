import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePrivateDataDir } from "../src/data-dir.ts";
import { decode } from "../src/http.ts";
import { acpMcpServers, type McpServerRecord } from "../src/mcp.ts";
import { defaultMcpSecretStore, fileMcpSecretStore } from "../src/mcp-secrets.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const servers: McpServerRecord[] = [
  {
    id: "1",
    name: "fichiers",
    enabled: true,
    transport: { type: "stdio", command: "npx", args: ["srv"], env: [{ name: "T", value: "v" }] },
  },
  {
    id: "2",
    name: "web",
    enabled: true,
    transport: {
      type: "http",
      url: "https://mcp.example.com",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    },
  },
  {
    id: "3",
    name: "coupé",
    enabled: false,
    transport: { type: "http", url: "https://off.example.com", headers: [] },
  },
];

describe("acpMcpServers", () => {
  it("gives HTTP servers and their headers only to agents that can reach them", () => {
    const stdio = {
      name: "fichiers",
      command: "npx",
      args: ["srv"],
      env: [{ name: "T", value: "v" }],
    };
    expect(acpMcpServers(servers, { http: true })).toEqual([
      stdio,
      {
        type: "http",
        name: "web",
        url: "https://mcp.example.com",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
    ]);
    expect(acpMcpServers(servers, { http: false })).toEqual([stdio]);
  });
});

describe("decode", () => {
  it("answers a rejected request by its id, so the client stops waiting", () => {
    const bad = { type: "mcp.add", requestId: "r1", server: { name: "web" } };
    expect(decode(JSON.stringify(bad))).toEqual({
      error: { type: "error", requestId: "r1", message: "Message invalide." },
    });
    expect(decode("{")).toEqual({ error: { type: "error", message: "Message illisible." } });
  });

  it("names the limit of a message too long, instead of calling it invalid (audit N31)", () => {
    const long = "a".repeat(200_001);
    for (const message of [
      { type: "thread.send", requestId: "r2", threadId: "t1", text: long },
      { type: "thread.create", requestId: "r2", projectId: "p", agentId: "demo", text: long },
    ]) {
      expect(decode(JSON.stringify(message))).toEqual({
        error: {
          type: "error",
          requestId: "r2",
          message: "Message trop long : 200 000 caractères au plus.",
        },
      });
    }
    expect(
      "message" in
        decode(JSON.stringify({ type: "thread.send", threadId: "t1", text: "a".repeat(200_000) })),
    ).toBe(true);
  });

  it("rejects MCP secrets with names an agent could not use", () => {
    const add = (transport: unknown) =>
      decode(JSON.stringify({ type: "mcp.add", requestId: "r", server: { name: "x", transport } }));
    const env = (names: string[]) =>
      add({
        type: "stdio",
        command: "x",
        args: [],
        env: names.map((name) => ({ name, value: "" })),
      });
    expect(env(["GITHUB_TOKEN"])).toHaveProperty("message");
    expect(env(["export GITHUB_TOKEN"])).toHaveProperty("error");
    expect(env(["A", "A"])).toHaveProperty("error");
    const headers = (names: string[]) =>
      add({
        type: "http",
        url: "https://x.dev",
        headers: names.map((name) => ({ name, value: "" })),
      });
    expect(headers(["X-Token"])).toHaveProperty("message");
    expect(headers(["X Token"])).toHaveProperty("error");
    expect(headers(["Authorization", "authorization"])).toHaveProperty("error");
  });
});

describe("preparePrivateDataDir", () => {
  // Windows keeps file access in ACLs rather than mode bits.
  it.skipIf(process.platform === "win32")("locks the folder and its secrets to their owner", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-data-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "state.sqlite-wal"), "", { mode: 0o644 });
    writeFileSync(path.join(dir, "mcp-secrets.json"), "{}", { mode: 0o644 });
    preparePrivateDataDir(dir);
    preparePrivateDataDir(path.join(dir, "new"));
    const mode = (file: string) => statSync(path.join(dir, file)).mode & 0o777;
    expect(mode(".")).toBe(0o700);
    expect(mode("state.sqlite")).toBe(0o600);
    expect(mode("state.sqlite-wal")).toBe(0o600);
    expect(mode("mcp-secrets.json")).toBe(0o600);
    expect(mode("new")).toBe(0o700);
    expect(mode("new/state.sqlite")).toBe(0o600);
  });
});

describe("McpSecretStore", () => {
  it("stores MCP secrets in an owner-only file and deletes the file once empty", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-mcp-secrets-"));
    dirs.push(dir);
    const file = path.join(dir, "mcp-secrets.json");
    const store = fileMcpSecretStore(file);
    await store.load();
    expect(store.error()).toBeUndefined();
    expect(store.get("s1")).toEqual({});
    await store.set("s1", { TOKEN: "clé-secrète-€" });
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const reopened = fileMcpSecretStore(file);
    await reopened.load();
    expect(reopened.get("s1")).toEqual({ TOKEN: "clé-secrète-€" });
    await reopened.delete("s1");
    expect(existsSync(file)).toBe(false);
  });

  it("captures a corrupt secret file error gracefully instead of crashing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-mcp-corrupt-"));
    dirs.push(dir);
    const file = path.join(dir, "mcp-secrets.json");
    writeFileSync(file, "{not-valid-json");
    const store = fileMcpSecretStore(file);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.error()).toContain("Impossible de lire les secrets MCP");
    expect(store.get("s1")).toEqual({});
  });

  it.runIf(process.platform === "win32")(
    "seals MCP secrets with Windows DPAPI asynchronously",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-mcp-dpapi-"));
      dirs.push(dir);
      const dbFile = path.join(dir, "state.sqlite");
      const store = defaultMcpSecretStore(dbFile, "win32");
      await store.set("s1", { TOKEN: "clé-windows-€-123" });
      const sealed = readFileSync(path.join(dir, "mcp-secrets.dpapi"), "utf8");
      expect(sealed).not.toContain("clé-windows");
      const reopened = defaultMcpSecretStore(dbFile, "win32");
      await reopened.load();
      expect(reopened.error()).toBeUndefined();
      expect(reopened.get("s1")).toEqual({ TOKEN: "clé-windows-€-123" });
      await reopened.delete("s1");
      expect(existsSync(path.join(dir, "mcp-secrets.dpapi"))).toBe(false);
    },
  );
});
