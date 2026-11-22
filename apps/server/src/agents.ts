import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@moonagentic/protocol";

export interface AgentLaunch {
  command: string;
  args: string[];
}

interface AgentDefinition {
  id: string;
  name: string;
  short: string;
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
const nativeAcp = (id: string, name: string, short: string, cli: string, hint: string) =>
  ({
    id,
    name,
    short,
    resolve: () => {
      const command = findOnPath(cli);
      return command ? { command, args: ["acp"] } : { hint };
    },
  }) satisfies AgentDefinition;

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
  nativeAcp(
    "antigravity",
    "Antigravity",
    "Ag",
    "agy",
    "Installe Antigravity CLI (commande agy), puis lance « agy » une fois pour te connecter.",
  ),
  nativeAcp(
    "hermes",
    "Hermes",
    "He",
    "hermes",
    "Installe Hermes Agent (commande hermes), puis configure-le une fois dans un terminal.",
  ),
];

const demoAgent: AgentDefinition = {
  id: "demo",
  name: "Agent de démo",
  short: "Dm",
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

  launch(id: string): AgentLaunch {
    const agent = this.all.find((a) => a.id === id);
    if (!agent) throw new Error(`Agent inconnu : ${id}`);
    const launch = agent.resolve();
    if ("hint" in launch) throw new Error(launch.hint);
    return launch;
  }
}
