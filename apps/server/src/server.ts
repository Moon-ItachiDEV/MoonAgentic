import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agents } from "./agents.ts";
import { serverArgs } from "./args.ts";
import { dailyBackups } from "./backups.ts";
import { preparePrivateDataDir } from "./data-dir.ts";
import { createHttpServer, newToken } from "./http.ts";
import { GithubAccount, setGithubAccount } from "./github-account.ts";
import { systemVault } from "./github-vault.ts";
import { Hub } from "./hub.ts";
import { defaultReaders } from "./quotas.ts";
import { Store } from "./store.ts";

// The server itself; `bin.ts` runs it under a supervisor that restarts it after a crash.
const values = serverArgs();

const dataDir = path.resolve(values["data-dir"]);
preparePrivateDataDir(dataDir);
const tokenFile = path.join(dataDir, "token");
if (!existsSync(tokenFile)) writeFileSync(tokenFile, newToken(), { mode: 0o600 });
const token = readFileSync(tokenFile, "utf8").trim();

const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const store = new Store(path.join(dataDir, "state.sqlite"));
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
const hub = new Hub(store, new Agents({ demo }), {
  worktreesDir: path.join(dataDir, "worktrees"),
  quotaReaders: defaultReaders({ demo }),
});
const server = createHttpServer({
  hub,
  token,
  // Written over the old one: the file keeps its owner-only access.
  onTokenRenewed: (renewed) => writeFileSync(tokenFile, renewed, { mode: 0o600 }),
  ...(!values.dev && existsSync(webDir) ? { webDir } : {}),
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const port = Number(values.port);
server.listen(port, values.host, () => {
  // Port 0 lets the system pick a free one: the address printed is the one it picked.
  const address = server.address();
  const uiPort = values.dev ? 5173 : typeof address === "object" && address ? address.port : port;
  const host = values.host === "0.0.0.0" ? "localhost" : values.host;
  console.log(`MoonAgentic est prêt : http://${host}:${uiPort}/?token=${token}`);
  if (!LOOPBACK.has(values.host)) {
    console.warn(
      "Attention : MoonAgentic écoute au-delà de cette machine, sans chiffrement. Ce lien donne " +
        "la main sur tes agents et tes fichiers : ne l'utilise que sur un réseau de confiance " +
        "ou derrière un tunnel chiffré (Tailscale, WireGuard, SSH).",
    );
  }
});

const backups = dailyBackups(store, path.join(dataDir, "backups"));

/** Gives up on stopping cleanly after this long: the process ends anyway. */
const STOP_LIMIT_MS = 15_000;
let stopping = false;
const stop = async (code: number) => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(code), STOP_LIMIT_MS).unref();
  try {
    backups.stop();
    server.close();
    // Every agent is stopped, so none is left running unseen once the server is gone.
    await hub.close();
    store.close();
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
  console.error("Erreur imprévue, MoonAgentic redémarre :", error);
  void stop(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
