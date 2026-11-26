import type { Item } from "@moonagentic/protocol";

const MAX_ENTRY = 2_000;
const MAX_TOTAL = 40_000;

const clip = (text: string) =>
  text.length > MAX_ENTRY ? `${text.slice(0, MAX_ENTRY).trimEnd()}…` : text;

export interface HistoryOptions {
  /** Thread id, given when the agent has `read_thread` to inspect omitted earlier messages. */
  threadId?: string;
}

/**
 * Formats a project's shared memory notes for injection at the start of a fresh session.
 * Returns undefined when the project has no saved memory, so empty projects pay zero tokens.
 */
export function projectMemoryContext(memory: string): string | undefined {
  const trimmed = memory.trim();
  if (!trimmed) return undefined;
  return [
    "Mémoire partagée du projet (notes durables communes à tous les fils, agents et branches de ce projet dans MoonAgentic) :",
    trimmed,
  ].join("\n\n");
}

/**
 * The thread's conversation before `itemId`, written for an agent that starts without it:
 * after a hand-off, a step back, or a session it could not resume. When it is too long,
 * the original user request and the most recent part are kept, with a note of how many
 * intermediate messages were omitted. Undefined when nothing was said yet.
 */
export function historyBefore(
  items: Item[],
  itemId: string,
  agentName: (agentId: string) => string,
  /** Where an image of the thread is kept, so the agent taking over can open it. */
  imageFile?: (id: string) => string | undefined,
  options?: HistoryOptions,
): string | undefined {
  const end = items.findIndex((i) => i.id === itemId);
  const entries = (end === -1 ? items : items.slice(0, end)).flatMap((item) => {
    switch (item.kind) {
      case "user":
        return [
          {
            isUser: true,
            text: `Utilisateur : ${clip(item.text)}${(item.images ?? [])
              .map((image) => ` [image jointe : ${imageFile?.(image.id) ?? image.name}]`)
              .join("")}`,
          },
        ];
      case "agent":
        return [{ isUser: false, text: `Agent : ${clip(item.text)}` }];
      case "tool":
        return [
          {
            isUser: false,
            text: `Outil : ${item.title}${item.status === "failed" ? " (échoué)" : ""}`,
          },
        ];
      case "handoff":
        return [
          {
            isUser: false,
            text: `(${agentName(item.from)} passe le relais à ${agentName(item.to)}.)`,
          },
        ];
      case "moved":
        return [
          { isUser: false, text: `(La conversation a été déplacée dans le projet ${item.name}.)` },
        ];
      default:
        return [];
    }
  });
  if (!entries.length) return undefined;

  const header =
    "Tu reprends une conversation déjà commencée dans MoonAgentic, avec un autre agent ou dans une session précédente. Voici ce qui s'est dit jusqu'ici, du plus ancien au plus récent. Le nouveau message de l'utilisateur suit à part.";
  const totalSize = entries.reduce((sum, e) => sum + e.text.length, 0);
  if (totalSize <= MAX_TOTAL) {
    return [header, ...entries.map((e) => e.text)].join("\n\n");
  }

  const firstUser = entries.findIndex((e) => e.isUser);
  if (firstUser !== -1) {
    const origin = entries[firstUser]!;
    const budget = Math.max(0, MAX_TOTAL - origin.text.length);
    let kept = entries.length;
    let size = 0;
    while (kept > firstUser + 1 && size + (entries[kept - 1]?.text.length ?? 0) <= budget) {
      size += entries[kept - 1]?.text.length ?? 0;
      kept -= 1;
    }
    const omitted = kept - firstUser - 1;
    const hint = options?.threadId
      ? ` Tu peux relire les messages précédents avec read_thread (thread_id : "${options.threadId}").`
      : "";
    return [
      header,
      ...(firstUser > 0 ? ["(Le début de la conversation est coupé.)"] : []),
      origin.text,
      ...(omitted > 0
        ? [
            `(${omitted} ${omitted > 1 ? "messages intermédiaires omis" : "message intermédiaire omis"}.${hint})`,
          ]
        : []),
      ...entries.slice(kept).map((e) => e.text),
    ].join("\n\n");
  }

  let kept = entries.length;
  let size = 0;
  while (kept > 0 && size + (entries[kept - 1]?.text.length ?? 0) <= MAX_TOTAL) {
    size += entries[kept - 1]?.text.length ?? 0;
    kept -= 1;
  }
  const recent = entries.slice(kept).map((e) => e.text);
  return [
    header,
    ...(kept > 0 ? ["(Le début de la conversation est coupé.)"] : []),
    ...recent,
  ].join("\n\n");
}
