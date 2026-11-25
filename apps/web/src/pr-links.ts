// GitHub pull request links in what the user writes: shown as a small « PR 155 » chip in the
// composer and in the sent message, while the agent still gets the whole address.

export interface PrLink {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const PATTERN =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#][^\s,;)\]>»"']*)?/g;

/** The pull request links a text holds, in order, each once. */
export function prLinks(text: string): PrLink[] {
  const seen = new Set<string>();
  const out: PrLink[] = [];
  for (const m of text.matchAll(PATTERN)) {
    const link = { url: m[0], owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
    const key = prKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** Splits a text into plain parts and pull request links. */
export function prParts(text: string): ({ text: string } | { link: PrLink })[] {
  const parts: ({ text: string } | { link: PrLink })[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ link: { url: m[0], owner: m[1]!, repo: m[2]!, number: Number(m[3]) } });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Takes the links out of what is typed: the text without them (spaces tidied where a link
 * stood) and the links, for the composer to show as chips.
 */
export function takePrLinks(text: string): { text: string; links: PrLink[] } {
  const links = prLinks(text);
  if (!links.length) return { text, links };
  const rest = text
    .replace(PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
  return { text: rest.trim() === "" ? "" : rest, links };
}

/**
 * The message the agent gets: what was written, then each link in full, on the same line
 * when the text is one line (so « /revue » keeps the link as its argument).
 */
export function withPrLinks(text: string, links: PrLink[]): string {
  if (!links.length) return text;
  const urls = links.map((l) => l.url).join(" ");
  const body = text.trimEnd();
  if (!body.trim()) return urls;
  return `${body}${body.includes("\n") ? "\n" : " "}${urls}`;
}

export const prKey = (l: { owner: string; repo: string; number: number }): string =>
  `${l.owner}/${l.repo}#${l.number}`.toLowerCase();

/** « owner/repo » of a pull request address. */
export function repoOfUrl(url: string): string | undefined {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\//.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}
