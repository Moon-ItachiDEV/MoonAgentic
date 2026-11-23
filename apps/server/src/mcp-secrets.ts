import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { McpServerRecord } from "./mcp.ts";

/** Secret values of one MCP server, keyed by environment variable or HTTP header name. */
export type McpServerSecrets = Record<string, string>;
/** All MCP secrets on disk, keyed by server id. */
type SecretMap = Record<string, McpServerSecrets>;

/**
 * Keeps MCP server secret values outside `state.sqlite`, so SQLite backups and migration copies
 * never duplicate API keys, bearer tokens, or database passwords.
 */
export interface McpSecretStore {
  get(serverId: string): McpServerSecrets;
  set(serverId: string, secrets: McpServerSecrets): void;
  delete(serverId: string): void;
}

const VAULT_TIMEOUT_MS = 20_000;
const DPAPI =
  "Add-Type -AssemblyName System.Security;$e=[Text.Encoding]::UTF8.GetBytes('MoonAgentic');";

function powershellSync(script: string, input: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // By its full path: a `powershell.exe` earlier on PATH would be handed the secrets.
  const exe = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return execFileSync(
    exe,
    [
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      input,
      encoding: "utf8",
      timeout: VAULT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parseSecretMap(raw: string): SecretMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const map: SecretMap = {};
  for (const [serverId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const secrets: McpServerSecrets = {};
    for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value === "string") secrets[name] = value;
    }
    if (Object.keys(secrets).length) map[serverId] = secrets;
  }
  return map;
}

function atomicWritePrivate(file: string, content: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** In-memory MCP secret store, used with `:memory:` databases in tests. */
export function memoryMcpSecretStore(): McpSecretStore {
  const data = new Map<string, McpServerSecrets>();
  return {
    get: (serverId) => ({ ...data.get(serverId) }),
    set: (serverId, secrets) => {
      if (Object.keys(secrets).length) data.set(serverId, { ...secrets });
      else data.delete(serverId);
    },
    delete: (serverId) => {
      data.delete(serverId);
    },
  };
}

function cachedStore(io: {
  read(): SecretMap;
  write(map: SecretMap): void;
  clear(): void;
}): McpSecretStore {
  let cache: SecretMap | undefined;
  const load = (): SecretMap => (cache ??= io.read());
  const persist = (next: SecretMap): void => {
    if (Object.keys(next).length === 0) io.clear();
    else io.write(next);
    cache = next;
  };
  return {
    get: (serverId) => ({ ...load()[serverId] }),
    set: (serverId, secrets) => {
      const next: SecretMap = { ...load() };
      if (Object.keys(secrets).length) next[serverId] = { ...secrets };
      else delete next[serverId];
      persist(next);
    },
    delete: (serverId) => {
      const current = load();
      if (!Object.hasOwn(current, serverId)) return;
      const next: SecretMap = { ...current };
      delete next[serverId];
      persist(next);
    },
  };
}

/** Keeps MCP secrets in a `0o600` JSON file outside `state.sqlite` and its backups. */
export function fileMcpSecretStore(file: string): McpSecretStore {
  return cachedStore({
    read: () => (existsSync(file) ? parseSecretMap(readFileSync(file, "utf8")) : {}),
    write: (map) => atomicWritePrivate(file, JSON.stringify(map)),
    clear: () => rmSync(file, { force: true }),
  });
}

/**
 * Keeps MCP secrets sealed with the user's Windows account (DPAPI). Base64 on stdin/stdout keeps
 * arbitrary UTF-8 values lossless across Windows PowerShell codepages.
 */
export function windowsMcpSecretStore(file: string): McpSecretStore {
  return cachedStore({
    read: () => {
      if (!existsSync(file)) return {};
      const sealed = readFileSync(file, "utf8").trim();
      if (!sealed) return {};
      const rawBase64 = powershellSync(
        `${DPAPI}$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
          "[Console]::Out.Write([Convert]::ToBase64String(" +
          "[Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')))",
        sealed,
      ).trim();
      if (!rawBase64) return {};
      return parseSecretMap(Buffer.from(rawBase64, "base64").toString("utf8"));
    },
    write: (map) => {
      const encoded = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
      const sealed = powershellSync(
        `${DPAPI}$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
          "[Console]::Out.Write([Convert]::ToBase64String(" +
          "[Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))",
        encoded,
      ).trim();
      if (!sealed) throw new Error("Windows n'a pas pu chiffrer les secrets MCP.");
      atomicWritePrivate(file, sealed);
    },
    clear: () => rmSync(file, { force: true }),
  });
}

/** The default MCP secret store beside `storeFile`, or in memory for `:memory:` stores. */
export function defaultMcpSecretStore(
  storeFile: string,
  platform: NodeJS.Platform = process.platform,
): McpSecretStore {
  if (!storeFile || storeFile === ":memory:") return memoryMcpSecretStore();
  const dir = path.dirname(storeFile);
  if (platform === "win32") return windowsMcpSecretStore(path.join(dir, "mcp-secrets.dpapi"));
  return fileMcpSecretStore(path.join(dir, "mcp-secrets.json"));
}

/** Extracts non-empty secret values from one MCP server record. */
export function extractMcpSecrets(server: McpServerRecord): McpServerSecrets {
  const entries =
    server.transport.type === "stdio" ? server.transport.env : server.transport.headers;
  const secrets: McpServerSecrets = {};
  for (const entry of entries) {
    if (entry.value) secrets[entry.name] = entry.value;
  }
  return secrets;
}

/** Strips secret values from a server record before writing it to `state.sqlite`. */
export function stripMcpSecrets(server: McpServerRecord): McpServerRecord {
  if (server.transport.type === "stdio") {
    return {
      ...server,
      transport: {
        ...server.transport,
        env: server.transport.env.map(({ name }) => ({ name, value: "" })),
      },
    };
  }
  return {
    ...server,
    transport: {
      ...server.transport,
      headers: server.transport.headers.map(({ name }) => ({ name, value: "" })),
    },
  };
}

/** Restores secret values from `secrets` onto a stripped MCP server record. */
export function hydrateMcpSecrets(
  server: McpServerRecord,
  secrets: McpServerSecrets,
): McpServerRecord {
  const valueOf = (name: string, fallback: string) =>
    Object.hasOwn(secrets, name) ? secrets[name]! : fallback;
  if (server.transport.type === "stdio") {
    return {
      ...server,
      transport: {
        ...server.transport,
        env: server.transport.env.map(({ name, value }) => ({
          name,
          value: valueOf(name, value),
        })),
      },
    };
  }
  return {
    ...server,
    transport: {
      ...server.transport,
      headers: server.transport.headers.map(({ name, value }) => ({
        name,
        value: valueOf(name, value),
      })),
    },
  };
}
