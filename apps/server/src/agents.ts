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
  /** How the user signs in with the agent's own tool, shown when the agent asks for it. */
  login?: string;
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
  setup: { hint: string; login: string; authMethodId?: string },
): AgentDefinition {
  const { hint, ...launch } = setup;
  return {
    ...base,
    resolve: () => {
      const command = clis.map((cli) => findOnPath(cli)).find(Boolean);
      return command ? { command, args: ["acp"], ...launch } : { hint };
    },
  };
}

/** Runs an ACP adapter published on npm with this Node, from its package's entry file. */
function nodeAdapter(pkg: string): AgentLaunch {
  const main = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "dist/index.js");
  return { command: process.execPath, args: [main] };
}

const definitions: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    short: "CC",
    resolve: () => ({
      ...nodeAdapter("@agentclientprotocol/claude-agent-acp"),
      login: "lance « claude » puis « /login »",
    }),
  },
  {
    id: "codex",
    name: "Codex",
    short: "Cx",
    resolve: () => ({
      ...nodeAdapter("@agentclientprotocol/codex-acp"),
      login: "lance « codex login »",
    }),
  },
  nativeAcp(
    { id: "antigravity", name: "Antigravity", short: "Ag", preferredModel: /neon/i },
    ["agy"],
    {
      hint: "Installe Antigravity CLI (commande agy), puis lance « agy » une fois pour te connecter.",
      login: "lance « agy »",
    },
  ),
  nativeAcp({ id: "cursor", name: "Cursor", short: "Cu" }, ["cursor-agent", "agent"], {
    hint: "Installe Cursor CLI (commande agent), puis lance « agent login » une fois.",
    login: "lance « agent login »",
    authMethodId: "cursor_login",
  }),
  nativeAcp({ id: "hermes", name: "Hermes", short: "He" }, ["hermes"], {
    hint: "Installe Hermes Agent avec son extension ACP, puis lance « hermes model » une fois.",
    login: "lance « hermes model »",
  }),
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
