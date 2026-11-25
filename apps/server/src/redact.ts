// What gives access is masked before a line reaches a log file, the diagnostic report or a
// service manager's journal: the app's own tokens and tickets, credentials in headers and
// addresses, values given under a secret's name, and the keys of the services agents use.
// Agents and tools print them as they fail, so the forms are those they print.
//
// The desktop app keeps a copy of this file, word for word (`apps/desktop/src/redact.ts`),
// so that it needs nothing from the server inside its archive; a test holds them equal.
//
// Each expression may start only where a token starts (a look behind), and bounds what it
// reads: a line of 256 KiB made to look like the start of a secret again and again is read
// once, not once per character.

/** The words a name made of them gives a secret, as in `api_key`, `JWT_SECRET`, `apiKey`. */
const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "passphrase",
  "secret",
  "token",
  "ticket",
  "key",
  "apikey",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "signature",
]);

const isSecretName = (name: string): boolean =>
  name.split(/[_.-]+|(?<=[a-z0-9])(?=[A-Z])/).some((word) => SECRET_WORDS.has(word.toLowerCase()));

/** A name, quoted or not (JSON, escaped JSON, a JS object, an environment), and `=` or `:`. */
const NAMED = /(?<![\w.\\-])(\\?["']?)([A-Za-z_][\w.-]{0,63})\1([ \t]{0,4}[=:][ \t]{0,4})/g;
/** The value after it: quoted, escaped-quoted, or up to what ends a value in a line. */
const QUOTED = /\\"(?:[^"\\]|\\(?!"))*?\\"|"[^"\n]{0,4096}"|'[^'\n]{0,4096}'/y;
const BARE = /[^\s&,;"'<>(){}[\]]{1,4096}/y;
/** After `Authorization:`, a scheme comes before the secret itself. */
const SCHEME = /(?:bearer|basic|token|digest|negotiate)[ \t]+/iy;
/** A cookie header gives many secrets: everything to the end of the line, or of its string. */
const COOKIES = /[^\n"]{1,4096}/y;

function maskNamed(line: string): string {
  let out = "";
  let from = 0;
  NAMED.lastIndex = 0;
  for (let found = NAMED.exec(line); found; found = NAMED.exec(line)) {
    const name = found[2]!;
    const at = NAMED.lastIndex;
    if (!isSecretName(name)) continue;
    let end = at;
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "set-cookie") {
      COOKIES.lastIndex = at;
      if (COOKIES.test(line)) end = COOKIES.lastIndex;
    } else {
      SCHEME.lastIndex = at;
      if (lower.endsWith("authorization") && SCHEME.test(line)) end = SCHEME.lastIndex;
      for (const value of [QUOTED, BARE]) {
        value.lastIndex = end;
        const kept = value.exec(line);
        if (!kept) continue;
        const quote = kept[0].startsWith('\\"') ? '\\"' : /^["']/.test(kept[0]) ? kept[0][0]! : "";
        out += `${line.slice(from, end)}${quote}…${quote}`;
        from = value.lastIndex;
        NAMED.lastIndex = from;
        break;
      }
      continue;
    }
    if (end > at) {
      out += `${line.slice(from, at)}…`;
      from = end;
      NAMED.lastIndex = end;
    }
  }
  return out + line.slice(from);
}

export const redact = (line: string): string =>
  maskNamed(
    line
      // `scheme://user:password@host`: the password goes, the rest says where it failed. The
      // password may hold an `@`; a `?`, `#` or `/` ends the address's first part.
      .replace(/(?<![\w+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#@:]*):[^\s/?#]*@/gi, "$1:…@")
      // A JWT, whole, before its parts are read as a value.
      .replace(
        /(?<![\w-])eyJ[A-Za-z0-9_-]{5,4096}\.eyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{0,4096}/g,
        "eyJ…",
      )
      .replace(
        /(?<![\w-])(Bearer)[ \t]+(?:(?=\S{0,4096}[0-9._~+/=-])\S{6,4096}|[A-Za-z0-9._~+/=-]{16,4096})/gi,
        "$1 …",
      )
      .replace(
        /(?<![\w-])(Basic)[ \t]+(?=[A-Za-z0-9+/]{0,4096}[0-9+/=])[A-Za-z0-9+/]{8,4096}={0,2}/gi,
        "$1 …",
      )
      .replace(/(?<![\w-])(gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,4096}/g, "$1…")
      .replace(/(?<![\w-])(sk-(?:ant-|proj-|live-|test-)?)[A-Za-z0-9_-]{12,4096}/g, "$1…")
      .replace(/(?<![\w-])([sr]k_(?:live|test)_)[A-Za-z0-9]{8,4096}/g, "$1…")
      .replace(/(?<![A-Za-z0-9])(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, "$1…")
      .replace(/(?<![\w-])(xox[abprse]-)[A-Za-z0-9-]{10,4096}/g, "$1…")
      .replace(/(?<![\w-])AIza[0-9A-Za-z_-]{20,4096}/g, "AIza…")
      .replace(/(?<![\w-])(glpat-)[A-Za-z0-9_-]{10,4096}/g, "$1…")
      .replace(/(?<![\w-])(npm_)[A-Za-z0-9]{20,4096}/g, "$1…"),
  );
