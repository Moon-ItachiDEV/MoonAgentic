import type { Item } from "@moonagentic/protocol";
import type { FeedBlock } from "./team-feed.ts";

/**
 * Antigravity's own switches in and out of its plan mode: they change nothing the user
 * reads, so they are not shown at all.
 */
const PLAN_MODE = /^(?:run\s+)?(?:enter|exit)_plan_mode$/i;

export const isPlanModeSwitch = (item: Item | undefined) =>
  item?.kind === "tool" && PLAN_MODE.test(item.title.trim());

/**
 * What a thread shows: the user's messages, each turn's last answer and what waits on the
 * user stay in sight. The rest of a turn, its thoughts, its tools, what the agent said on
 * the way and the permissions already answered, folds into one line per stretch, which
 * reads as the agent's live activity while it works.
 */
export function activityFeed(items: Item[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  let start = 0;
  while (start < items.length) {
    let end = start + 1;
    while (end < items.length && items[end]?.kind !== "user") end++;
    const turn = Array.from({ length: end - start }, (_, i) => start + i);
    const lastAgent = turn.findLast((i) => items[i]?.kind === "agent");
    for (const i of turn) {
      const item = items[i]!;
      if (isPlanModeSwitch(item)) continue;
      const fold =
        item.kind === "thought" ||
        (item.kind === "tool" && !item.questions) ||
        (item.kind === "permission" && item.outcome !== null) ||
        (item.kind === "agent" && i !== lastAgent);
      const before = blocks.at(-1);
      if (!fold) blocks.push({ kind: "item", index: i });
      else if (before?.kind === "detail") before.indices.push(i);
      else blocks.push({ kind: "detail", key: item.id, indices: [i] });
    }
    start = end;
  }
  return blocks;
}

/** The last name of a file in a tool's title, such as `session.ts` in a full path. */
function fileIn(title: string): string | undefined {
  const names = title.match(/[^\s/\\"'`]+\.[A-Za-z0-9]{1,8}(?=$|[\s"'`:,)])/g);
  return names?.at(-1);
}

const clip = (text: string, max = 60) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** What the agent is doing, in a few words, from the item it is at. */
export function activityLabel(item: Item | undefined): string {
  if (!item) return "Travaille…";
  switch (item.kind) {
    case "thought":
      return "Réfléchit…";
    case "agent":
      return "Écrit…";
    case "permission":
      return clip(item.title);
    case "tool": {
      const file = fileIn(item.title);
      switch (item.toolKind) {
        case "read":
          return file ? `Lit ${file}…` : "Lit des fichiers…";
        case "edit":
          return file ? `Modifie ${file}…` : "Modifie des fichiers…";
        case "delete":
          return file ? `Supprime ${file}…` : "Supprime des fichiers…";
        case "move":
          return file ? `Déplace ${file}…` : "Déplace des fichiers…";
        case "search":
          return "Cherche dans le code…";
        case "execute":
          return /\btest/i.test(item.title) ? "Lance les tests…" : "Lance une commande…";
        case "fetch":
          return "Consulte le web…";
        case "think":
          return "Réfléchit…";
        default:
          return clip(item.title);
      }
    }
    default:
      return "Travaille…";
  }
}

/** The steps a folded stretch holds, and how many of them failed. */
export function activitySteps(items: Item[], indices: number[]) {
  const tools = indices.map((i) => items[i]).filter((i) => i?.kind === "tool");
  return {
    steps: tools.length,
    failed: tools.filter((t) => t?.kind === "tool" && t.status === "failed").length,
  };
}
