// What a project's coordinator or thread can do in MoonAgentic, as the MCP tools its agent
// is given. Kept apart from the server so the small bridge the agent starts loads nothing else.

export interface CoordinatorTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

/** What kind of thread the MCP bridge serves, enforced on both bridge and server sides. */
export type BridgeMode = "coordinator" | "thread" | "readonly";

/** The kinds of work a thread can be opened for; the agent and model follow from it later. */
export const THREAD_KINDS = ["question", "bug", "fonctionnalite", "relecture", "tests"] as const;

/** How a message reaches a thread whose agent is at work: after its turn, or in place of it. */
export const MESSAGE_MODES = ["queue", "steer"] as const;

/** How `save_memory` updates the project's shared memory notes. */
export const MEMORY_MODES = ["append", "replace"] as const;

/** Read-only context tools scoped to one project: safe for every thread of that project. */
export const PROJECT_READ_TOOLS: CoordinatorTool[] = [
  {
    name: "list_threads",
    description:
      "Liste les fils de ce projet avec leur état réel (en attente, en cours, inactif, résolu), leur résumé, leur branche et leur pull request.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_threads",
    description:
      "Cherche des mots-clés dans les titres et messages des autres fils de ce projet pour retrouver une décision, un bug ou un contexte passé.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Mots-clés à rechercher dans les fils du projet.",
        },
        limit: {
          type: "integer",
          description: "Nombre maximal de fils à renvoyer (1 à 20, par défaut 10).",
        },
        include_current: {
          type: "boolean",
          description: "Inclure aussi le fil actuel dans la recherche (faux par défaut).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_thread",
    description:
      "Lit un fil de ce projet : son état, son erreur éventuelle, ce qu'il attend de l'utilisateur et ses messages (les derniers par défaut, ou à partir d'un offset).",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "L'identifiant du fil." },
        offset: {
          type: "integer",
          description:
            "Position (à partir de 0) du premier message à lire depuis le début du fil. Omis : renvoie les derniers messages.",
        },
        limit: {
          type: "integer",
          description: "Nombre maximal de messages à lire (1 à 20, par défaut 8).",
        },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "read_memory",
    description:
      "Lit la mémoire partagée de ce projet (notes durables communes à tous les agents, fils et branches du projet dans MoonAgentic).",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Updates the project's durable shared memory notes (visible to every agent and worktree). */
export const MEMORY_WRITE_TOOL: CoordinatorTool = {
  name: "save_memory",
  description:
    "Enregistre des notes durables dans la mémoire partagée de ce projet (visible par tous les agents, fils et branches). À réserver aux faits durables : décisions d'architecture, conventions, pièges connus, commandes validées. Jamais de secrets ni d'état temporaire d'une tâche.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "Notes concises en Markdown à ajouter (append) ou enregistrer comme mémoire complète (replace).",
      },
      mode: {
        type: "string",
        description:
          "append (par défaut) : ajoute à la suite de la mémoire existante. replace : remplace toute la mémoire (pour la condenser ou la nettoyer).",
        enum: [...MEMORY_MODES],
      },
    },
    required: ["content"],
  },
};

/** Tools available to a regular project thread (read-only project context + shared memory). */
export const THREAD_TOOLS: CoordinatorTool[] = [...PROJECT_READ_TOOLS, MEMORY_WRITE_TOOL];

/** Tools available to read-only team members (reviewer, tester, merger). */
export const READONLY_THREAD_TOOLS: CoordinatorTool[] = [...PROJECT_READ_TOOLS];

/** Read-only MoonAgentic tool names that never mutate project state. */
export const READ_ONLY_TOOL_NAMES = new Set(PROJECT_READ_TOOLS.map((t) => t.name));

export const COORDINATOR_TOOLS: CoordinatorTool[] = [
  ...PROJECT_READ_TOOLS,
  MEMORY_WRITE_TOOL,
  {
    name: "open_thread",
    description:
      "Ouvre un nouveau fil du projet, sur sa propre branche, et y envoie la consigne à un agent. À utiliser pour un bug, une fonctionnalité ou toute tâche qui demande du travail, pas pour une question à laquelle tu peux répondre. Le message d'origine de l'utilisateur est joint à ta consigne par MoonAgentic. Rappelé avec la même task_key, il rend le fil déjà ouvert au lieu d'en ouvrir un second.",
    inputSchema: {
      type: "object",
      properties: {
        task_key: {
          type: "string",
          description:
            "Nom stable du sujet, en minuscules avec des tirets (par exemple export-safari). Garde le même si tu réessaies.",
        },
        title: { type: "string", description: "Titre court du fil, 3 à 6 mots." },
        brief: {
          type: "string",
          description:
            "La consigne complète pour l'agent du fil : ce qui est demandé, le contexte utile, le résultat attendu. Il ne voit pas cette conversation.",
        },
        kind: {
          type: "string",
          description: "Le type de travail.",
          enum: [...THREAD_KINDS],
        },
        agent: {
          type: "string",
          description: "Identifiant d'un agent précis, seulement si l'utilisateur l'a demandé.",
        },
        model: {
          type: "string",
          description: "Modèle précis de cet agent, seulement si l'utilisateur l'a demandé.",
        },
      },
      required: ["task_key", "title", "brief"],
    },
  },
  {
    name: "start_team",
    description:
      "Lance une équipe d'agents sur une tâche trop grosse pour un seul fil : un chef la découpe, des codeurs travaillent en même temps, puis relecture, tests et fusion. Elle reprend l'équipe que l'utilisateur a réglée la dernière fois, ou une équipe par défaut s'il n'en a jamais réglé. Seulement quand l'utilisateur demande une équipe ou que la tâche a clairement plusieurs morceaux indépendants.",
    inputSchema: {
      type: "object",
      properties: {
        task_key: {
          type: "string",
          description:
            "Nom stable du sujet, en minuscules avec des tirets. Garde le même si tu réessaies.",
        },
        task: {
          type: "string",
          description:
            "La tâche complète pour le chef d'équipe, qui ne voit pas cette conversation.",
        },
      },
      required: ["task_key", "task"],
    },
  },
  {
    name: "message_thread",
    description:
      "Envoie une suite à un fil existant du projet, plutôt que d'en ouvrir un autre sur le même sujet. Si son agent travaille, le message attend la fin de son tour (queue) ; steer l'arrête pour lui donner le message tout de suite.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "L'identifiant du fil." },
        text: { type: "string", description: "Le message pour l'agent du fil." },
        mode: {
          type: "string",
          description:
            "queue (par défaut) : attend la fin du tour en cours. steer : coupe le tour en cours, seulement pour une correction urgente.",
          enum: [...MESSAGE_MODES],
        },
      },
      required: ["thread_id", "text"],
    },
  },
  {
    name: "resolve_thread",
    description:
      "Marque un fil du projet comme résolu, quand l'utilisateur le demande ou confirme que le sujet est clos. Ses fichiers sont gardés et il peut être rouvert.",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string", description: "L'identifiant du fil." } },
      required: ["thread_id"],
    },
  },
];

/** The tools advertised by the bridge and accepted by the server for a given bridge mode. */
export function toolsForBridgeMode(mode: BridgeMode): CoordinatorTool[] {
  if (mode === "coordinator") return COORDINATOR_TOOLS;
  if (mode === "readonly") return READONLY_THREAD_TOOLS;
  return THREAD_TOOLS;
}

/**
 * Where the bridge finds the server, what mode it serves, and what it trades there, once,
 * for the token that limits it to one project. The token itself is never in the environment,
 * where a command the agent runs could read it.
 */
export const BRIDGE_URL_ENV = "MOONAGENTIC_COORDINATOR_URL";
export const BRIDGE_BOOTSTRAP_ENV = "MOONAGENTIC_COORDINATOR_BOOTSTRAP";
export const BRIDGE_MODE_ENV = "MOONAGENTIC_BRIDGE_MODE";

/** The address of the only thing a bridge's token opens. */
export const COORDINATOR_PATH = "/api/coordinator";
