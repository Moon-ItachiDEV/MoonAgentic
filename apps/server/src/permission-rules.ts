import type * as acp from "@agentclientprotocol/sdk";

/**
 * What passes without asking in « Demande d'abord », and what « Autoriser pour ce fil »
 * remembers. Reading a project never changes it: a review that reads thirty files must not
 * ask thirty times. A command passes only when every part of it is known to only read.
 */

/** The option MoonAgentic adds to a request: allow this call and every similar one in the thread. */
export const THREAD_GRANT_OPTION = "moon:thread";

/** Kinds of tool call that only read. */
const READ_KINDS = new Set(["read", "search", "think"]);

/** Programs that only read, whatever their arguments (those that can write are below). */
const READ_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "pwd",
  "echo",
  "printf",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "tree",
  "jq",
  "diff",
  "basename",
  "dirname",
  "realpath",
  "true",
  // PowerShell, as Windows agents write it.
  "get-content",
  "gc",
  "type",
  "dir",
  "get-childitem",
  "gci",
  "get-item",
  "get-location",
  "get-date",
  "select-string",
  "select-object",
  "measure-object",
  "sort-object",
  "format-list",
  "format-table",
  "write-output",
  "write-host",
  "out-string",
  "findstr",
]);

/** Git subcommands that only read. */
const GIT_READ = new Set([
  "show",
  "log",
  "diff",
  "status",
  "blame",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "grep",
  "describe",
  "shortlog",
  "cat-file",
  "merge-base",
  "rev-list",
  "remote",
  "branch",
  "tag",
]);

/** Shell features that can write, run something else, or hide what runs. */
const UNSAFE = /[>`]|\$\(|<\(|\n|\r|(^|[^&])&([^&]|$)/;

/** Redirects that only silence or merge output. */
const QUIET = /\s+2>&1|\s+2?>\s*\/dev\/null|\s+2?>\s*\$null|\s+2?>\s*NUL\b/gi;

/** The command a tool call runs, as the agent sent it. */
export function commandOf(call: acp.ToolCallUpdate | acp.ToolCall): string | undefined {
  const raw = (call.rawInput ?? undefined) as { command?: unknown; cmd?: unknown } | undefined;
  const command = raw?.command ?? raw?.cmd;
  if (typeof command === "string") return unwrap(command);
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    const parts = command as string[];
    // ["bash", "-lc", "git diff"]: the shell's script is the command.
    const shell = parts.findIndex((p) => /^-(l?c|Command)$/i.test(p));
    if (shell >= 0 && parts[shell + 1] !== undefined)
      return unwrap(parts.slice(shell + 1).join(" "));
    return unwrap(parts.join(" "));
  }
  return call.title ? unwrap(call.title) : undefined;
}

/** `bash -lc 'git diff'` or `powershell -Command "Get-Content x"` → the script inside. */
function unwrap(command: string): string {
  const m =
    /^\s*(?:\S*[\\/])?(?:ba|z)?sh(?:\.exe)?\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command) ??
    /^\s*(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?-Command\s+(['"])([\s\S]*)\1\s*$/i.exec(
      command,
    );
  return (m ? m[2]! : command).trim();
}

/** Splits on `&&`, `||`, `;` and `|`, outside quotes. */
function parts(command: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      if (command[i + 1] === c) i++;
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (quote) return undefined;
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Words of one command, quotes removed. */
function words(part: string): string[] {
  return [...part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/** The program a command starts with, bare and lowercased (`/usr/bin/git` → `git`). */
function program(word: string | undefined): string {
  return (word ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/** True when every part of the command only reads. */
export function readOnlyCommand(command: string | undefined): boolean {
  if (!command?.trim()) return false;
  // Only the quoted text may hold these characters: a pattern to search, never a redirect.
  command = command.replace(QUIET, "");
  const bare = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  if (UNSAFE.test(bare) || /\$\(|`/.test(command)) return false;
  const list = parts(command);
  if (!list?.length) return false;
  return list.every((part) => {
    const w = words(part).filter((x, i) => i > 0 || !/^\w+=/.test(x));
    const prog = program(w[0]);
    const args = w.slice(1);
    if (prog === "cd") return true;
    if (prog === "git") return readOnlyGit(args);
    if (prog === "sed") {
      // Only `sed -n '1,80p' file`: printing lines, never writing them.
      const script = args.find((a) => !a.startsWith("-"));
      return args.includes("-n") && !!script && /^(\s*(\d+|\$)(,(\d+|\$))?p\s*;?)+$/.test(script);
    }
    if (prog === "find")
      return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(a));
    if (prog === "gh") {
      const [noun, verb] = args;
      return (
        (noun === "pr" || noun === "issue" || noun === "run" || noun === "repo") &&
        ["view", "diff", "list", "checks", "status"].includes(verb ?? "")
      );
    }
    if (prog === "sort") return !args.some((a) => /^-o|^--output/.test(a));
    if (prog === "tree") return !args.some((a) => a === "-o");
    return READ_PROGRAMS.has(prog);
  });
}

function readOnlyGit(args: string[]): boolean {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") i++;
    else if (a === "-c" || a.startsWith("--exec-path") || a.startsWith("--git-dir")) return false;
    else if (a === "--no-pager" || a === "-P") continue;
    else rest.push(a);
  }
  const sub = rest[0];
  if (!sub || !GIT_READ.has(sub)) return false;
  const opts = rest.slice(1);
  if (opts.some((a) => a.startsWith("--output") || a === "--ext-diff")) return false;
  if (sub === "branch" || sub === "tag" || sub === "remote") {
    const LIST =
      /^(-a|-r|-v|-vv|-l|--list|--all|--show-current|--merged|--no-merged|--contains|--sort=\S+|--format=\S+)$/;
    return opts.every(
      (a) => LIST.test(a) || (sub !== "remote" && opts.some((o) => o === "-l" || o === "--list")),
    );
  }
  return true;
}

/** True when a call only reads: it passes in « Demande d'abord » without asking. */
export function readOnlyCall(call: acp.ToolCallUpdate | acp.ToolCall): boolean {
  if (READ_KINDS.has(call.kind ?? "")) return true;
  return call.kind === "execute" && readOnlyCommand(commandOf(call));
}

/**
 * What « Autoriser pour ce fil » remembers for a call: its kind, and for a command the program
 * it runs (`execute:npm`), so `npm test` then `npm run lint` pass but not `rm`.
 */
export function grantKey(call: acp.ToolCallUpdate | acp.ToolCall, toolName?: string): string {
  const kind = call.kind ?? "other";
  if (kind === "execute") {
    const first = parts(commandOf(call) ?? "")?.[0];
    const w = words(first ?? "");
    const prog = program(w[0]);
    if (!prog) return "execute:?";
    if (prog === "git" || prog === "npm" || prog === "pnpm" || prog === "yarn" || prog === "gh") {
      const sub = w.slice(1).find((a) => !a.startsWith("-"));
      return `execute:${prog}${sub ? ` ${sub}` : ""}`;
    }
    return `execute:${prog}`;
  }
  if (kind === "other") return `other:${toolName ?? call.title ?? "?"}`;
  return kind;
}
