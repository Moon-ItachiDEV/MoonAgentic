// MoonAgentic's own updates as the interface shows them: a small moon in the capsule at the top
// right of every page, which stretches once to announce a version, the card it opens, and the
// steps of an install on every screen. What the server says, nothing guessed.
import type { AppInfo, AppUpdate, Notice } from "@moonagentic/protocol";
import { readPref, writePref } from "./prefs.ts";

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

/** Where the card stands: one look of it per state. */
export type CardState =
  "ready" | "downloading" | "waiting" | "installing" | "failed" | "git" | "mac";

/** Which look the card takes for what the server says. */
export function cardState(app: AppInfo): CardState {
  const u = app.update;
  if (u.phase) return "installing";
  if (u.install) return "waiting";
  if (u.state === "downloading") return "downloading";
  if (u.state === "failed") return "failed";
  if (app.kind === "git") return "git";
  if (app.kind === "mac") return "mac";
  return "ready";
}

/** How this MoonAgentic runs, in a word. */
export const kindName = (kind: AppInfo["kind"]): string =>
  kind === "windows" ? "Windows" : kind === "mac" ? "Mac" : kind === "git" ? "Clone git" : "";

/**
 * The newer version cut around the first number that changes, so that number alone rolls from
 * the old one to the new: « 0.1. » + 15 → 16. Undefined when the two do not compare (a commit).
 */
export function versionRoll(
  from: string,
  to: string,
): { head: string; was: string; now: string; tail: string } | undefined {
  const a = from.split(".");
  const b = to.split(".");
  if (a.length !== b.length || !b.every((part) => /^\d+$/.test(part))) return undefined;
  const at = b.findIndex((part, i) => part !== a[i]);
  if (at < 0 || !/^\d+$/.test(a[at]!)) return undefined;
  return {
    head: at ? `${b.slice(0, at).join(".")}.` : "",
    was: a[at]!,
    now: b[at]!,
    tail: at < b.length - 1 ? `.${b.slice(at + 1).join(".")}` : "",
  };
}

/**
 * The lit part of a moon of radius `r` centred on (`c`, `c`), for a lit share from 0 (new moon)
 * to 1 (full): the right limb, closed by the terminator. The share is exact in area.
 */
export function litPath(share: number, c = 24, r = 15): string {
  const f = Math.max(0, Math.min(1, share));
  if (f < 0.004) return "";
  if (f > 0.996)
    return `M${c} ${c - r}A${r} ${r} 0 1 1 ${c} ${c + r}A${r} ${r} 0 1 1 ${c} ${c - r}Z`;
  const k = 1 - 2 * f;
  const rx = (Math.abs(k) * r).toFixed(2);
  return `M${c} ${c - r}A${r} ${r} 0 0 1 ${c} ${c + r}A${rx} ${r} 0 0 ${k > 0 ? 0 : 1} ${c} ${c - r}Z`;
}

/** What is left of a download, from what was measured: « ≈ 20 s », nothing while unknown. */
export function etaLabel(progress: number, perSecond: number): string {
  if (!(perSecond > 0) || progress >= 1) return "";
  const seconds = Math.max(1, Math.round((1 - progress) / perSecond));
  return seconds < 60 ? `≈ ${seconds} s` : `≈ ${Math.round(seconds / 60)} min`;
}

/** A time since a moment, as a stopwatch: « 0:07 ». */
export function stopwatch(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The capsule's two lines while it announces, and what its small moon says the rest of the time. */
export function capsuleOf(app: AppInfo): {
  title: string;
  sub: string;
  tone: "ready" | "wait" | "run" | "fail";
} {
  const u = app.update;
  const state = cardState(app);
  if (state === "downloading")
    return {
      title: "Téléchargement",
      sub: `${Math.round((u.progress ?? 0) * 100)} %`,
      tone: "run",
    };
  if (state === "waiting") {
    const n = u.working ?? 0;
    return {
      title: `${u.version ?? "Mise à jour"} en attente`,
      sub: n ? workingLine(n) : "Va s'installer",
      tone: "wait",
    };
  }
  if (state === "failed") return { title: "Mise à jour", sub: "Échec", tone: "fail" };
  if (state === "git") {
    const n = u.behind ?? 0;
    return { title: "Nouvelle version", sub: `${n} commit${n > 1 ? "s" : ""}`, tone: "ready" };
  }
  return {
    title: `Version ${u.version ?? ""}`.trim(),
    sub: state === "mac" ? "Sortie" : "Prête",
    tone: "ready",
  };
}

/**
 * The version the capsule owes an announcement for: one ready to install (or to fetch by hand)
 * that this device has not announced yet (`told`). Once per version and device.
 */
export function announceDue(
  app: AppInfo | null | undefined,
  told: string | null,
): string | undefined {
  if (!app || app.kind === "other" || !app.update.version) return undefined;
  const { state, version, install, phase } = app.update;
  if (install || phase) return undefined;
  const ready =
    app.kind === "windows" ? state === "ready" : state === "ready" || state === "available";
  return ready && version !== told ? version : undefined;
}

/** What a screen keeps of an install it watched, to say afterwards what the version brought. */
export interface InstallMemo {
  version: string;
  from: string;
  notes: { title: string; number?: number }[];
}

/** The memo of an install that begins, as kept on the device until the new version is seen. */
export function installMemo(app: AppInfo): InstallMemo | undefined {
  const u = app.update;
  if (!u.phase || !u.version) return undefined;
  return { version: u.version, from: app.version, notes: u.notes ?? [] };
}

/** The memo as read back: undefined unless it is one. */
export function readMemo(raw: string | null): InstallMemo | undefined {
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as Partial<InstallMemo>;
    if (typeof m.version !== "string" || typeof m.from !== "string" || !Array.isArray(m.notes))
      return undefined;
    const notes = m.notes
      .filter((n) => n && typeof n.title === "string")
      .map((n) => ({
        title: n.title,
        ...(typeof n.number === "number" ? { number: n.number } : {}),
      }));
    return { version: m.version, from: m.from, notes };
  } catch {
    return undefined;
  }
}

/** Where the memo is kept on the device. */
const MEMO = "update.installing";
export const loadMemo = (): InstallMemo | undefined => readMemo(readPref(MEMO));
export const saveMemo = (memo: InstallMemo | undefined): void =>
  writePref(MEMO, memo ? JSON.stringify(memo) : "");

/**
 * What to do with a memo once the server answers: `show` when it now runs the version that was
 * being installed, `drop` when the install is over and it does not (it failed, nothing to
 * tell), `keep` while it is still under way or the server is not heard.
 */
export function memoFate(
  memo: InstallMemo | undefined,
  app: AppInfo | null | undefined,
  connected: boolean,
): "none" | "keep" | "show" | "drop" {
  if (!memo) return "none";
  if (!app || !connected || app.update.phase) return "keep";
  return app.version === memo.version ? "show" : "drop";
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
