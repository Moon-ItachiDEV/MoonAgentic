import { execFile } from "node:child_process";
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
 * never duplicate API keys, bearer tokens, or database passwords. Reads are asynchronous and
 * fault-tolerant: a vault that cannot be decrypted (e.g. a DPAPI file copied from another PC)
 * surfaces its error in Connexions instead of blocking clients or crashing the server.
 */
export interface McpSecretStore {
  /** Loads secrets into memory once; captures read/decrypt errors instead of throwing. */
  load(): Promise<void>;
  /** Why reading the secret vault failed, if it did. */
  error(): string | undefined;
  /** Returns cached secret values for one server (empty if none or vault unreadable). */
  get(serverId: string): McpServerSecrets;
  /** Persists secret values for one server atomically. */
  set(serverId: string, secrets: McpServerSecrets): Promise<void>;
  /** Deletes secret values for one server. */
  delete(serverId: string): Promise<void>;
  /** Removes the vault file and resets any cached error (used when no MCP servers remain). */
  clear(): Promise<void>;
}

const VAULT_TIMEOUT_MS = 20_000;
const DPAPI =
  "Add-Type -AssemblyName System.Security;$e=[Text.Encoding]::UTF8.GetBytes('MoonAgentic');";

/** Runs a command asynchronously with `input` on stdin so secrets never appear on argv. */
function pipe(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: VAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim().split("\n")[0] || error.message));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

function powershell(script: string, input: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // By its full path: a `powershell.exe` earlier on PATH would be handed the secrets.
  const exe = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return pipe(
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
    input,
  );
}

function parseSecretMap(raw: string): SecretMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Le fichier des secrets MCP est corrompu.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Le fichier des secrets MCP a un format inattendu.");
  }
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
    load: async () => undefined,
    error: () => undefined,
    get: (serverId) => ({ ...data.get(serverId) }),
    set: async (serverId, secrets) => {
      if (Object.keys(secrets).length) data.set(serverId, { ...secrets });
      else data.delete(serverId);
    },
    delete: async (serverId) => {
      data.delete(serverId);
    },
    clear: async () => {
      data.clear();
    },
  };
}

function cachedStore(io: {
  read(): Promise<SecretMap>;
  write(map: SecretMap): Promise<void>;
  clear(): Promise<void>;
  readErrorMessage: (cause: string) => string;
}): McpSecretStore {
  let cache: SecretMap = {};
  let loaded = false;
  let loading: Promise<void> | undefined;
  let lastError: string | undefined;
  let writes: Promise<void> = Promise.resolve();

  const load = async (): Promise<void> => {
    if (loaded) return;
    loading ??= io
      .read()
      .then(
        (map) => {
          cache = map;
          lastError = undefined;
          loaded = true;
        },
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          lastError = io.readErrorMessage(detail);
          console.error("Secrets MCP illisibles :", error);
          cache = {};
          loaded = true;
        },
      )
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = writes.then(work, work);
    writes = run.catch(() => undefined);
    return run;
  };

  const persist = async (next: SecretMap): Promise<void> => {
    if (Object.keys(next).length === 0) await io.clear();
    else await io.write(next);
    cache = next;
    lastError = undefined;
    loaded = true;
  };

  return {
    load,
    error: () => lastError,
    get: (serverId) => ({ ...cache[serverId] }),
    set: (serverId, secrets) =>
      enqueue(async () => {
        await load();
        if (Object.keys(secrets).length === 0 && !Object.hasOwn(cache, serverId)) return;
        const next: SecretMap = { ...cache };
        if (Object.keys(secrets).length) next[serverId] = { ...secrets };
        else delete next[serverId];
        await persist(next);
      }),
    delete: (serverId) =>
      enqueue(async () => {
        await load();
        if (!Object.hasOwn(cache, serverId)) return;
        const next: SecretMap = { ...cache };
        delete next[serverId];
        await persist(next);
      }),
    clear: () =>
      enqueue(async () => {
        await load();
        await persist({});
      }),
  };
}

/** Keeps MCP secrets in a `0o600` JSON file outside `state.sqlite` and its backups. */
export function fileMcpSecretStore(file: string): McpSecretStore {
  return cachedStore({
    read: async () => (existsSync(file) ? parseSecretMap(readFileSync(file, "utf8")) : {}),
    write: async (map) => atomicWritePrivate(file, JSON.stringify(map)),
    clear: async () => rmSync(file, { force: true }),
    readErrorMessage: (detail) =>
      `Impossible de lire les secrets MCP : ${detail}. Supprime et recrée les serveurs MCP concernés.`,
  });
}

/**
 * Keeps MCP secrets sealed with the user's Windows account (DPAPI), asynchronously like
 * `github-vault.ts`. Base64 on stdin/stdout keeps arbitrary UTF-8 values lossless across
 * Windows PowerShell codepages.
 */
export function windowsMcpSecretStore(file: string): McpSecretStore {
  return cachedStore({
    read: async () => {
      if (!existsSync(file)) return {};
      const sealed = readFileSync(file, "utf8").trim();
      if (!sealed) return {};
      const rawBase64 = (
        await powershell(
          `${DPAPI}$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
            "[Console]::Out.Write([Convert]::ToBase64String(" +
            "[Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')))",
          sealed,
        )
      ).trim();
      if (!rawBase64) return {};
      return parseSecretMap(Buffer.from(rawBase64, "base64").toString("utf8"));
    },
    write: async (map) => {
      const encoded = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
      const sealed = (
        await powershell(
          `${DPAPI}$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
            "[Console]::Out.Write([Convert]::ToBase64String(" +
            "[Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))",
          encoded,
        )
      ).trim();
      if (!sealed) throw new Error("Windows n'a pas pu chiffrer les secrets MCP.");
      atomicWritePrivate(file, sealed);
    },
    clear: async () => rmSync(file, { force: true }),
    readErrorMessage: (detail) =>
      `Impossible de déchiffrer les secrets MCP sur ce compte Windows (${detail}). Si le dossier .moonagentic vient d'une autre machine, recrée les serveurs MCP concernés.`,
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
