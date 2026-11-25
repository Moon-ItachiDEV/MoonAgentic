import type { ReactNode } from "react";

/** Something the search can do: a command with its name, as Ctrl K lists it. */
export interface QuickAction {
  label: string;
  icon: ReactNode;
  /** Keys shown beside it. */
  keys?: string;
  run: () => void;
}

/** True when every character of `query` appears in `text`, in order. */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of text.toLowerCase()) if (ch === q[i]) i += 1;
  return i === q.length;
}
