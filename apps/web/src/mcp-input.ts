import { ENV_NAME, HEADER_NAME, type McpServerInput } from "@moonagentic/protocol";

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
  if (quote) throw new Error("Un guillemet n'est pas fermé dans la commande.");
  if (started) words.push(word);
  return words;
}

// Some browsers accept a space in a host name; the server's parser does not.
const validUrl = (url: string) => {
  try {
    return !/\s/.test(url) && Boolean(new URL(url).host);
  } catch {
    return false;
  }
};

/**
 * Builds a server from the form: a URL makes an HTTP server whose secrets are `Header: value`
 * lines, anything else a command whose secrets are `NAME=value` environment lines.
 */
export function mcpServerInput(name: string, target: string, secrets: string): McpServerInput {
  const http = /^https?:\/\//i.test(target.trim());
  const separator = http ? ":" : "=";
  const seen = new Map<string, number>();
  const pairs = secrets.split("\n").flatMap((raw, index) => {
    // Pasted from a shell profile, an environment line may start with `export`.
    const line = http ? raw.trim() : raw.trim().replace(/^export\s+/, "");
    if (!line) return [];
    // The line may hold a secret, so errors name it by number only, never by its text.
    const where = `Secret ligne ${index + 1}`;
    const at = line.indexOf(separator);
    if (at <= 0) throw new Error(`${where} : il manque « ${separator} ».`);
    const key = line.slice(0, at).trim();
    if (!(http ? HEADER_NAME : ENV_NAME).test(key)) {
      throw new Error(
        http
          ? `${where} : un nom d'en-tête ne contient ni espace ni accent.`
          : `${where} : le nom doit ressembler à GITHUB_TOKEN (lettres, chiffres, _).`,
      );
    }
    const same = seen.get(http ? key.toLowerCase() : key);
    if (same) throw new Error(`${where} : même nom qu'à la ligne ${same}.`);
    seen.set(http ? key.toLowerCase() : key, index + 1);
    return [{ name: key, value: line.slice(at + 1).trim() }];
  });
  if (http) {
    const url = target.trim();
    if (!validUrl(url)) throw new Error("Cette adresse n'est pas valide.");
    return { name, transport: { type: "http", url, headers: pairs } };
  }
  const [command, ...args] = splitCommandLine(target);
  if (!command) throw new Error("Indique la commande qui lance le serveur.");
  return { name, transport: { type: "stdio", command, args, env: pairs } };
}
