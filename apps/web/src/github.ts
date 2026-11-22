// How GitHub is described to the user: pure, so it is easy to test.
import type { GithubRepo, GithubStatus } from "@moonagentic/protocol";

/** What Connexions says about GitHub, and what to do next when it is not ready. */
export function githubStatusText(status: GithubStatus): {
  tone: "ok" | "warn" | "err" | "";
  label: string;
  detail: string;
} {
  if (!status.git) {
    return { tone: "err", label: "git introuvable", detail: "Installe git : https://git-scm.com" };
  }
  if (status.login) {
    return {
      tone: "ok",
      label: `Connecté : @${status.login}`,
      detail:
        status.gitAuth === "helper"
          ? "git pousse avec ses propres identifiants, gh ouvre les pull requests."
          : "git pousse et gh ouvre les pull requests avec ce compte.",
    };
  }
  if (status.gitAuth === "helper") {
    return {
      tone: "warn",
      label: status.gh ? "gh pas connecté" : "Sans GitHub CLI",
      detail: status.gh
        ? "git peut pousser. Pour ouvrir les pull requests et lister tes dépôts : gh auth login."
        : "git peut pousser. Pour ouvrir les pull requests et lister tes dépôts, installe GitHub CLI (https://cli.github.com) puis gh auth login.",
    };
  }
  return {
    tone: "warn",
    label: "Connexion requise",
    detail: status.gh
      ? "Lance gh auth login dans un terminal sur cette machine, puis Vérifier."
      : "Installe GitHub CLI (https://cli.github.com), lance gh auth login, puis Vérifier.",
  };
}

/** The repositories matching what is typed, all of them when it is empty or an address. */
export function filterRepos(repos: GithubRepo[], query: string): GithubRepo[] {
  const q = query.trim().toLowerCase();
  if (!q || q.includes("github.com") || q.startsWith("git@")) return repos;
  return repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q),
  );
}

/** The folder name a repository clones into: the last part of `owner/name` or its address. */
export function repoFolderName(input: string): string {
  const last = input
    .trim()
    .replace(/[#?].*$/, "")
    .replace(/\/(tree|blob|pulls?|issues|commits?)(\/.*)?$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop();
  return last && /^[A-Za-z0-9._-]+$/.test(last) && !/^\.\.?$/.test(last) ? last : "";
}

/** The folder holding a project's folder, written with the project's own separators. */
export function parentFolder(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut <= 0) return "";
  const parent = trimmed.slice(0, cut);
  // `C:` alone means the drive's current folder, not its root.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}
