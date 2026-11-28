// What a project's coordinator or thread can do in MoonAgentic, as the MCP tools its agent
// is given. Kept apart from the server so the small bridge the agent starts loads nothing else.

/** One field of a tool's input, as JSON Schema says it. */
export interface ToolField {
  type: string;
  description?: string;
  enum?: string[];
  maxItems?: number;
  items?: ToolField | { type: "object"; properties: Record<string, ToolField>; required: string[] };
}

export interface CoordinatorTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ToolField>;
    required?: string[];
  };
}

/**
 * What kind of thread the MCP bridge serves, enforced on both bridge and server sides. A
 * conversation outside any project (`discussion`) shares nothing: it may only publish.
 */
export type BridgeMode = "coordinator" | "thread" | "readonly" | "discussion";

/** The most characters of a page an agent gives as text to `publish_artifact`. */
export const MAX_ARTIFACT_TEXT = 3_000_000;

/**
 * Publishes a page, an image or a PDF for the user to look at on any of their devices, as a
 * card in the thread: what a mockup, a design or a walkthrough of code is shown with.
 */
export const PUBLISH_ARTIFACT_TOOL: CoordinatorTool = {
  name: "publish_artifact",
  description:
    "Publie un artefact que l'utilisateur ouvre d'un geste sur son téléphone, son iPad ou son ordinateur : une maquette, un design, une présentation de code, un rapport, un schéma. Il s'affiche comme une carte dans ce fil et dans « Artefacts ». Donne soit content (le texte complet d'une page HTML autonome ou d'un SVG), soit path (une page HTML, une image ou un PDF que tu as écrit dans ton dossier ; ce qui est à côté, styles, scripts et images, est chargé aussi). La page s'ouvre dans un bac à sable : JavaScript marche, mais rien ne sort sur le réseau (pas de fetch ni de formulaire) ; seuls cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, cdn.tailwindcss.com, code.jquery.com et Google Fonts peuvent être chargés, si l'utilisateur les autorise. Le localStorage n'existe pas : garde l'état en mémoire. Pense au téléphone (390 px de large) et au thème sombre. Rappelé avec l'artifact_id rendu, il publie une nouvelle version du même artefact au lieu d'en créer un autre.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Nom court de l'artefact, 2 à 5 mots (par exemple « Maquette de l'accueil »).",
      },
      content: {
        type: "string",
        description:
          "Le texte complet d'une page HTML autonome (styles et scripts dedans) ou d'un SVG. Sans path.",
      },
      path: {
        type: "string",
        description:
          "Chemin d'une page HTML, d'une image ou d'un PDF que tu as écrit, relatif à ton dossier de travail ou absolu. Sans content.",
      },
      artifact_id: {
        type: "string",
        description:
          "L'identifiant rendu par une publication précédente, pour en publier une nouvelle version.",
      },
    },
    required: ["title"],
  },
};

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

/** The states of a step of a thread's plan, as agents name them (ACP). */
export const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
/** At most this many steps in a thread's plan. */
export const MAX_PLAN_STEPS = 12;

const planSteps: ToolField = {
  type: "array",
  maxItems: MAX_PLAN_STEPS,
  description:
    "Toutes les étapes, dans l'ordre, à chaque appel : la liste remplace la précédente. Une seule in_progress à la fois.",
  items: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "L'étape en quelques mots, en français, verbe en tête (Corriger le menu).",
      },
      status: {
        type: "string",
        description: "pending : pas commencée ; in_progress : en cours ; completed : faite.",
        enum: [...PLAN_STATUSES],
      },
    },
    required: ["title", "status"],
  },
};

/** A thread's agent keeps the plan shown at the top of its thread. */
export const UPDATE_PLAN_TOOL: CoordinatorTool = {
  name: "update_plan",
  description:
    "Tient le plan de ton travail, affiché en haut du fil sur l'écran de l'utilisateur. Donne-le dès le début (3 à 7 étapes courtes), puis rappelle-le avec la liste entière chaque fois qu'une étape commence ou se termine. Il ne remplace pas ta réponse.",
  inputSchema: {
    type: "object",
    properties: { steps: planSteps },
    required: ["steps"],
  },
};

/** The coordinator keeps the plan of one of the threads it opened. */
const UPDATE_THREAD_PLAN_TOOL: CoordinatorTool = {
  name: "update_plan",
  description:
    "Change le plan affiché en haut d'un fil du projet, quand l'utilisateur change ce qu'il attend de ce fil. L'agent du fil le tient à jour pendant son travail.",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "L'identifiant du fil." },
      steps: planSteps,
    },
    required: ["thread_id", "steps"],
  },
};

/**
 * Commits what the thread's agent changed, pushes the thread's branch and opens its pull
 * request, as « Envoyer » does in the Code panel: with MoonAgentic's own GitHub sign-in, so
 * the agent needs neither `gh` nor git credentials of its own.
 */
export const OPEN_PULL_REQUEST_TOOL: CoordinatorTool = {
  name: "open_pull_request",
  description:
    "Enregistre ton travail dans une pull request, sans gh ni identifiants git : commite ce qui n'est pas encore commité dans ton dossier de travail, pousse la branche de ce fil et ouvre sa pull request sur GitHub avec la connexion GitHub de MoonAgentic. À utiliser dès que l'utilisateur demande une PR, de committer ou de pousser, au lieu de le renvoyer vers le panneau Code ou de chercher gh. Si la pull request de la branche existe déjà, il y pousse seulement les nouveaux commits et rend son adresse. Rend l'adresse de la pull request : écris-la en entier dans ta réponse.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Titre de la pull request, une ligne courte qui dit ce qui change.",
      },
      body: {
        type: "string",
        description:
          "Description de la pull request en Markdown : ce qui change, pourquoi, et ce qui a été vérifié.",
      },
      commit_message: {
        type: "string",
        description:
          "Message du commit pour ce qui n'est pas encore commité. Par défaut, le titre de la pull request.",
      },
    },
    required: ["title"],
  },
};

/**
 * Tools available to a regular project thread: read-only project context, the shared memory,
 * what it shows the user and the pull request of its own branch.
 */
export const THREAD_TOOLS: CoordinatorTool[] = [
  ...PROJECT_READ_TOOLS,
  MEMORY_WRITE_TOOL,
  PUBLISH_ARTIFACT_TOOL,
  OPEN_PULL_REQUEST_TOOL,
  UPDATE_PLAN_TOOL,
];

/** Tools available to read-only team members (reviewer, tester, merger): they may still show. */
export const READONLY_THREAD_TOOLS: CoordinatorTool[] = [
  ...PROJECT_READ_TOOLS,
  PUBLISH_ARTIFACT_TOOL,
  UPDATE_PLAN_TOOL,
];

/** A conversation outside any project: nothing to share, only what it shows. */
export const DISCUSSION_TOOLS: CoordinatorTool[] = [PUBLISH_ARTIFACT_TOOL];

/** Read-only MoonAgentic tool names that never mutate project state. */
export const READ_ONLY_TOOL_NAMES = new Set(PROJECT_READ_TOOLS.map((t) => t.name));

export const COORDINATOR_TOOLS: CoordinatorTool[] = [
  ...PROJECT_READ_TOOLS,
  {
    name: "list_agents",
    description:
      "Les agents prêts, leurs modèles et les niveaux d'effort de chaque modèle, pour donner à open_thread l'agent, le modèle et l'effort que l'utilisateur demande. Lecture seule.",
    inputSchema: { type: "object", properties: {} },
  },
  MEMORY_WRITE_TOOL,
  PUBLISH_ARTIFACT_TOOL,
  UPDATE_THREAD_PLAN_TOOL,
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
            "La consigne pour l'agent du fil, en français, deux à quatre phrases claires : ce qui est demandé, le contexte utile, le résultat attendu. Elle s'affiche dans le fil : pas de commandes, de titres ni de notes internes. Il ne voit pas cette conversation.",
        },
        kind: {
          type: "string",
          description: "Le type de travail.",
          enum: [...THREAD_KINDS],
        },
        steps: {
          type: "array",
          maxItems: MAX_PLAN_STEPS,
          description:
            "Le plan du fil, affiché en haut de celui-ci : 3 à 6 étapes courtes en français, verbe en tête, dans l'ordre. L'agent du fil les tient à jour.",
          items: { type: "string" },
        },
        agent: {
          type: "string",
          description:
            "Identifiant d'un agent précis (list_agents), seulement si l'utilisateur l'a demandé.",
        },
        model: {
          type: "string",
          description:
            "Modèle précis de cet agent (son identifiant ou son nom, comme dans list_agents), seulement si l'utilisateur l'a demandé.",
        },
        effort: {
          type: "string",
          description:
            "Niveau d'effort (raisonnement) précis, seulement si l'utilisateur l'a demandé : le nom d'un niveau de ce modèle dans list_agents (par exemple high, xhigh, UltraMoon pour le plus haut). Un niveau que le modèle n'a pas est refusé, jamais remplacé.",
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
  if (mode === "discussion") return DISCUSSION_TOOLS;
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
