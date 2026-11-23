// Starts the shell from the repository, for trying it out. pnpm does not run Electron's own
// download script, which every install would otherwise pay for: it is run here, once.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve("electron/package.json"));
const pathFile = path.join(pkg, "path.txt");
if (!existsSync(pathFile))
  execFileSync(process.execPath, [path.join(pkg, "install.js")], { stdio: "inherit" });
const electron = path.join(pkg, "dist", readFileSync(pathFile, "utf8").trim());
const app = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(electron, [app, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
