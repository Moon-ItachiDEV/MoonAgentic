import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * What passes without asking in « Demande d'abord » and « Éditions auto », and what
 * « Autoriser pour ce fil » remembers. Reading a project never changes it: a review that reads
 * thirty files must not ask thirty times. A command passes only when every part of it is known
 * to only read, and in « Éditions auto » a file edit passes only when every target path stays
 * inside the thread's folder.
 */

/** The option MoonAgentic adds to a request: allow this call and every similar one in the thread. */
export const THREAD_GRANT_OPTION = "moon:thread";

/** Kinds of tool call that only read. */
const READ_KINDS = new Set(["read", "search", "think"]);

/** Programs that only read, whatever their arguments (those with write/exec flags are below). */
const READ_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "pwd",
  "echo",
  "printf",
  "cut",
  "tr",
  "nl",
  "stat",
  "du",
  "df",
  "which",
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

/** Shell wrappers or privilege/exec launchers that are never blanket-granted « pour ce fil ». */
const UNGRANTABLE_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "xargs",
  "eval",
  "exec",
  "sudo",
  "su",
  "doas",
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

/** Safe git global flags accepted before the subcommand. */
const GIT_SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"]);

/** Redirects that only silence or merge stderr/null output, at a token boundary. */
const QUIET_REDIRECT =
  /^(?:2>&1|2?>\s*\/dev\/null|2?>\s*(?:\$[nN][uU][lL]|[nN][uU][lL]))(?=$|[\s;|&])/;

/** Characters or expansions that can run arbitrary code or hide commands even inside quotes. */
const ALWAYS_UNSAFE = /[\n\r\0`]|[$][({]/;

/** Flags of a shell that change nothing of what its script does. */
const SHELL_PLAIN_FLAG = /^-(l|NoProfile|NoLogo|NonInteractive)$/i;

/** Folders whose programs are the system's own, not files of the project. */
const SYSTEM_PROGRAM = /^\/(?:usr\/(?:local\/)?)?s?bin\/[^\\/]+$/;

/**
 * True when `arg` is the long option or a shorter spelling of it: GNU programs and git take
 * `--out=x` for `--output=x`.
 */
const spells = (arg: string, option: string): boolean => {
  const name = arg.split("=")[0]!;
  return name.length > 2 && option.startsWith(name);
};

/** The command a tool call runs, as the agent sent it. */
export function commandOf(call: acp.ToolCallUpdate | acp.ToolCall): string | undefined {
  const raw = (call.rawInput ?? undefined) as
    { command?: unknown; cmd?: unknown; args?: unknown } | undefined;
  const command = raw?.command ?? raw?.cmd;
  if (typeof command === "string") {
    if (raw?.args === undefined) return unwrap(command);
    // { command: "find", args: [".", "-delete"] }: the arguments count as much as the program.
    if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) return undefined;
    return unwrap([command, ...(raw.args as string[])].join(" "));
  }
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    const parts = command as string[];
    // ["bash", "-lc", "git diff"]: the shell's script is the command (only when it is the sole arg).
    const first = program(parts[0]);
    if (
      first === "bash" ||
      first === "sh" ||
      first === "zsh" ||
      first === "powershell" ||
      first === "pwsh"
    ) {
      const shell = parts.findIndex((p) => /^-(l?c|Command)$/i.test(p));
      // Any other flag before it (`--rcfile x -i`, `-File x.ps1`) runs more than the script.
      const plain = parts.slice(1, shell).every((p) => SHELL_PLAIN_FLAG.test(p));
      if (shell >= 0 && plain && parts.length === shell + 2) return parts[shell + 1]!.trim();
    }
    return unwrap(parts.join(" "));
  }
  // A command sent in a shape not known here (`{ argv: [...] }`, a number, arguments without
  // their program) is not one: its title, which may read « git log », says nothing of it.
  if (command !== undefined || raw?.args !== undefined) return undefined;
  return call.title ? unwrap(call.title) : undefined;
}

/**
 * `bash -lc 'git diff'` or `powershell -Command "Get-Content x"` → the script inside.
 * Never matches across an embedded quote of the same kind, so trailing chained commands
 * (`bash -lc 'git status' && rm -rf / && echo 'x'`) cannot be unwrapped into a single string.
 */
function unwrap(command: string): string {
  const m =
    /^\s*(?:\S*[\\/])?(?:ba|z)?sh(?:\.exe)?\s+-l?c\s+(?:'([^']*)'|"([^"\\]*)")\s*$/.exec(command) ??
    /^\s*(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?-Command\s+(?:'([^']*)'|"([^"\\]*)")\s*$/i.exec(
      command,
    );
  return (m ? (m[1] ?? m[2]!) : command).trim();
}

/**
 * Single-pass shell tokenizer and splitter on `&&`, `||`, `;` and `|`.
 * Rejects unclosed quotes, ambiguous `\"` escapes inside double quotes, unsafe shell
 * metacharacters outside quotes (`>`, `<`, `(`, `)`, single `&`, `|&`), and expansions
 * (`$(`, `${`, backticks, newlines) anywhere in the command.
 */
function tokenize(command: string): string[][] | undefined {
  if (!command.trim() || ALWAYS_UNSAFE.test(command)) return undefined;
  const segments: string[][] = [];
  let seg: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let needSegment = false;

  const finishWord = () => {
    if (!inWord) return;
    seg.push(cur);
    cur = "";
    inWord = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      // `\"` closes a double-quoted string in PowerShell while escaping `"` in bash: reject.
      if (quote === '"' && c === "\\" && command[i + 1] === '"') return undefined;
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }

    // Safe quiet redirects (`2>&1`, `2>/dev/null`, `2>$null`, `2>NUL`) at a token boundary.
    if (!inWord && (c === "2" || c === ">")) {
      const quiet = QUIET_REDIRECT.exec(command.slice(i));
      if (quiet) {
        i += quiet[0].length - 1;
        continue;
      }
    }

    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }

    if (c === ">" || c === "<" || c === "(" || c === ")") return undefined;
    // PowerShell runs a block given to a command that reads (`Sort-Object { Remove-Item x }`).
    if (c === "{" || c === "}") return undefined;
    // `\'` is a plain quote in bash, so what follows is not quoted as it looks here. Only a
    // path's backslash (`src\app.ts`) passes.
    if (c === "\\" && !/[\w.-]/.test(command[i + 1] ?? "")) return undefined;

    if (c === "&") {
      if (command[i + 1] !== "&" || command[i + 2] === "&") return undefined;
      finishWord();
      if (!seg.length) return undefined;
      segments.push(seg);
      seg = [];
      needSegment = true;
      i++;
      continue;
    }

    if (c === "|") {
      if (command[i + 1] === "&") return undefined;
      if (command[i + 1] === "|") i++;
      finishWord();
      if (!seg.length) return undefined;
      segments.push(seg);
      seg = [];
      needSegment = true;
      continue;
    }

    if (c === ";") {
      finishWord();
      if (seg.length) {
        segments.push(seg);
        seg = [];
      }
      needSegment = false;
      continue;
    }

    if (/\s/.test(c)) {
      finishWord();
      continue;
    }

    cur += c;
    inWord = true;
  }

  if (quote) return undefined;
  finishWord();
  if (needSegment && !seg.length) return undefined;
  if (seg.length) segments.push(seg);
  return segments.length ? segments : undefined;
}

/** The program a command starts with, bare and lowercased (`/usr/bin/git` → `git`). */
function program(word: string | undefined): string {
  return (word ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/** True when one tokenized command segment only reads. */
function readOnlySegment(w: string[]): boolean {
  const head = w[0];
  // Never strip leading `VAR=val` assignments (`GIT_PAGER=sh`, `LD_PRELOAD=...`).
  if (!head || head.includes("=")) return false;
  // Given by its path, a program is whatever file is there (`./cat`, `scripts/diff`).
  if (/[\\/]/.test(head) && !SYSTEM_PROGRAM.test(head)) return false;
  const prog = program(head);
  const args = w.slice(1);
  if (prog === "cd") return true;
  if (prog === "git") return readOnlyGit(args);
  if (prog === "sed") {
    // Only `sed -n '1,80p' file...`: no `-i`, `-e`, `-f` or other flags (even after positional
    // args, since GNU sed permutes flags), printing lines only.
    let seenN = false;
    let endOfFlags = false;
    let script: string | undefined;
    for (const a of args) {
      if (!endOfFlags && a === "--") {
        endOfFlags = true;
      } else if (!endOfFlags && a === "-n") {
        seenN = true;
      } else if (!endOfFlags && a.startsWith("-")) {
        return false;
      } else if (script === undefined) {
        script = a;
      }
    }
    return seenN && !!script && /^(\s*(\d+|\$)(,(\d+|\$))?p\s*;?)+$/.test(script);
  }
  if (prog === "find") {
    return !args.some((a) =>
      /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)/i.test(a),
    );
  }
  if (prog === "rg") {
    return !args.some(
      (a) =>
        a === "--pre" ||
        a.startsWith("--pre=") ||
        a === "--pre-glob" ||
        a.startsWith("--pre-glob=") ||
        a === "--hostname-bin" ||
        a.startsWith("--hostname-bin="),
    );
  }
  if (prog === "gh") {
    const [noun, verb] = args;
    return (
      (noun === "pr" || noun === "issue" || noun === "run" || noun === "repo") &&
      ["view", "diff", "list", "checks", "status"].includes(verb ?? "")
    );
  }
  if (prog === "sort") {
    return !args.some(
      (a) => /^-[^-]*o/.test(a) || spells(a, "--output") || spells(a, "--compress-program"),
    );
  }
  if (prog === "tree") return !args.some((a) => /^-[^-]*o/.test(a));
  if (prog === "uniq") {
    // `uniq in out` overwrites `out`: allow at most one positional file argument.
    let positional = 0;
    let endOfFlags = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!endOfFlags && a === "--") {
        endOfFlags = true;
      } else if (!endOfFlags && (a === "-f" || a === "-s" || a === "-w")) {
        i++;
      } else if (!endOfFlags && a.startsWith("-") && a.length > 1) {
        continue;
      } else {
        positional++;
      }
    }
    return positional <= 1;
  }
  if (prog === "file") {
    return !args.some((a) => /^-[^-]*C/.test(a) || spells(a, "--compile"));
  }
  return READ_PROGRAMS.has(prog);
}

/** True when every part of the command only reads. */
export function readOnlyCommand(command: string | undefined): boolean {
  if (!command) return false;
  const list = tokenize(command);
  if (!list?.length) return false;
  return list.every(readOnlySegment);
}

/** Extracts git's subcommand and its arguments after safe global flags, or undefined if unsafe. */
function gitSubcommand(args: string[]): { sub: string; opts: string[] } | undefined {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "-C") {
      if (i + 1 >= args.length) return undefined;
      i += 2;
    } else if (GIT_SAFE_GLOBAL.has(a)) {
      i += 1;
    } else if (a.startsWith("-")) {
      // Any other global flag (`-c`, `--exec-path`, `--git-dir`, `--work-tree`, `--config-env`…)
      return undefined;
    } else {
      return { sub: a, opts: args.slice(i + 1) };
    }
  }
  return undefined;
}

const BRANCH_LIST_FLAG =
  /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort=\S+|--format=\S+|--abbrev=\d+|--color(?:=\S+)?|--no-color)$/;
const TAG_LIST_FLAG =
  /^(-l|--list|-n\d*|--merged|--no-merged|--contains|--no-contains|--points-at|--sort=\S+|--format=\S+|--color(?:=\S+)?|--no-color)$/;
const TAKES_COMMIT_ARG = new Set([
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
]);

function readOnlyGitList(opts: string[], allowedFlag: RegExp): boolean {
  const hasListFlag = opts.some((a) => a === "-l" || a === "--list");
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]!;
    if (a.startsWith("-")) {
      if (!allowedFlag.test(a)) return false;
      if (TAKES_COMMIT_ARG.has(a) && opts[i + 1] && !opts[i + 1]!.startsWith("-")) i++;
    } else if (!hasListFlag) {
      // Without `-l`/`--list`, a positional argument creates a branch or tag.
      return false;
    }
  }
  return true;
}

function readOnlyGit(args: string[]): boolean {
  const parsed = gitSubcommand(args);
  if (!parsed || !GIT_READ.has(parsed.sub)) return false;
  const { sub, opts } = parsed;
  if (
    opts.some(
      (a) =>
        a === "--output" || a.startsWith("--output=") || a === "--ext-diff" || a === "--textconv",
    )
  ) {
    return false;
  }
  if (
    sub === "grep" &&
    opts.some((a) => /^-[^-]*O/.test(a) || spells(a, "--open-files-in-pager"))
  ) {
    return false;
  }
  if (sub === "remote") {
    if (opts.length === 0) return true;
    if (opts.every((a) => a === "-v" || a === "--verbose")) return true;
    if (opts[0] === "show") return opts.slice(1).every((a) => a === "-n" || !a.startsWith("-"));
    if (opts[0] === "get-url")
      return opts.slice(1).every((a) => a === "--all" || a === "--push" || !a.startsWith("-"));
    return false;
  }
  if (sub === "branch") return readOnlyGitList(opts, BRANCH_LIST_FLAG);
  if (sub === "tag") return readOnlyGitList(opts, TAG_LIST_FLAG);
  return true;
}

/** True when a call only reads: it passes in « Demande d'abord » without asking. */
export function readOnlyCall(call: acp.ToolCallUpdate | acp.ToolCall): boolean {
  if (READ_KINDS.has(call.kind ?? "")) return true;
  return call.kind === "execute" && readOnlyCommand(commandOf(call));
}

const EDIT_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_file",
  "targetFile",
  "notebook_path",
  "notebookPath",
  "filename",
  "file",
  "old_path",
  "new_path",
  "oldPath",
  "newPath",
  "source",
  "destination",
  "target",
  "dest",
  "uri",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodePathValue(key: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (key === "uri") {
    if (!trimmed.startsWith("file://")) return undefined;
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

/** Collects every target path named by an edit tool call; undefined if any path field is malformed. */
function editPathsOf(call: acp.ToolCallUpdate | acp.ToolCall): string[] | undefined {
  const paths: string[] = [];
  if (call.locations !== undefined && call.locations !== null) {
    if (!Array.isArray(call.locations)) return undefined;
    for (const loc of call.locations) {
      if (!isRecord(loc) || typeof loc.path !== "string" || !loc.path.trim()) return undefined;
      paths.push(loc.path.trim());
    }
  }
  if (Array.isArray(call.content)) {
    for (const entry of call.content) {
      if (!isRecord(entry) || entry.type !== "diff") continue;
      if (typeof entry.path !== "string" || !entry.path.trim()) return undefined;
      paths.push(entry.path.trim());
    }
  }
  if (isRecord(call.rawInput)) {
    const raw = call.rawInput;
    for (const key of EDIT_PATH_KEYS) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      const decoded = decodePathValue(key, value);
      if (!decoded) return undefined;
      paths.push(decoded);
    }
    for (const listKey of ["paths", "files"] as const) {
      const list = raw[listKey];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) return undefined;
      for (const item of list) {
        if (typeof item === "string") {
          if (!item.trim()) return undefined;
          paths.push(item.trim());
        } else if (isRecord(item)) {
          const found = EDIT_PATH_KEYS.filter((k) => item[k] !== undefined && item[k] !== null);
          if (!found.length) return undefined;
          for (const k of found) {
            const decoded = decodePathValue(k, item[k]);
            if (!decoded) return undefined;
            paths.push(decoded);
          }
        } else {
          return undefined;
        }
      }
    }
    if (Array.isArray(raw.edits)) {
      for (const edit of raw.edits) {
        if (!isRecord(edit)) continue;
        for (const key of EDIT_PATH_KEYS) {
          const value = edit[key];
          if (value === undefined || value === null) continue;
          const decoded = decodePathValue(key, value);
          if (!decoded) return undefined;
          paths.push(decoded);
        }
      }
    }
    if (isRecord(raw.changes)) {
      for (const key of Object.keys(raw.changes)) {
        if (!key.trim()) return undefined;
        paths.push(key.trim());
      }
    }
  }
  return paths;
}

/** Resolves symlinks up to the nearest existing ancestor so new files under symlinked dirs are caught. */
function resolveWithMissing(target: string): string | undefined {
  const tail: string[] = [];
  let cur = path.resolve(target);
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = path.dirname(cur);
      if (parent === cur) return undefined;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function pathInsideFolder(root: string, folder: string, rawPath: string): boolean {
  if (!rawPath || rawPath.includes("\0")) return false;
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(folder, rawPath);
  const resolved = resolveWithMissing(candidate);
  if (!resolved) return false;
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return false;
  }
  // Never auto-edit `.git` metadata or hooks inside the workspace.
  return !rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");
}

/**
 * True when a call is strictly a file edit (`kind === "edit"`) whose every named target stays
 * inside `folder` (symlinks resolved, `.git` excluded). Fail-closed: if no path is named, or
 * any path escapes `folder`, returns false so the user is asked.
 */
export function editInsideFolder(
  call: acp.ToolCallUpdate | acp.ToolCall,
  folder: string | undefined,
): boolean {
  if (call.kind !== "edit" || !folder) return false;
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return false;
  }
  const paths = editPathsOf(call);
  if (!paths?.length) return false;
  return paths.every((p) => pathInsideFolder(root, folder, p));
}

/** Key for a single non-read-only command segment, or undefined if it must not be blanket-granted. */
function segmentGrantKey(w: string[]): string | undefined {
  const head = w[0];
  if (!head || head.includes("=")) return undefined;
  const prog = program(head);
  if (!prog || UNGRANTABLE_PROGRAMS.has(prog)) return undefined;
  const args = w.slice(1);
  if (prog === "git") {
    const parsed = gitSubcommand(args);
    return parsed ? `execute:git ${parsed.sub}` : undefined;
  }
  if (prog === "npm" || prog === "pnpm" || prog === "yarn" || prog === "gh") {
    // Skip flags (and flags taking a value like `-C dir` / `--filter pkg`) to find the subcommand.
    let sub: string | undefined;
    let subIndex = -1;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-C" || a === "--dir" || a === "--prefix" || a === "-F" || a === "--filter") {
        i++;
      } else if (a.startsWith("-")) {
        continue;
      } else {
        sub = a;
        subIndex = i;
        break;
      }
    }
    if (!sub) return `execute:${prog}`;
    if (
      (prog === "npm" || prog === "pnpm" || prog === "yarn") &&
      (sub === "run" || sub === "exec")
    ) {
      const script = args.slice(subIndex + 1).find((a) => !a.startsWith("-"));
      return script ? `execute:${prog} ${sub} ${script}` : undefined;
    }
    return `execute:${prog} ${sub}`;
  }
  return `execute:${prog}`;
}

/**
 * Every grant key a call requires to pass under « Autoriser pour ce fil », or undefined when
 * the call contains unsafe shell constructs (redirections, substitutions, env overrides, raw
 * shell wrappers) and must always be confirmed once at a time.
 * Read-only segments (`cd`, `head`, `git status`…) need no grant of their own, while every
 * remaining segment in a chained command must be covered (`npm test && rm -rf /` requires
 * both `execute:npm test` and `execute:rm`).
 */
export function grantKeys(
  call: acp.ToolCallUpdate | acp.ToolCall,
  toolName?: string,
): string[] | undefined {
  const kind = call.kind ?? "other";
  if (kind === "execute") {
    const list = tokenize(commandOf(call) ?? "");
    if (!list?.length) return undefined;
    const keys: string[] = [];
    for (const seg of list) {
      if (readOnlySegment(seg)) continue;
      const key = segmentGrantKey(seg);
      if (!key) return undefined;
      if (!keys.includes(key)) keys.push(key);
    }
    return keys.length ? keys : undefined;
  }
  if (kind === "other") return [`other:${toolName ?? call.title ?? "?"}`];
  return [kind];
}

/**
 * Single grant key for a simple call, or undefined for compound/unsafe commands.
 * Kept for convenience alongside `grantKeys`.
 */
export function grantKey(
  call: acp.ToolCallUpdate | acp.ToolCall,
  toolName?: string,
): string | undefined {
  const keys = grantKeys(call, toolName);
  return keys?.length === 1 ? keys[0] : undefined;
}
