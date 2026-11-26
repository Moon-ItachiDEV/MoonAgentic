import type {
  AgentInfo,
  ContextUsage,
  Item,
  Team,
  TeamLanePhase,
  TeamRole,
  Thread,
} from "@moonagentic/protocol";
import { activityGlyph, activityLabel } from "./activity.ts";
import type { GlyphKind } from "./glyphs.ts";
import { modelNameOf } from "./model-label.ts";

/**
 * The team as a tree of agents: the lead, then for each piece its coder with the reviewer
 * and the tester under it, then the merge and the pull request. Every field comes from the
 * team's own state, its members' threads and the items of those threads; nothing is made up.
 */

export type Tone = "work" | "idle" | "ok" | "warn" | "err";
export type ToolGroup = "read" | "edit" | "search" | "run" | "web" | "other";

/** Something handed from one agent to another, as the team's timeline recorded it. */
export interface Relay {
  at: number;
  from: string;
  to: string;
  tone: Tone;
  text: string;
}

export interface TreeNode {
  key: string;
  role: TeamRole;
  name: string;
  /** The role when the name is the piece's title, then the model. */
  sub: string;
  agentId: string;
  /** Its thread, once it has one. */
  threadId?: string;
  tone: Tone;
  label: string;
  /** Drawn only while the agent really works, waits for the user or for a place. */
  glyph?: GlyphKind;
  action: string;
  /** What it was asked to do. */
  mission: string;
  usage?: ContextUsage;
  /** The tools it called, by kind, most used first. Empty until its items are here. */
  tools: [ToolGroup, number][];
  /** What it did last, newest first. */
  steps: { at: number; text: string }[];
  /** The last thing handed to it, and the last thing it handed on. */
  relay?: Relay;
  sent?: Relay;
  /** Not started: it has no thread yet. */
  pending: boolean;
}

export interface TreePiece {
  coder: TreeNode;
  reviewer?: TreeNode;
  reviewer2?: TreeNode;
  judge?: TreeNode;
  tester?: TreeNode;
}

export interface TreePr {
  tone: Tone;
  label: string;
  url?: string;
}

export interface TeamTreeModel {
  lead: TreeNode;
  pieces: TreePiece[];
  merger?: TreeNode;
  pr?: TreePr;
  relays: Relay[];
  nodes: Record<string, TreeNode>;
}

export const LEAD = "lead";
export const MERGE = "merge";
export const PR = "pr";
export const coderKey = (i: number) => `c${i}`;
export const reviewerKey = (i: number) => `r${i}`;
export const testerKey = (i: number) => `t${i}`;
export const reviewer2Key = (i: number) => `s${i}`;
export const judgeKey = (i: number) => `j${i}`;

const MERGE_LANE = -2;

export const GLYPH_LABEL: Record<GlyphKind, string> = {
  pense: "Réfléchit",
  cherche: "Cherche",
  lit: "Lit",
  modifie: "Modifie",
  commande: "Lance une commande",
  tests: "Lance les tests",
  web: "Consulte le web",
  ecrit: "Écrit",
  travaille: "Travaille",
  demarre: "Démarre",
  attend: "Attend ta réponse",
  file: "En file",
};

const toolGroup = (kind: string): ToolGroup =>
  kind === "read"
    ? "read"
    : kind === "edit" || kind === "delete" || kind === "move"
      ? "edit"
      : kind === "search"
        ? "search"
        : kind === "execute"
          ? "run"
          : kind === "fetch"
            ? "web"
            : "other";

const clip = (text: string, max = 90) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^VERDICT\s*:/i.test(l)) ?? "";
const plain = (label: string) => label.replace(/…$/, "");

/** What an item says the agent is at: the command itself for a command, else its label. */
function actionOf(item: Item | undefined): string {
  if (item?.kind === "tool" && item.toolKind === "execute") return clip(item.title);
  return plain(activityLabel(item));
}

/** The tools a thread called and its last steps, from its items. */
export function threadDigest(items: readonly Item[] | undefined): {
  tools: [ToolGroup, number][];
  steps: { at: number; text: string }[];
} {
  if (!items) return { tools: [], steps: [] };
  const counts = new Map<ToolGroup, number>();
  const steps: { at: number; text: string }[] = [];
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const group = toolGroup(item.toolKind);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  for (let i = items.length - 1; i >= 0 && steps.length < 7; i--) {
    const item = items[i]!;
    if (item.kind !== "tool" && item.kind !== "agent") continue;
    const text = actionOf(item);
    // An answer written in several items in a row is one step.
    if (steps.at(-1)?.text !== text) steps.push({ at: item.at, text });
  }
  return { tools: [...counts].sort((a, b) => b[1] - a[1]), steps };
}

/** The relays the timeline holds, oldest first: each is a lane that changed phase. */
export function teamRelays(team: Team): Relay[] {
  const relays: Relay[] = [];
  const last = new Map<number, TeamLanePhase>();
  const hasMerge = team.tasks.length > 1 && (!!team.merger || !!team.mergeThreadId);
  const sink = hasMerge ? MERGE : team.autoShip === false ? undefined : PR;
  /** Who held the piece during a phase. */
  const holder = (i: number, phase: TeamLanePhase | undefined) =>
    phase === "reviewing" && team.reviewer
      ? reviewerKey(i)
      : phase === "judging" && team.judge
        ? judgeKey(i)
        : phase === "testing" && team.tester
          ? testerKey(i)
          : coderKey(i);
  for (const event of team.timeline ?? []) {
    const before = last.get(event.lane);
    last.set(event.lane, event.phase);
    const { at, lane, phase } = event;
    if (lane === MERGE_LANE) {
      if (phase === "done" && team.autoShip !== false) {
        relays.push({ at, from: MERGE, to: PR, tone: "ok", text: "Tout tient ensemble" });
      }
      continue;
    }
    if (lane < 0) continue;
    const task = team.tasks[lane];
    if (!task) continue;
    const title = task.title;
    if (phase === "running") {
      if (before === "reviewing" || before === "judging" || before === "testing") {
        relays.push({
          at,
          from: holder(lane, before),
          to: coderKey(lane),
          tone: "warn",
          text: "À corriger",
        });
      } else if (before === undefined || before === "waiting" || before === "lead") {
        relays.push({
          at,
          from: LEAD,
          to: coderKey(lane),
          tone: "work",
          text: before === "lead" ? "Consigne revue" : "Consigne de départ",
        });
      }
    } else if (phase === "reviewing" && team.reviewer) {
      relays.push({
        at,
        from: coderKey(lane),
        to: reviewerKey(lane),
        tone: "work",
        text: "Changements à relire",
      });
    } else if (phase === "judging" && team.judge) {
      relays.push({
        at,
        from: reviewerKey(lane),
        to: judgeKey(lane),
        tone: "warn",
        text: "Relectures à arbitrer",
      });
    } else if (phase === "testing" && team.tester) {
      const relu = (before === "reviewing" || before === "judging") && !!team.reviewer;
      relays.push({
        at,
        from: holder(lane, before),
        to: testerKey(lane),
        tone: relu ? "ok" : "work",
        text: relu ? "Relu, rien à corriger" : "Changements à tester",
      });
    } else if (phase === "lead") {
      relays.push({
        at,
        from: holder(lane, before),
        to: LEAD,
        tone: "warn",
        text: `Consigne à revoir : ${title}`,
      });
    } else if (phase === "done" && sink) {
      relays.push({
        at,
        from: holder(lane, before),
        to: sink,
        tone: "ok",
        text: `Prête : ${title}`,
      });
    }
  }
  return relays;
}

interface Input {
  lead: Thread;
  team: Team;
  threads: readonly Thread[];
  agents: readonly AgentInfo[];
  /** The items of the members' threads that are here. */
  items: Readonly<Record<string, readonly Item[] | undefined>>;
}

const active = (team: Team) =>
  team.phase === "planning" || team.phase === "coding" || team.phase === "merging";

/** The tree, from the team's state as it is now. */
export function teamTree({ lead, team, threads, agents, items }: Input): TeamTreeModel {
  const byId = (id: string | undefined) => (id ? threads.find((t) => t.id === id) : undefined);
  const modelOf = (member: { agentId: string; model?: string | undefined }) => {
    const agent = agents.find((a) => a.id === member.agentId);
    return modelNameOf(agent?.models, member.model) ?? agent?.name ?? member.agentId;
  };
  const running = active(team);
  const lastPhases = new Map<number, TeamLanePhase[]>();
  for (const e of team.timeline ?? []) {
    const list = lastPhases.get(e.lane) ?? [];
    list.push(e.phase);
    lastPhases.set(e.lane, list);
  }
  /** The phase the piece was in just before the one it is in. */
  const cameFrom = (lane: number) => lastPhases.get(lane)?.at(-2);

  /** What a thread at work, asking or in line shows; nothing when it is at rest. */
  const live = (
    thread: Thread | undefined,
  ): Pick<TreeNode, "tone" | "label" | "glyph" | "action"> | undefined => {
    if (!thread) return undefined;
    if (thread.status === "waiting") {
      return {
        tone: "warn",
        label: GLYPH_LABEL.attend,
        glyph: "attend",
        action: GLYPH_LABEL.attend,
      };
    }
    if (thread.status === "error") {
      return {
        tone: "err",
        label: "Erreur",
        action: firstLine(thread.error ?? "") || "L'agent s'est arrêté",
      };
    }
    if (thread.status !== "running") return undefined;
    if (thread.inLine) {
      return {
        tone: "idle",
        label: GLYPH_LABEL.file,
        glyph: "file",
        action: "Démarre dès qu'une place se libère",
      };
    }
    const mine = items[thread.id];
    const item = mine?.at(-1);
    // Its items are not here yet: it works, and that is all there is to say.
    const glyph = mine ? activityGlyph(item) : "travaille";
    return { tone: "work", label: GLYPH_LABEL[glyph], glyph, action: mine ? actionOf(item) : "" };
  };

  const node = (
    base: Pick<TreeNode, "key" | "role" | "name" | "mission"> & { sub?: string },
    member: { agentId: string; model?: string | undefined },
    thread: Thread | undefined,
    rest: Pick<TreeNode, "tone" | "label" | "action">,
  ): TreeNode => {
    const who = thread ? { agentId: thread.agentId, model: thread.model } : member;
    const digest = threadDigest(thread ? items[thread.id] : undefined);
    const at = live(thread) ?? rest;
    return {
      ...base,
      sub: [base.sub, modelOf(who)].filter(Boolean).join(" · "),
      agentId: who.agentId,
      ...(thread ? { threadId: thread.id } : {}),
      ...at,
      ...(thread?.usage ? { usage: thread.usage } : {}),
      ...digest,
      pending: !thread,
    };
  };

  const leadRest = (): Pick<TreeNode, "tone" | "label" | "action"> => {
    switch (team.phase) {
      case "done":
        return {
          tone: "ok",
          label: "Terminé",
          action: team.shipped?.opened ? "Équipe terminée, PR ouverte" : "Équipe terminée",
        };
      case "blocked":
        return { tone: "warn", label: "À toi de voir", action: "L'équipe t'attend" };
      case "failed":
        return { tone: "err", label: "Échoué", action: firstLine(team.error ?? "") || "Erreur" };
      case "stopped":
        return { tone: "idle", label: "Arrêté", action: "Équipe arrêtée" };
      default: {
        const n = team.tasks.length;
        return {
          tone: "idle",
          label: "Suit l'équipe",
          action: n ? `Suit ${n > 1 ? `les ${n} sous-tâches` : "la sous-tâche"}` : "",
        };
      }
    }
  };

  const leadNode = node(
    { key: LEAD, role: "lead", name: "Chef", mission: team.task },
    lead,
    lead,
    leadRest(),
  );

  const pieces = team.tasks.map((task, i): TreePiece => {
    const note = firstLine(task.note ?? "");
    const from = cameFrom(i);
    // Sent back to its coder: by whoever held it just before.
    const sentBack =
      task.status === "running" &&
      (from === "reviewing" || from === "judging" || from === "testing");
    const coderRest = (): Pick<TreeNode, "tone" | "label" | "action"> => {
      switch (task.status) {
        case "reviewing":
          return {
            tone: "idle",
            label: "En relecture",
            action: "Attend le verdict de la relecture",
          };
        case "judging":
          return { tone: "idle", label: "En arbitrage", action: "Attend le verdict de l'arbitre" };
        case "testing":
          return { tone: "idle", label: "En test", action: "Attend le résultat des tests" };
        case "lead":
          return { tone: "idle", label: "Consigne revue", action: "Le chef réécrit sa consigne" };
        case "done":
          return { tone: "ok", label: "Terminé", action: task.merged ? "Fusionnée" : "Prête" };
        case "blocked":
          return { tone: "warn", label: "À toi de voir", action: note || "Bloquée" };
        case "failed":
          return { tone: "err", label: "Échoué", action: note || "Erreur" };
        case "stopped":
          return { tone: "idle", label: "Arrêté", action: "Sous-tâche arrêtée" };
        case "running":
          return {
            tone: "idle",
            label: "En attente",
            action: task.tries ? `Correction ${task.tries} sur 3` : "",
          };
        default:
          return { tone: "idle", label: "En attente", action: "Attend sa consigne" };
      }
    };
    /** A checker at rest: what its verdict was, as far as the piece's state tells. */
    const checkRest = (
      mine: "reviewing" | "judging" | "testing",
      passed: boolean,
    ): Pick<TreeNode, "tone" | "label" | "action"> => {
      // The reviews are in: the judge weighs them.
      if (mine === "reviewing" && task.status === "judging") {
        return { tone: "ok", label: "Relu", action: "Chez l'arbitre" };
      }
      // Nothing was found to weigh: the judge was never asked.
      if (mine === "judging" && finished && !task.judgeThreadId) {
        return { tone: "idle", label: "Pas appelé", action: "Rien à peser" };
      }
      if (passed) return { tone: "ok", label: "Validé", action: "Rien à corriger" };
      if (sentBack && from === mine) {
        return {
          tone: "warn",
          label: "À corriger",
          action: note || "Remarques envoyées au codeur",
        };
      }
      if (task.status === "blocked" && from === mine) {
        return { tone: "warn", label: "À toi de voir", action: note || "Bloquée" };
      }
      return { tone: "idle", label: "En attente", action: "Attend la sous-tâche" };
    };
    const tested = task.status === "testing" && !!team.tester;
    const finished = task.status === "done" || tested;
    const reviewed = finished;
    // Weighed by the judge, once it was asked to.
    const judged = finished && !!task.judgeThreadId;
    return {
      coder: node(
        {
          key: coderKey(i),
          role: "coder",
          name: task.title,
          sub: "Codeur",
          mission: task.brief || task.title,
        },
        team.coder,
        byId(task.threadId),
        coderRest(),
      ),
      ...(team.reviewer
        ? {
            reviewer: node(
              {
                key: reviewerKey(i),
                role: "reviewer",
                name: "Relecture",
                mission: `Relit les changements de « ${task.title} » avant qu'elle compte comme faite.`,
              },
              team.reviewer,
              byId(task.reviewThreadId),
              checkRest("reviewing", reviewed),
            ),
          }
        : {}),
      ...(team.reviewer && team.reviewer2
        ? {
            reviewer2: node(
              {
                key: reviewer2Key(i),
                role: "reviewer2",
                name: "Relecture 2",
                mission: `Relit aussi les changements de « ${task.title} », de son côté.`,
              },
              team.reviewer2,
              byId(task.review2ThreadId),
              checkRest("reviewing", reviewed),
            ),
          }
        : {}),
      ...(team.reviewer && team.judge
        ? {
            judge: node(
              {
                key: judgeKey(i),
                role: "judge",
                name: "Arbitre",
                mission: `Pèse les relectures de « ${task.title} » et garde ce qui est vraiment à corriger.`,
              },
              team.judge,
              byId(task.judgeThreadId),
              checkRest("judging", judged),
            ),
          }
        : {}),
      ...(team.tester
        ? {
            tester: node(
              {
                key: testerKey(i),
                role: "tester",
                name: "Tests",
                mission: `Lance les tests de « ${task.title} » et écrit ceux qui manquent.`,
              },
              team.tester,
              byId(task.testThreadId),
              checkRest("testing", task.status === "done"),
            ),
          }
        : {}),
    };
  });

  const mergeThread = byId(team.mergeThreadId);
  const hasMerge = team.tasks.length > 1 && (!!team.merger || !!mergeThread);
  const merger = hasMerge
    ? node(
        {
          key: MERGE,
          role: "merger",
          name: "Fusion",
          mission:
            "Réunit les sous-tâches sur une seule branche, règle les conflits, puis vérifie que tout marche ensemble.",
        },
        team.merger ?? team.coder,
        mergeThread,
        team.phase === "done"
          ? { tone: "ok", label: "Terminé", action: "Tout tient ensemble" }
          : team.phase === "blocked" &&
              mergeThread &&
              !team.tasks.some((t) => t.status === "blocked")
            ? {
                tone: "warn",
                label: "À toi de voir",
                action: firstLine(team.error ?? "") || "La fusion t'attend",
              }
            : { tone: "idle", label: "En attente", action: "Attend les sous-tâches" },
      )
    : undefined;

  const pr = ((): TreePr | undefined => {
    if (team.shipped?.opened) {
      return {
        tone: "ok",
        label: "PR ouverte",
        ...(team.shipped.url ? { url: team.shipped.url } : {}),
      };
    }
    if (team.shipping) return { tone: "work", label: "Ouverture de la PR…" };
    if (team.shipError) return { tone: "warn", label: "La PR n'a pas pu s'ouvrir" };
    if (team.shipped?.url)
      return { tone: "idle", label: "PR à créer sur GitHub", url: team.shipped.url };
    if (team.autoShip === false) return undefined;
    return running || team.phase === "done"
      ? { tone: "idle", label: "La PR s'ouvrira à la fin" }
      : undefined;
  })();

  const nodes: Record<string, TreeNode> = { [LEAD]: leadNode };
  for (const p of pieces) {
    nodes[p.coder.key] = p.coder;
    if (p.reviewer) nodes[p.reviewer.key] = p.reviewer;
    if (p.reviewer2) nodes[p.reviewer2.key] = p.reviewer2;
    if (p.judge) nodes[p.judge.key] = p.judge;
    if (p.tester) nodes[p.tester.key] = p.tester;
  }
  if (merger) nodes[MERGE] = merger;

  const relays = teamRelays(team).filter(
    (r) => (nodes[r.from] || r.from === PR) && (nodes[r.to] || (r.to === PR && pr)),
  );
  for (const relay of relays) {
    const to = nodes[relay.to];
    const from = nodes[relay.from];
    if (to) to.relay = relay;
    if (from) from.sent = relay;
  }
  // The remarks kept on the piece are those of its last correction.
  team.tasks.forEach((task, i) => {
    const coder = nodes[coderKey(i)];
    const note = firstLine(task.note ?? "");
    if (coder?.relay?.tone === "warn" && note) {
      coder.relay = { ...coder.relay, text: `À corriger : ${clip(note, 120)}` };
    }
  });

  return {
    lead: leadNode,
    pieces,
    ...(merger ? { merger } : {}),
    ...(pr ? { pr } : {}),
    relays,
    nodes,
  };
}

/** The members' threads the tree reads: every one but the lead's. */
export function memberThreadIds(team: Team): string[] {
  const ids = team.tasks.flatMap((t) => [
    t.threadId,
    t.reviewThreadId,
    t.review2ThreadId,
    t.judgeThreadId,
    t.testThreadId,
  ]);
  return [...ids, team.mergeThreadId].filter((id): id is string => !!id);
}
