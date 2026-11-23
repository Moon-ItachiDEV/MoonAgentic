// What a thread's timeline carries to a screen: every item, without the bulk nobody reads
// until they ask for it.
import type { Item, ToolContent } from "@moonagentic/protocol";

/**
 * A tool's result up to this many characters goes with its line. A larger one, such as a
 * file read or a long command output, stays on the server until the line is opened.
 */
export const TOOL_INLINE_CHARS = 2000;

const size = (content: ToolContent): number =>
  content.type === "text"
    ? content.text.length
    : content.path.length + (content.oldText?.length ?? 0) + content.newText.length;

/** The item as the timeline carries it: a tool's large result is left out, and counted. */
export function light(item: Item): Item {
  if (item.kind !== "tool") return item;
  const chars = item.content.reduce((sum, content) => sum + size(content), 0);
  return chars > TOOL_INLINE_CHARS ? { ...item, content: [], omitted: chars } : item;
}
