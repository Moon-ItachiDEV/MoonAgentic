// An answer's Markdown as the HTML of each of its blocks: a title, a paragraph, a list, a
// table, a block of code. An answer being written grows by its end, many times a second:
// cut so, only its last block is cleaned and put on the page again, whatever its length.
import { Marked, type MarkedOptions, Parser, type Token, type Tokens } from "marked";
import { localFiles } from "./local-files.ts";

/** What the last answer read was cut into: filled while Marked writes it, taken right after. */
let cut: string[] = [];

const marked = new Marked(localFiles, {
  hooks: {
    // The HTML is written block by block, after all that is done to the answer as a whole:
    // the links it defines further down, the files of the computer it names.
    provideParser(block) {
      if (!block) return Parser.parseInline;
      return (tokens, options) => {
        cut = byBlock(tokens, options);
        return cut.join("");
      };
    },
  },
});

/** Whether a block holds HTML the answer wrote itself, at any depth. */
function holdsHtml(token: Token): boolean {
  if (token.type === "html") return true;
  const inner = token as {
    tokens?: Token[];
    items?: Token[];
    header?: Tokens.TableCell[];
    rows?: Tokens.TableCell[][];
  };
  return (
    (inner.tokens?.some(holdsHtml) ?? false) ||
    (inner.items?.some(holdsHtml) ?? false) ||
    (inner.header?.some((cell) => cell.tokens.some(holdsHtml)) ?? false) ||
    (inner.rows?.some((row) => row.some((cell) => cell.tokens.some(holdsHtml))) ?? false)
  );
}

/**
 * The HTML of each block, as Marked writes them one after the other. HTML of the answer's
 * own stays in one piece with all that follows it: a tag opened in a block may close in
 * another, and cleaned apart they would not read as they do together. What is before it
 * reads the same either way, a page being read from its start.
 */
function byBlock(tokens: Token[], options?: MarkedOptions): string[] {
  const parser = new Parser(options);
  const blocks: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const own = holdsHtml(tokens[i]!);
    const html = parser.parse(own ? tokens.slice(i) : [tokens[i]!]);
    // A frameset is the one tag read by what the whole page held before it, text or none:
    // an answer that writes one stays in one piece.
    if (own && /<frameset/i.test(html)) return [parser.parse(tokens)];
    if (html) blocks.push(html);
    if (own) break;
  }
  return blocks;
}

/**
 * The HTML of an answer, not yet cleaned, block by block: put end to end, it is the HTML
 * Marked writes for the whole answer.
 */
export function answerBlocks(text: string): string[] {
  cut = [];
  // `fil:` is no address the cleaner keeps: the link is marked as one of the page's own.
  marked.parse(text.replace(/\]\(fil:/g, "](#fil:"), { async: false, gfm: true, breaks: true });
  const blocks = cut;
  cut = [];
  return blocks;
}
