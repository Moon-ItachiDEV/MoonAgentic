import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

/** `./x.ts` becomes `./x.js` in what imports or spawns it: the files are renamed the same way. */
export const renameImports = (code: string) =>
  code
    .replace(
      /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\.ts\2/g,
      "$1$2$3.js$2",
    )
    .replace(
      /(\bnew\s+URL\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2(\s*,\s*import\.meta\.url\s*\))/g,
      "$1$2$3.js$2$4",
    );

/**
 * Node runs TypeScript as is, except under `node_modules` and inside an app archive: what goes
 * there is turned into JavaScript first, by Node's own stripping of the types.
 */
export function stripDir(from: string, to: string, skip: (name: string) => boolean = () => false) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) {
      stripDir(source, path.join(to, entry.name), skip);
    } else if (entry.name.endsWith(".ts")) {
      const code = stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" });
      writeFileSync(path.join(to, entry.name.replace(/\.ts$/, ".js")), renameImports(code));
    } else {
      writeFileSync(path.join(to, entry.name), readFileSync(source));
    }
  }
}

export const isTest = (name: string) => name.endsWith(".test.ts");

/**
 * The server's scripts whose TypeScript path a version before this one wrote outside the app,
 * where nothing writes it again by itself: Hermes's `config.yaml` starts `src/hermes-bridge.ts`.
 */
export const KEPT_PATHS = ["hermes-bridge"];

/**
 * Turns the server's `src/` into plain JavaScript, in place: a packaged start skips Node's
 * stripping of the types of every module, and the scripts keep their places (bridges,
 * `web/dist`). A path written elsewhere by an earlier version stays, as a file that only runs
 * its JavaScript.
 */
export function stripServerSrc(src: string): void {
  const js = `${src}-js`;
  rmSync(js, { recursive: true, force: true });
  stripDir(src, js, isTest);
  rmSync(src, { recursive: true, force: true });
  renameSync(js, src);
  for (const name of KEPT_PATHS) {
    writeFileSync(path.join(src, `${name}.ts`), `import "./${name}.js";\n`);
  }
}
