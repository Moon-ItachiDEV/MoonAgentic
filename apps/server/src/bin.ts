#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Agents } from "./agents.ts";
import { createHttpServer } from "./http.ts";
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
mkdirSync(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, "token");
if (!existsSync(tokenFile))
  writeFileSync(tokenFile, randomBytes(24).toString("base64url"), { mode: 0o600 });
const token = readFileSync(tokenFile, "utf8").trim();

const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const store = new Store(path.join(dataDir, "state.sqlite"));
const hub = new Hub(store, new Agents({ demo: values.dev || values.demo }));
const server = createHttpServer({
  hub,
  token,
  ...(!values.dev && existsSync(webDir) ? { webDir } : {}),
});

const port = Number(values.port);
server.listen(port, values.host, () => {
  const uiPort = values.dev ? 5173 : port;
  const host = values.host === "0.0.0.0" ? "localhost" : values.host;
  console.log(`MoonAgentic est prêt : http://${host}:${uiPort}/?token=${token}`);
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
