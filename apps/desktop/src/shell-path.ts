import { execFileSync } from "node:child_process";

const MARK = "__MOONAGENTIC_PATH__";

/** The PATH a login shell printed between two marks, whatever its startup files printed too. */
export function pathFromShell(output: string): string | undefined {
  const start = output.indexOf(MARK);
  const end = output.lastIndexOf(MARK);
  if (start < 0 || end <= start) return undefined;
  return output.slice(start + MARK.length, end).trim() || undefined;
}

/** Both lists, the first one's folders first, each folder once. */
export function mergePaths(first: string, second: string, separator = ":"): string {
  const seen = new Set<string>();
  return [...first.split(separator), ...second.split(separator)]
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
    .join(separator);
}

/**
 * An app opened from the Finder gets a bare PATH, without the folders where Homebrew and npm
 * put `claude`, `agy`, `gh` or `git`: it takes the one the user's terminal has.
 */
export function adoptLoginShellPath(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin") return;
  try {
    const shell = env.SHELL || "/bin/zsh";
    const output = execFileSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const found = pathFromShell(output);
    if (found) env.PATH = mergePaths(found, env.PATH ?? "");
  } catch {
    // The PATH stays as it is: agents not found say so in MoonAgentic.
  }
}
