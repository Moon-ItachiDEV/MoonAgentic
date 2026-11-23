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

/** How many changed items a thread remembers for the screens that come back. */
const CHANGES_KEPT = 300;

/**
 * What changed in one thread's timeline since the server started, so a screen that was away
 * gets those items only. Each change has a number; a screen says the last one it saw.
 */
export class TimelineLog {
  /** The number of the last change. */
  rev = 0;
  /** A screen that last saw an older change than this one is sent the timeline again. */
  private floor = 0;
  /** The last change of each item, the oldest first. */
  private readonly changed = new Map<string, number>();

  /** Notes that the item is new or was changed; returns the change's number. */
  touch(itemId: string): number {
    this.rev += 1;
    this.changed.delete(itemId);
    this.changed.set(itemId, this.rev);
    if (this.changed.size > CHANGES_KEPT) {
      const [oldest, at] = this.changed.entries().next().value!;
      this.changed.delete(oldest);
      this.floor = at;
    }
    return this.rev;
  }

  /** Items were removed: no screen can be brought up to date item by item any more. */
  reset(): number {
    this.rev += 1;
    this.floor = this.rev;
    this.changed.clear();
    return this.rev;
  }

  /** The items changed after the change numbered `rev`, or nothing when that is too far back. */
  since(rev: number): string[] | undefined {
    if (rev < this.floor || rev > this.rev) return undefined;
    const ids: string[] = [];
    for (const [id, at] of this.changed) if (at > rev) ids.push(id);
    return ids;
  }
}
