#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverArgs } from "./args.ts";
import { supervise } from "./supervisor.ts";

const values = serverArgs();
const script = fileURLToPath(new URL("./server.ts", import.meta.url));

if (values.dev) {
  // `node --watch` restarts it already, and a developer reads what it prints.
  await import("./server.ts");
} else {
  const supervisor = supervise({
    script,
    args: process.argv.slice(2),
    logDir: path.join(path.resolve(values["data-dir"]), "logs"),
  });
  process.on("SIGINT", () => supervisor.stop());
  process.on("SIGTERM", () => supervisor.stop());
  // Started by the desktop app: it closes the channel to stop, the one way Windows has.
  if (process.send) process.once("disconnect", () => supervisor.stop());
}
