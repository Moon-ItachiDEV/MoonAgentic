import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agents } from "./agents.ts";
import { gitSource, type ShellChannel } from "./app-update.ts";
import { serverArgs } from "./args.ts";
import { dailyBackups } from "./backups.ts";
import { CANNOT_START, cannotStart } from "./cannot-start.ts";
import { preparePrivateDataDir } from "./data-dir.ts";
import { Devices } from "./devices.ts";
import { DiagnosticsMonitor } from "./diagnostics.ts";
import { setSlowGitListener } from "./git.ts";
import { buildId, createHttpServer, newToken } from "./http.ts";
import { GithubAccount, setGithubAccount } from "./github-account.ts";
import { systemVault } from "./github-vault.ts";
import { Hub } from "./hub.ts";
import {
  ALREADY_RUNNING,
  ALREADY_RUNNING_LINE,
  lockDataDir,
  portFree,
  readOrCreateToken,
  writeFileAtomic,
} from "./instance.ts";
import { defaultReaders } from "./quotas.ts";
import { Store } from "./store.ts";
import { HEARTBEAT_MS } from "./supervisor.ts";

function readAppVersion(webDir: string): string | undefined {
  const fromEnv = process.env.MOONAGENTIC_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../desktop/package.json", import.meta.url)), "utf8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {
    // Packaged or standalone layout without sibling desktop package.json.
  }
  return buildId(webDir) ?? undefined;
}

// The server itself; `bin.ts` runs it under a supervisor that restarts it after a crash.
const values = serverArgs();

const dataDir = path.resolve(values["data-dir"]);
preparePrivateDataDir(dataDir);
// Before the database is opened: on start, the threads it finds running are taken for ones a
// crash left, and stopped. Those of a MoonAgentic still running on this folder must not be.
const lock = await lockDataDir(dataDir);
if (!lock) {
  console.error(
    `${ALREADY_RUNNING_LINE} (${dataDir}). Ouvre celui-là, ou ferme-le avant d'en lancer un autre.`,
  );
  process.exit(ALREADY_RUNNING);
}
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const port = Number(values.port);
// Checked before anything starts too, so a taken port costs nothing: no agent or team is
// started then stopped at each new try of the supervisor.
if (!(await portFree(port, values.host))) {
  console.error(
    `Le port ${port} est déjà pris (EADDRINUSE) : un autre programme l'utilise. MoonAgentic réessaie bientôt.`,
  );
  // Leaves no socket file behind on macOS and Linux.
  lock.release();
  process.exit(1);
}
const tokenFile = path.join(dataDir, "token");
const token = readOrCreateToken(tokenFile, newToken);

const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const databaseFile = path.join(dataDir, "state.sqlite");
const backupsDir = path.join(dataDir, "backups");
/**
 * Opens what reads the database. A database of a newer MoonAgentic, or a damaged one, ends
 * the start for good, saying why and what to do: starting again would only meet it again.
 */
const opening = <T>(open: () => T): T => {
  try {
    return open();
  } catch (error) {
    const why = cannotStart(error, databaseFile, backupsDir);
    if (!why) throw error;
    console.error(why);
    lock.release();
    process.exit(CANNOT_START);
  }
};
const store = opening(() => new Store(databaseFile));
// MoonAgentic's own GitHub sign-in, sealed by the system; read now so pushes find it at once.
const github = new GithubAccount({
  vault: systemVault(dataDir),
  // Stand-ins for github.com, for the end-to-end tests only.
  ...(process.env.MOONAGENTIC_GITHUB_URL ? { webUrl: process.env.MOONAGENTIC_GITHUB_URL } : {}),
  ...(process.env.MOONAGENTIC_GITHUB_API_URL
    ? { apiUrl: process.env.MOONAGENTIC_GITHUB_API_URL }
    : {}),
  onLogin: (result) => hub.githubLoginEnded(result),
});
setGithubAccount(github);
void github.currentToken();
const demo = !!(values.dev || values.demo);
const worktreesDir = path.join(dataDir, "worktrees");
// The desktop app's channel goes through the supervisor, which passes its messages on; a
// supervisor started from a terminal answers none, and the server goes without.
const shell: ShellChannel | undefined = process.send
  ? {
      send: (message) => {
        if (process.connected) process.send?.(message, undefined, undefined, () => undefined);
      },
      onMessage: (listener) => process.on("message", listener),
    }
  : undefined;
// A clone started with `pnpm start` learns of new commits on `main`; the desktop app looks
// for its own versions, and a development run for none.
const appGit =
  demo || process.env.MOONAGENTIC_DESKTOP
    ? undefined
    : gitSource(fileURLToPath(new URL("../../..", import.meta.url)));
const hub = opening(
  () =>
    new Hub(store, new Agents({ demo }), {
      dataDir,
      worktreesDir,
      quotaReaders: defaultReaders({ demo }),
      backupsDir,
      ...(shell ? { shell } : {}),
      ...(appGit ? { appGit } : {}),
    }),
);
const diagnostics = new DiagnosticsMonitor({
  dataDir,
  logDir: path.join(dataDir, "logs"),
  worktreesDir,
  getAgents: () => hub.diagnosticAgents(),
  getRunningTurns: () => hub.runningTurnCount,
  getStartingAgents: () => hub.startingAgentCount,
  hasLockedProjects: () => hub.hasLockedProjects(),
  appVersion: readAppVersion(webDir),
});
hub.setDiagnostics(diagnostics);
setSlowGitListener((subcommand, ms) =>
  diagnostics.recordSlow("git", `git lent (${subcommand}, ${ms} ms)`, ms),
);
// Images joined to a message that was never sent, left from an earlier run.
hub.attachments.sweep();
const server = createHttpServer({
  hub,
  token,
  diagnostics,
  // Each paired phone or tablet, with its own token, kept in the database.
  devices: new Devices(store),
  // Written whole beside the old one, then put in its place: a power cut keeps one of the two.
  onTokenRenewed: (renewed) => writeFileAtomic(tokenFile, renewed),
  ...(!values.dev && existsSync(webDir) ? { webDir } : {}),
});

server.listen(port, values.host, () => {
  // Port 0 lets the system pick a free one: the address printed is the one it picked.
  const address = server.address();
  const uiPort = values.dev ? 5173 : typeof address === "object" && address ? address.port : port;
  const host = values.host === "0.0.0.0" ? "localhost" : values.host;
  console.log(`MoonAgentic est prêt : http://${host}:${uiPort}/#token=${token}`);
  // Once listening, check Hermes's MCP entry and gateway right away instead of waiting 5 min.
  void hub.hermes.watchGateway();
  // Its supervisor hears from it while it answers: a server stuck in a loop, or stopped,
  // says nothing more, and is started again (N4).
  if (process.send) {
    const beat = () => {
      if (process.connected)
        process.send?.({ heartbeat: Date.now() }, undefined, undefined, () => undefined);
    };
    beat();
    setInterval(beat, HEARTBEAT_MS).unref();
  }
  if (!LOOPBACK.has(values.host)) {
    console.warn(
      "Attention : MoonAgentic écoute au-delà de cette machine, sans chiffrement. Ce lien donne " +
        "la main sur tes agents et tes fichiers : ne l'utilise que sur un réseau de confiance " +
        "ou derrière un tunnel chiffré (Tailscale, WireGuard, SSH).",
    );
  }
});

const backups = dailyBackups(store, backupsDir);

/** Gives up on stopping cleanly after this long: the process ends anyway. */
const STOP_LIMIT_MS = 15_000;
let stopping = false;
const stop = async (code: number) => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(code), STOP_LIMIT_MS).unref();
  diagnostics.stop();
  setSlowGitListener(undefined);
  // No new copy of the database starts while the server stops; one under way ends first.
  const backupsDone = backups.stop();
  try {
    server.close();
    // Every agent is stopped, so none is left running unseen once the server is gone.
    await hub.close();
    await backupsDone;
    store.close();
    lock.release();
  } catch (error) {
    console.error("Arrêt incomplet :", error);
  }
  process.exit(code);
};
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
// Run by the supervisor: when it asks to stop, or is gone, the server stops too.
if (process.send) process.once("disconnect", () => void stop(0));
// An error nothing caught leaves the server in a state no one knows: it says what happened,
// stops its agents, and ends with a failure, for its supervisor to start it again.
const crash = (error: unknown) => {
  // A write the database refused because the disk is full, or another program holds the file,
  // leaves nothing to put right by starting again: every agent would be cut, and the start
  // would fail on the same cause. The server stays up and its screens say so.
  if (hub.storageFailed(error)) return;
  console.error("Erreur imprévue, MoonAgentic redémarre :", error);
  void stop(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
