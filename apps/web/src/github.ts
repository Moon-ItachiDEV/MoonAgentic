// How GitHub is described to the user: pure, so it is easy to test.
import type { GithubRepo, GithubStatus, GithubVault, LocalClone } from "@moonagentic/protocol";

/** Where MoonAgentic keeps its own sign-in, in the user's words. */
export function vaultText(vault: GithubVault | undefined): string {
  switch (vault) {
    case "windows":
      return "La connexion est chiffrée avec ton compte Windows, sur cette machine seulement.";
    case "macos":
      return "La connexion est gardée dans le trousseau macOS de cette machine.";
    case "linux":
      return "La connexion est gardée dans le trousseau du système de cette machine.";
    case "file":
      return "La connexion est gardée dans un fichier que seul ton compte peut lire, sur cette machine.";
    default:
      return "";
  }
}

/** What Connexions says about GitHub, and what to do next when it is not ready. */
export function githubStatusText(status: GithubStatus): {
  tone: "ok" | "warn" | "err" | "";
  label: string;
  detail: string;
} {
  if (!status.git) {
    return { tone: "err", label: "git introuvable", detail: "Installe git : https://git-scm.com" };
  }
  if (status.login && status.account === "moonagentic") {
    return {
      tone: "ok",
      label: `Connecté : @${status.login}`,
      detail:
        `MoonAgentic clone, pousse et ouvre les pull requests avec ce compte. ${vaultText(status.vault)}`.trim(),
    };
  }
  if (status.login) {
    return {
      tone: "ok",
      label: `Connecté avec gh : @${status.login}`,
      detail: "git pousse et gh ouvre les pull requests avec ce compte.",
    };
  }
  if (status.canSignIn) {
    return {
      tone: "warn",
      label: "Pas connecté",
      detail:
        "Connecte-toi à GitHub pour choisir tes dépôts dans une liste et pousser tes branches.",
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

/**
 * What is already on the machine for a repository: the project using it first, or else a
 * clone of it, so it is never cloned a second time.
 */
export function localFor(fullName: string, clones: LocalClone[]): LocalClone | undefined {
  const name = fullName.toLowerCase();
  const same = clones.filter((c) => c.repo?.toLowerCase() === name);
  return same.find((c) => c.projectId) ?? same[0];
}

/** The repository typed or picked, as `owner/name`, when it is one. */
export function repoFullName(input: string): string | undefined {
  if (githubOwner(input)) return undefined;
  const match = GITHUB_REPO.exec(input.trim());
  if (!match || match[2] === "." || match[2] === "..") return undefined;
  return `${match[1]}/${match[2]}`;
}

/** `parent` and `name` joined with the separator `parent` already uses. */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return parent.replace(/[\\/]+$/, "") + sep + name;
}

/**
 * The account when what is typed is a GitHub profile address, such as
 * `https://github.com/moon`: an account, not a repository, so nothing can be cloned from it.
 */
export function githubOwner(input: string): string | undefined {
  const match =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/?(?:[?#].*)?$/i.exec(
      input.trim(),
    );
  return match?.[1];
}

/**
 * The repositories matching what is typed: all of them when it is empty or a repository address,
 * the account's own when it is a profile address.
 */
export function filterRepos(repos: GithubRepo[], query: string): GithubRepo[] {
  const owner = githubOwner(query)?.toLowerCase();
  if (owner) return repos.filter((r) => r.fullName.toLowerCase().startsWith(`${owner}/`));
  const q = query.trim().toLowerCase();
  if (!q || q.includes("github.com") || q.startsWith("git@")) return repos;
  return repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q),
  );
}

/** The folder name a repository clones into: the last part of `owner/name` or its address. */
export function repoFolderName(input: string): string {
  if (githubOwner(input)) return "";
  const last = input
    .trim()
    .replace(/[#?].*$/, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+\/[^/]+).*$/i, "$1")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop();
  return last && /^[A-Za-z0-9._-]+$/.test(last) && !/^\.\.?$/.test(last) ? last : "";
}

/** Same GitHub repository forms accepted by the server: `owner/name` or a github.com URL. */
const GITHUB_REPO =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[#?].*|\/(?:tree|blob|pulls?|issues|commits?|compare|actions|releases|wiki|branches|tags|settings|security|discussions|projects|raw|blame)(?:[/?#].*)?)?$/i;

/**
 * Whether a repository can be cloned from what is typed: a valid GitHub repository (never a
 * profile address, single word or other host, whatever the name), a parent folder, and a safe
 * folder name, typed or taken from the repository.
 */
export function canClone(repo: string, parent: string, name: string): boolean {
  if (!parent.trim() || !repoFolderName(repo)) return false;
  const match = GITHUB_REPO.exec(repo.trim());
  if (!match || match[2] === "." || match[2] === "..") return false;
  const folder = name.trim();
  if (folder && (/[\\/]/.test(folder) || folder === "." || folder === "..")) return false;
  return true;
}
