#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Agents } from "./agents.ts";
import { preparePrivateDataDir } from "./data-dir.ts";
import { createHttpServer, newToken } from "./http.ts";
import { Hub } from "./hub.ts";
import { Store } from "./store.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.MOONAGENTIC_PORT ?? "4747" },
    host: { type: "string", default: "127.0.0.1" },
    "data-dir": {
      type: "string",
      default: process.env.MOONAGENTIC_HOME ?? path.join(os.homedir(), ".moonagentic"),
    },
    dev: { type: "boolean", default: false },
    demo: { type: "boolean", default: false },
  },
});

const dataDir = path.resolve(values["data-dir"]);
preparePrivateDataDir(dataDir);
const tokenFile = path.join(dataDir, "token");
if (!existsSync(tokenFile)) writeFileSync(tokenFile, newToken(), { mode: 0o600 });
const token = readFileSync(tokenFile, "utf8").trim();

const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const store = new Store(path.join(dataDir, "state.sqlite"));
const hub = new Hub(store, new Agents({ demo: values.dev || values.demo }), {
  worktreesDir: path.join(dataDir, "worktrees"),
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

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await hub.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
