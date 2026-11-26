import type { Item } from "@moonagentic/protocol";

/** A page of a timeline: its items, the number of its first one, how many are before it. */
interface Page {
  items: Item[];
  first: number;
  earlier: number;
}

/**
 * All of a long thread, for an export: what is before the end this screen holds is asked
 * for a page at a time, the latest first. One answer of all of it held the server for
 * 0.7 s on a thread of 20 000 messages (audit of 2026-11-25, N16).
 */
export async function wholeThread(
  page: (before: number) => Promise<Page>,
  end: Item[],
  first: number,
  earlier: number,
): Promise<Item[]> {
  const pages: Item[][] = [];
  let before = first;
  let left = earlier;
  while (left > 0) {
    const got = await page(before);
    // Nothing before it after all: the thread was cut meanwhile.
    if (!got.items.length || got.first >= before) break;
    pages.unshift(got.items);
    before = got.first;
    left = got.earlier;
  }
  // The end this screen holds wins: it has what is being written now.
  const held = new Set(end.map((i) => i.id));
  return [...pages.flat().filter((i) => !held.has(i.id)), ...end];
}
