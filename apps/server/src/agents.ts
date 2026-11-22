import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@moonagentic/protocol";

export interface AgentLaunch {
  command: string;
  args: string[];
  /** ACP auth method to call before opening a session, for agents that expect it. */
  authMethodId?: string;
}

interface AgentDefinition {
  id: string;
  name: string;
  short: string;
  /** Model picked for new threads when the user chose none, if the agent offers it. */
  preferredModel?: RegExp;
  /** Returns how to start the agent, or a hint explaining what is missing. */
  resolve(): AgentLaunch | { hint: string };
}

export function findOnPath(command: string, envPath = process.env.PATH ?? ""): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

const require = createRequire(import.meta.url);

/** Agents that speak ACP natively, started as `<cli> acp`. */
function nativeAcp(
  base: Omit<AgentDefinition, "resolve">,
  clis: string[],
  hint: string,
  authMethodId?: string,
): AgentDefinition {
  return {
    ...base,
    resolve: () => {
      const command = clis.map((cli) => findOnPath(cli)).find(Boolean);
      if (!command) return { hint };
      return { command, args: ["acp"], ...(authMethodId ? { authMethodId } : {}) };
    },
  };
}

function codexBinary(): string | undefined {
  const fromAdapter = createRequire(require.resolve("@zed-industries/codex-acp/package.json"));
  const binary = process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
  try {
    return fromAdapter.resolve(
      `@zed-industries/codex-acp-${process.platform}-${process.arch}/bin/${binary}`,
    );
  } catch {
    return undefined;
  }
}

const definitions: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    short: "CC",
    resolve: () => ({
      command: process.execPath,
      args: [
        path.join(
          path.dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json")),
          "dist/index.js",
        ),
      ],
    }),
  },
  {
    id: "codex",
    name: "Codex",
    short: "Cx",
    resolve: () => {
      const command = codexBinary();
      return command
        ? { command, args: [] }
        : { hint: "Codex n'est pas disponible pour ce système." };
    },
  },
  nativeAcp(
    { id: "antigravity", name: "Antigravity", short: "Ag", preferredModel: /neon/i },
    ["agy"],
    "Installe Antigravity CLI (commande agy), puis lance « agy » une fois pour te connecter.",
  ),
  nativeAcp(
    { id: "cursor", name: "Cursor", short: "Cu" },
    ["cursor-agent", "agent"],
    "Installe Cursor CLI (commande agent), puis lance « agent login » une fois.",
    "cursor_login",
  ),
  nativeAcp(
    { id: "hermes", name: "Hermes", short: "He" },
    ["hermes"],
    "Installe Hermes Agent avec son extension ACP, puis lance « hermes model » une fois.",
  ),
];

const demoAgent: AgentDefinition = {
  id: "demo",
  name: "Agent de démo",
  short: "Dm",
  preferredModel: /précis/i,
  resolve: () => ({
    command: process.execPath,
    args: [fileURLToPath(new URL("./demo-agent.ts", import.meta.url))],
  }),
};

export class Agents {
  private readonly all: AgentDefinition[];

  constructor(options: { demo: boolean }) {
    this.all = options.demo ? [...definitions, demoAgent] : definitions;
  }

  list(): AgentInfo[] {
    return this.all.map((agent) => {
      const launch = agent.resolve();
      return {
        id: agent.id,
        name: agent.name,
        short: agent.short,
        available: !("hint" in launch),
        ...("hint" in launch ? { hint: launch.hint } : {}),
      };
    });
  }

  preferredModel(id: string): RegExp | undefined {
    return this.all.find((a) => a.id === id)?.preferredModel;
  }

  launch(id: string): AgentLaunch {
    const agent = this.all.find((a) => a.id === id);
    if (!agent) throw new Error(`Agent inconnu : ${id}`);
    const launch = agent.resolve();
    if ("hint" in launch) throw new Error(launch.hint);
    return launch;
  }
}
