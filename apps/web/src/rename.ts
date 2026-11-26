import type { ClientMessage } from "@moonagentic/protocol";

/** What a key does in the title being renamed: nothing while a composition is under way (IME). */
export function renameKey(event: {
  key: string;
  isComposing: boolean;
}): "save" | "cancel" | undefined {
  if (event.isComposing) return undefined;
  if (event.key === "Enter") return "save";
  if (event.key === "Escape") return "cancel";
  return undefined;
}

/** Sends the new name; says it is renamed only once it went: offline, the send says why not. */
export function sendRename(
  connection: { send(message: ClientMessage): boolean; notify(message: string): void },
  threadId: string,
  title: string,
  loose: boolean,
): void {
  if (connection.send({ type: "thread.rename", threadId, title }))
    connection.notify(loose ? "Discussion renommée" : "Fil renommé");
}
