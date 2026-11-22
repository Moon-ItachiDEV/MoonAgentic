import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo, CustomAgentInput } from "@moonagentic/protocol";

export interface AgentLaunch {
  command: string;
  args: string[];
  /** ACP auth method to call before opening a session, for agents that expect it. */
  authMethodId?: string;
  /** How the user signs in with the agent's own tool, shown when the agent asks for it. */
  login?: string;
  /** What starts it, as shown in Connexions, when the command alone says little. */
  label?: string;
}

/** An agent the user added, as kept in the settings. */
export interface CustomAgent extends CustomAgentInput {
  id: string;
}

interface AgentDefinition {
  id: string;
  name: string;
  short: string;
  /** Model picked for new threads when the user chose none, if the agent offers it. */
  preferredModel?: RegExp;
  /** Returns how to start the agent, or a hint explaining what is missing. */
  resolve(): AgentLaunch | { hint: string };
  custom?: boolean;
}

export function findOnPath(command: string, envPath = process.env.PATH ?? ""): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        // A folder of that name also passes the access check.
        if (statSync(candidate).isFile()) return candidate;
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
  const manifest = require.resolve(`${pkg}/package.json`);
  const main = path.join(path.dirname(manifest), "dist/index.js");
  let version = "";
  try {
    version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "";
  } catch {
    // shown without its version
  }
  return { command: process.execPath, args: [main], label: `${pkg} ${version}`.trim() };
}

/**
 * Finds a command given by name (on the PATH) or by path, `~` standing for the home folder.
 * On Windows, `.exe`, `.cmd` and `.bat` may be left out, as on the PATH.
 */
export function findCommand(command: string, home = os.homedir()): string | undefined {
  const named = /^~(?=$|[\\/])/.test(command) ? path.join(home, command.slice(1)) : command;
  if (!/[\\/]/.test(named)) return findOnPath(named);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const ext of extensions) {
    try {
      accessSync(named + ext, constants.X_OK);
      if (statSync(named + ext).isFile()) return named + ext;
    } catch {
      // not this one
    }
  }
  return undefined;
}

/** Two letters for an agent's badge, from its name. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "").slice(0, 2);
  return letters ? letters[0]!.toUpperCase() + letters.slice(1).toLowerCase() : "?";
}

const customDefinition = (agent: CustomAgent): AgentDefinition => ({
  id: agent.id,
  name: agent.name,
  short: shortName(agent.name),
  custom: true,
  resolve: () => {
    const command = findCommand(agent.command);
    return command
      ? { command, args: agent.args }
      : { hint: `Commande introuvable sur cette machine : ${agent.command}` };
  },
});

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
      // Only called when agy lists it: an API key or Vertex set-up is left alone.
      authMethodId: "oauth-personal",
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

const demoAgent = (id: string, name: string, short: string): AgentDefinition => ({
  id,
  name,
  short,
  preferredModel: /précis/i,
  resolve: () => ({
    command: process.execPath,
    args: [fileURLToPath(new URL("./demo-agent.ts", import.meta.url))],
    label: "agent de démo intégré à MoonAgentic",
  }),
});

// Two of them, so handing a thread to another agent can be tried for free.
const demoAgents = [
  demoAgent("demo", "Agent de démo", "Dm"),
  demoAgent("demo-2", "Second agent de démo", "D2"),
];

export class Agents {
  private readonly builtIn: AgentDefinition[];
  private all: AgentDefinition[];

  constructor(options: { demo: boolean }) {
    this.builtIn = options.demo ? [...definitions, ...demoAgents] : definitions;
    this.all = this.builtIn;
  }

  /** Replaces the agents the user added. */
  setCustom(agents: CustomAgent[]): void {
    this.all = [...this.builtIn, ...agents.map(customDefinition)];
  }

  list(): AgentInfo[] {
    return this.all.map((agent) => {
      const launch = agent.resolve();
      if ("hint" in launch) {
        return {
          id: agent.id,
          name: agent.name,
          short: agent.short,
          available: false,
          hint: launch.hint,
          ...(agent.custom ? { custom: true } : {}),
        };
      }
      const command = launch.label ?? [launch.command, ...launch.args].join(" ");
      return {
        id: agent.id,
        name: agent.name,
        short: agent.short,
        available: true,
        command,
        ...(launch.login ? { login: launch.login } : {}),
        ...(agent.custom ? { custom: true } : {}),
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
