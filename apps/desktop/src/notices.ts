// The notices the interface asks to show, checked: they come from a web page.

export interface DesktopNotice {
  title: string;
  body: string;
  tag: string;
  threadId: string;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/** The notice as the shell shows it, or undefined when it is not one. */
export function readNotice(value: unknown): DesktopNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const title = text(v.title, 200);
  const body = text(v.body, 1_000);
  const tag = text(v.tag, 200);
  const threadId = text(v.threadId, 200);
  if (!title || body === undefined || !tag || threadId === undefined) return undefined;
  return { title, body, tag, threadId };
}
