import type { Item } from "@moonagentic/protocol";

const MAX_ENTRY = 2_000;
const MAX_TOTAL = 40_000;

const clip = (text: string) =>
  text.length > MAX_ENTRY ? `${text.slice(0, MAX_ENTRY).trimEnd()}…` : text;

/**
 * The thread's conversation before `itemId`, written for an agent that starts without it:
 * after a hand-off, a step back, or a session it could not resume. The most recent part
 * is kept when it is too long. Undefined when nothing was said yet.
 */
export function historyBefore(
  items: Item[],
  itemId: string,
  agentName: (agentId: string) => string,
  /** Where an image of the thread is kept, so the agent taking over can open it. */
  imageFile?: (id: string) => string | undefined,
): string | undefined {
  const end = items.findIndex((i) => i.id === itemId);
  const entries = (end === -1 ? items : items.slice(0, end)).flatMap((item) => {
    switch (item.kind) {
      case "user":
        return [
          `Utilisateur : ${clip(item.text)}${(item.images ?? [])
            .map((image) => ` [image jointe : ${imageFile?.(image.id) ?? image.name}]`)
            .join("")}`,
        ];
      case "agent":
        return [`Agent : ${clip(item.text)}`];
      case "tool":
        return [`Outil : ${item.title}${item.status === "failed" ? " (échoué)" : ""}`];
      case "handoff":
        return [`(${agentName(item.from)} passe le relais à ${agentName(item.to)}.)`];
      default:
        return [];
    }
  });
  if (!entries.length) return undefined;
  let kept = entries.length;
  let size = 0;
  while (kept > 0 && size + (entries[kept - 1]?.length ?? 0) <= MAX_TOTAL) {
    size += entries[kept - 1]?.length ?? 0;
    kept -= 1;
  }
  const recent = entries.slice(kept);
  return [
    "Tu reprends une conversation déjà commencée dans MoonAgentic, avec un autre agent ou dans une session précédente. Voici ce qui s'est dit jusqu'ici, du plus ancien au plus récent. Le nouveau message de l'utilisateur suit à part.",
    ...(kept > 0 ? ["(Le début de la conversation est coupé.)"] : []),
    ...recent,
  ].join("\n\n");
}
