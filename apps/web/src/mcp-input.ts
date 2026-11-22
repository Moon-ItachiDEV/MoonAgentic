import type { McpServerInput } from "@moonagentic/protocol";

/** Splits a command line into words, honouring single and double quotes. */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * Builds a server from the form: a URL makes an HTTP server whose secrets are `Header: value`
 * lines, anything else a command whose secrets are `NAME=value` environment lines.
 */
export function mcpServerInput(name: string, target: string, secrets: string): McpServerInput {
  const http = /^https?:\/\//i.test(target.trim());
  const separator = http ? ":" : "=";
  const pairs = secrets.split("\n").flatMap((raw, index) => {
    const line = raw.trim();
    if (!line) return [];
    const at = line.indexOf(separator);
    // The line may hold a secret, so the error names it by number only.
    if (at <= 0) throw new Error(`Secret ligne ${index + 1} : il manque « ${separator} ».`);
    return [{ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }];
  });
  if (http) return { name, transport: { type: "http", url: target.trim(), headers: pairs } };
  const [command, ...args] = splitCommandLine(target);
  if (!command) throw new Error("Indique la commande qui lance le serveur.");
  return { name, transport: { type: "stdio", command, args, env: pairs } };
}
