// What Hermes Agent can do in MoonAgentic from Discord, as the MCP tools of the small bridge it
// starts. Kept apart from the server so that bridge loads nothing else.
import type { PlanStatus } from "@moonagentic/protocol";
import type { CoordinatorTool } from "./coordinator-tools.ts";

/** Where the bridge calls this MoonAgentic, on this computer only. */
export const HERMES_PATH = "/api/hermes";

/** How long `ask_coordinator` waits for the coordinator's answer before saying it still works. */
export const ASK_WAIT_MS = 13 * 60_000;

/** The Planner's columns, in order, as the app names them. */
export const PLAN_COLUMNS: Record<PlanStatus, string> = {
  todo: "À faire",
  doing: "En cours",
  report: "Reporté",
  test: "En test",
  live: "Livré",
};

const columns = Object.values(PLAN_COLUMNS);

const project = {
  type: "string",
  description: "Le projet : son nom (comme dans list_projects) ou son identifiant.",
};

export const HERMES_TOOLS: CoordinatorTool[] = [
  {
    name: "list_projects",
    description:
      "Liste les projets MoonAgentic de l'utilisateur, avec combien de fils travaillent ou attendent une réponse.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_status",
    description:
      "L'état réel des fils d'un projet : titre, état (au travail, t'attend, en erreur, en pause), pull request. Pour répondre « où en est… ».",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
  },
  {
    name: "ask_coordinator",
    description:
      "Écrit au coordinateur d'un projet, comme si l'utilisateur tapait dans le chat du projet, et rend sa réponse. Le coordinateur ouvre lui-même les fils de travail. Peut prendre plusieurs minutes.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        message: {
          type: "string",
          description: "Le message de l'utilisateur, avec ses mots, en français.",
        },
      },
      required: ["project", "message"],
    },
  },
  {
    name: "read_thread",
    description: "Les derniers messages d'un fil, pour en donner le détail.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "L'identifiant du fil (project_status)." },
        limit: { type: "integer", description: "Nombre de messages, 1 à 20 (8 par défaut)." },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "message_thread",
    description:
      "Écrit directement à l'agent d'un fil. S'il travaille, le message attend la fin de son tour.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "L'identifiant du fil." },
        message: { type: "string", description: "Le message de l'utilisateur." },
      },
      required: ["thread_id", "message"],
    },
  },
  {
    name: "read_planner",
    description:
      "Lit le Planner : les cartes d'un projet, ou de tous les projets sans « project », avec leur colonne, leurs dates et le fil qui y travaille. Lecture seule.",
    inputSchema: {
      type: "object",
      properties: {
        project: { ...project, description: `${project.description} Sans lui : tous les projets.` },
        column: {
          type: "string",
          description: "Seulement cette colonne.",
          enum: columns,
        },
      },
    },
  },
  {
    name: "add_plan_card",
    description:
      "Ajoute une carte au Planner d'un projet, dans la colonne voulue (« À faire » sans « column »), avec ses dates si données : l'échéance la place dans la Timeline.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        title: { type: "string", description: "Titre court de la tâche." },
        description: { type: "string", description: "Le détail, si l'utilisateur en donne." },
        column: { type: "string", description: "Sa colonne.", enum: columns },
        start: { type: "string", description: "Jour de début, AAAA-MM-JJ." },
        due: { type: "string", description: "Jour d'échéance, AAAA-MM-JJ." },
      },
      required: ["project", "title"],
    },
  },
  {
    name: "update_plan_card",
    description:
      "Déplace une carte du Planner vers une autre colonne, ou change son titre, sa description, ses dates. Seuls les champs donnés changent ; une chaîne vide efface la description ou une date. Une carte liée à un fil ou à une équipe suit son travail : elle ne se déplace pas à la main.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        card: {
          type: "string",
          description: "Le numéro de la carte, comme « #12 » (read_planner).",
        },
        column: { type: "string", description: "Sa nouvelle colonne.", enum: columns },
        title: { type: "string", description: "Nouveau titre." },
        description: { type: "string", description: "Nouvelle description." },
        start: { type: "string", description: "Jour de début, AAAA-MM-JJ." },
        due: { type: "string", description: "Jour d'échéance, AAAA-MM-JJ." },
      },
      required: ["project", "card"],
    },
  },
  {
    name: "remove_plan_card",
    description:
      "Supprime une carte du Planner. Seulement sur demande explicite de l'utilisateur. Son fil, s'il en a un, reste.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        card: {
          type: "string",
          description: "Le numéro de la carte, comme « #12 » (read_planner).",
        },
      },
      required: ["project", "card"],
    },
  },
  {
    name: "schedule_task",
    description:
      "Programme une tâche : à l'heure dite, un nouveau fil du projet démarre avec ce message, une fois ou de façon répétée.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        message: { type: "string", description: "Ce que l'agent devra faire." },
        title: { type: "string", description: "Titre court, facultatif." },
        when: {
          type: "string",
          description: "Première fois, heure de l'utilisateur : AAAA-MM-JJTHH:MM.",
        },
        repeat: {
          type: "string",
          description: "Répétition.",
          enum: ["once", "hourly", "daily", "weekdays", "weekly"],
        },
      },
      required: ["project", "message", "when", "repeat"],
    },
  },
  {
    name: "list_requests",
    description:
      "Les demandes d'autorisation et les questions des agents qui attendent l'utilisateur.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "answer_request",
    description:
      "Répond à une demande de list_requests : option_id pour une autorisation, answers (un texte par question) pour une question. Seulement sur demande explicite de l'utilisateur.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Le fil de la demande." },
        request_id: { type: "string", description: "L'identifiant de la demande." },
        option_id: { type: "string", description: "Pour une autorisation : l'option choisie." },
        answers: {
          type: "array",
          items: { type: "string" },
          description: "Pour une question : une réponse par question, dans l'ordre.",
        },
      },
      required: ["thread_id", "request_id"],
    },
  },
];
