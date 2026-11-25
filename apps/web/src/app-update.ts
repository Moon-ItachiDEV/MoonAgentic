// MoonAgentic's own updates as the interface shows them: a pill at the foot of the side bar
// and on the home page, a card beside the side bar (a sheet on a phone), and the steps of an
// install on every screen. What the server says, nothing guessed.
import type { AppInfo, AppUpdate, Notice } from "@moonagentic/protocol";

/** True when there is something to say about a newer version: a pill shows it. */
export function updateShown(app: AppInfo | null | undefined): app is AppInfo {
  if (!app || app.kind === "other") return false;
  const u = app.update;
  if (u.install || u.phase) return true;
  if (u.state === "ready" || u.state === "available" || u.state === "downloading") return true;
  // A version found that could not be downloaded: the card says why and offers to retry.
  return u.state === "failed" && !!u.version;
}

/**
 * Why the last look found nothing, when it failed before any version was known: the pill
 * does not show then, the settings still say it.
 */
export function lookFailure(app: AppInfo | null | undefined): string | undefined {
  if (!app || app.kind === "other") return undefined;
  const u = app.update;
  if (u.state !== "failed" || u.version) return undefined;
  return `Vérification impossible : ${u.error ?? "raison inconnue."}`;
}

/** The pill's words: what it is, and where it stands. */
export function pillOf(app: AppInfo): {
  text: string;
  tail?: string;
  tone: "ready" | "wait" | "run" | "fail";
} {
  const u = app.update;
  const name = app.kind === "git" ? "Nouvelle version" : `Mise à jour ${u.version ?? ""}`.trim();
  if (u.phase) return { text: `Installation de ${u.version ?? "la mise à jour"}…`, tone: "run" };
  if (u.install) {
    const n = u.working ?? 0;
    return {
      text: name,
      tail: n ? `Attend ${n} fil${n > 1 ? "s" : ""}` : "Va s'installer",
      tone: "wait",
    };
  }
  if (u.state === "downloading") {
    return { text: name, tail: `${Math.round((u.progress ?? 0) * 100)} %`, tone: "run" };
  }
  if (u.state === "failed") return { text: name, tail: "Échec", tone: "fail" };
  if (app.kind === "git")
    return {
      text: name,
      tail: `${u.behind ?? 0} commit${(u.behind ?? 0) > 1 ? "s" : ""}`,
      tone: "ready",
    };
  return { text: name, tail: app.kind === "mac" ? "Sortie" : "Prête", tone: "ready" };
}

/** A size in the units the user reads: « 84 Mo ». */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} Go`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

/** « 2 fils au travail », never naming one: a locked project's stays unsaid. */
export const workingLine = (n: number) => `${n} fil${n > 1 ? "s" : ""} au travail`;

export type StepState = "done" | "now" | "next";

/**
 * The steps of an install, each with where it stands. `connected`: the screen still hears the
 * server; once it does not, the app is being replaced and started again.
 */
export function installSteps(
  u: AppUpdate,
  connected: boolean,
): { key: string; label: string; state: StepState }[] {
  const waiting = !u.phase;
  const replacing = u.phase === "installing";
  return [
    {
      key: "threads",
      label: waiting && (u.working ?? 0) > 0 ? workingLine(u.working!) : "Fils au travail terminés",
      state: waiting ? ((u.working ?? 0) > 0 ? "now" : "done") : "done",
    },
    {
      key: "backup",
      label: "Base sauvegardée",
      state: u.phase === "backup" ? "now" : replacing ? "done" : "next",
    },
    {
      key: "install",
      label: "Installation",
      state: replacing ? (connected ? "now" : "done") : "next",
    },
    {
      key: "restart",
      label: "Redémarrage et reconnexion",
      state: replacing && !connected ? "now" : "next",
    },
  ];
}

/**
 * The notice owed for a newer version ready, unless this device already told of that one
 * (`told`): once per version and device, whatever the looks in between.
 */
export function updateNotice(
  app: AppInfo | null | undefined,
  told: string | null,
): Notice | undefined {
  if (!app?.notify || app.kind === "other" || !app.update.version) return undefined;
  const { state, version } = app.update;
  const ready =
    app.kind === "windows" ? state === "ready" : state === "ready" || state === "available";
  if (!ready || version === told) return undefined;
  return {
    tag: "app-update",
    threadId: "",
    title: app.kind === "git" ? "Nouvelle version sur main" : `Mise à jour ${version} prête`,
    body:
      app.kind === "windows"
        ? "Choisis quand l'installer."
        : app.kind === "mac"
          ? "Télécharge-la pour remplacer l'app."
          : "À récupérer avec git pull.",
  };
}

/** What a screen saw of an install: begun, and the server gone meanwhile. */
export interface InstallWatch {
  saw: boolean;
  lost: boolean;
}

/**
 * Follows an install from one screen. From the copy of the database on (a phone on 4G can
 * lose the server before the install itself begins), a screen that lost the server and
 * hears it again loads the new build; one that never lost it (the copy failed, nothing was
 * replaced) just forgets it.
 */
export function watchInstall(
  was: InstallWatch,
  phase: AppUpdate["phase"],
  connected: boolean,
): { watch: InstallWatch; reload: boolean } {
  const saw = was.saw || !!phase;
  const lost = saw && (was.lost || !connected);
  if (saw && connected && !phase) return { watch: { saw: false, lost: false }, reload: lost };
  return { watch: { saw, lost }, reload: false };
}

/** The command that brings a clone up to date, as the user runs it to start MoonAgentic. */
export const PULL_COMMAND = "git pull; pnpm install; pnpm build; pnpm start";

// Which card is open: one for the whole page, opened from the side bar or the home page.
let card: { top?: number; left?: number } | null = null;
const listeners = new Set<() => void>();
export const readUpdateCard = () => card;
export function subscribeUpdateCard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function openUpdateCard(at?: { top: number; left: number }): void {
  card = at ? { ...at } : {};
  for (const l of listeners) l();
}
export function closeUpdateCard(): void {
  if (!card) return;
  card = null;
  for (const l of listeners) l();
}
