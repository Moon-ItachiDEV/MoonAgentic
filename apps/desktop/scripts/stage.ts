// Gathers what the installer ships besides the shell, in `stage/`: the server with only the
// packages it runs with, and the interface already built (`pnpm build`).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTest, stripDir } from "./strip.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const stage = fileURLToPath(new URL("../stage", import.meta.url));
const server = path.join(stage, "server");
const webDist = path.join(root, "apps", "web", "dist");

if (!existsSync(path.join(webDist, "index.html"))) {
  console.error("L'interface n'est pas construite : lance d'abord `pnpm build` à la racine.");
  process.exit(1);
}
rmSync(stage, { recursive: true, force: true });

// Plain folders rather than links, which an installer does not keep everywhere. Run with the
// pnpm that runs this script, when there is one, so that no shell rereads the paths.
const deploy = [
  "--filter",
  "@moonagentic/server",
  "deploy",
  "--prod",
  "--legacy",
  "--config.node-linker=hoisted",
  server,
];
const pnpm = process.env.npm_execpath;
if (pnpm && /pnpm/i.test(path.basename(pnpm)) && pnpm.endsWith("js")) {
  execFileSync(process.execPath, [pnpm, ...deploy], { cwd: root, stdio: "inherit" });
} else {
  execFileSync("pnpm", deploy, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
rmSync(path.join(server, "test"), { recursive: true, force: true });
rmSync(path.join(server, "tsconfig.json"), { force: true });

// Pre-strip the server's TypeScript into plain JS so packaged startups skip Node's runtime
// type-stripping on every module while keeping relative script paths (bridges, web/dist) intact.
const serverSrc = path.join(server, "src");
const serverSrcJs = path.join(server, "src-js");
stripDir(serverSrc, serverSrcJs, isTest);
rmSync(serverSrc, { recursive: true, force: true });
renameSync(serverSrcJs, serverSrc);

// The protocol package sits under node_modules now, where Node runs no TypeScript.
const protocol = path.join(server, "node_modules", "@moonagentic", "protocol");
rmSync(protocol, { recursive: true, force: true });
stripDir(path.join(root, "packages", "protocol", "src"), path.join(protocol, "src"), isTest);
writeFileSync(
  path.join(protocol, "package.json"),
  JSON.stringify(
    {
      name: "@moonagentic/protocol",
      private: true,
      type: "module",
      exports: { ".": "./src/index.js" },
    },
    null,
    2,
  ),
);

// The server finds the interface at `../../web/dist`, from its own `src/`.
cpSync(webDist, path.join(stage, "web", "dist"), { recursive: true });
console.log(`Prêt à emballer : ${stage}`);
