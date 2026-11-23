import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

/** What `moonagentic` is started with, read the same way by its supervisor and its server. */
export function serverArgs(args: string[] = process.argv.slice(2)) {
  return parseArgs({
    args,
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
  }).values;
}
