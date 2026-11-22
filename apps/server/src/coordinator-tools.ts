// What a project's coordinator can do in MoonAgentic, as the MCP tools its agent is given.
// Kept apart from the server so the small bridge the agent starts loads nothing else.

export interface CoordinatorTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

/** The kinds of work a thread can be opened for; the agent and model follow from it later. */
export const THREAD_KINDS = ["question", "bug", "fonctionnalite", "relecture", "tests"] as const;

export const COORDINATOR_TOOLS: CoordinatorTool[] = [
  {
    name: "list_threads",
    description:
      "Liste les fils du projet avec leur état réel (en attente, en cours, inactif, résolu), leur résumé et leur pull request.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_thread",
    description:
      "Lit un fil du projet : son état, son erreur éventuelle, ce qu'il attend de l'utilisateur et ses derniers messages.",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string", description: "L'identifiant du fil." } },
      required: ["thread_id"],
    },
  },
  {
    name: "open_thread",
    description:
      "Ouvre un nouveau fil du projet, sur sa propre branche, et y envoie la consigne à un agent. À utiliser pour un bug, une fonctionnalité ou toute tâche qui demande du travail, pas pour une question à laquelle tu peux répondre.",
    inputSchema: {
      type: "object",
      properties: {
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
      required: ["title", "brief"],
    },
  },
  {
    name: "message_thread",
    description:
      "Envoie une suite à un fil existant du projet, plutôt que d'en ouvrir un autre sur le même sujet. Refusé tant que son agent travaille.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "L'identifiant du fil." },
        text: { type: "string", description: "Le message pour l'agent du fil." },
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

/** Where the bridge finds the server, and the token that limits it to one project. */
export const BRIDGE_URL_ENV = "MOONAGENTIC_COORDINATOR_URL";
export const BRIDGE_TOKEN_ENV = "MOONAGENTIC_COORDINATOR_TOKEN";

/** The address of the only thing a coordinator's token opens. */
export const COORDINATOR_PATH = "/api/coordinator";
