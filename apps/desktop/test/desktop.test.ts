import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renameImports } from "../scripts/strip.ts";
import {
  MAX_RESTART_DELAY_MS,
  readLine,
  restartDelay,
  ServerProcess,
  type ServerState,
} from "../src/server-process.ts";
import { DEFAULTS, readSettings, writeSettings } from "../src/settings.ts";
import { mergePaths, pathFromShell } from "../src/shell-path.ts";
import { stateLabel, statusPage } from "../src/status-page.ts";

const fake = fileURLToPath(new URL("./fake-launcher.ts", import.meta.url));

describe("readLine", () => {
  it("finds the address the server prints once ready", () => {
    expect(readLine("MoonAgentic est prêt : http://127.0.0.1:4747/#token=a-b_c")).toEqual({
      ready: "http://127.0.0.1:4747/#token=a-b_c",
    });
  });

  it("says why the server is down", () => {
    expect(readLine("Error: listen EADDRINUSE: address already in use 127.0.0.1:4747")).toEqual({
      failed: expect.stringContaining("port est déjà pris"),
    });
    // Its supervisor's line says it starts again: less than a reason given before it.
    expect(
      readLine("Le serveur s'est arrêté sur une erreur (code 1) : il redémarre dans 1 s."),
    ).toEqual({ restarting: expect.stringContaining("redémarre") });
    expect(
      readLine("Le serveur ne répond plus depuis 60 s : il est arrêté, puis relancé."),
    ).toEqual({ restarting: expect.stringContaining("ne répondait plus") });
    expect(
      readLine(
        "MoonAgentic ne peut pas démarrer : Cette base de données vient d'une version plus récente de MoonAgentic. Mets MoonAgentic à jour pour l'ouvrir.",
      ),
    ).toEqual({ failed: expect.stringMatching(/version plus récente.*Mets MoonAgentic à jour/) });
    expect(
      readLine("MoonAgentic tourne déjà sur ce dossier de données (/home/moi/.moonagentic)."),
    ).toEqual({ failed: expect.stringContaining("tourne déjà") });
    expect(readLine("Sauvegarde de la base : x")).toBeUndefined();
  });
});

describe("restartDelay", () => {
  it("waits longer after each failure, up to a minute", () => {
    expect([1, 2, 3].map(restartDelay)).toEqual([1_000, 2_000, 4_000]);
    expect(restartDelay(30)).toBe(MAX_RESTART_DELAY_MS);
  });
});

describe("ServerProcess", () => {
  const run = (mode: string, platform?: NodeJS.Platform) => {
    const states: ServerState[] = [];
    const server = new ServerProcess({
      command: process.execPath,
      script: fake,
      args: ["--port", "4999"],
      env: () => ({ ...process.env, FAKE_MODE: mode }),
      onState: (state) => states.push(state),
      ...(platform ? { platform } : {}),
    });
    return { server, states };
  };
  const until = (states: ServerState[], test: (s: ServerState[]) => boolean) =>
    new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (test(states)) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });

  it("reports the address, then stops when asked", async () => {
    const { server, states } = run("steady");
    server.start();
    await until(states, (s) => s.some((x) => x.kind === "ready"));
    expect(server.state).toEqual({ kind: "ready", url: "http://127.0.0.1:4999/#token=abc" });
    await server.stop();
    expect(states.map((s) => s.kind)).toEqual(["starting", "ready", "stopping", "stopped"]);
  });

  it("waits for the launcher to end when only its channel can ask it to (Windows)", async () => {
    const { server, states } = run("steady", "win32");
    server.start();
    await until(states, (s) => s.some((x) => x.kind === "ready"));
    await server.stop();
    expect(states.map((s) => s.kind)).toEqual(["starting", "ready", "stopping", "stopped"]);
  });

  it("does not start again when quitting during a restart", async () => {
    const { server, states } = run("steady");
    server.start();
    await until(states, (s) => s.some((x) => x.kind === "ready"));
    const restarting = server.restart();
    await server.stop();
    await restarting;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.state.kind).toBe("stopped");
    expect(states.filter((s) => s.kind === "starting")).toHaveLength(1);
  });

  it("starts the launcher again when it ends by itself", async () => {
    const { server, states } = run("crash");
    server.start();
    await until(states, (s) => s.filter((x) => x.kind === "ready").length >= 2);
    await server.stop();
    const kinds = states.map((s) => s.kind);
    expect(kinds.slice(0, 5)).toEqual(["starting", "ready", "restarting", "starting", "ready"]);
    expect(server.state.kind).toBe("stopped");
  });

  it("keeps saying why the server ended once it has ended", async () => {
    const { server, states } = run("already");
    server.start();
    await until(states, (s) =>
      s.some((x) => x.kind === "restarting" && x.reason.includes("repart")),
    );
    await server.stop();
    const restarting = states.filter((s) => s.kind === "restarting");
    expect(restarting.at(-1)).toEqual({
      kind: "restarting",
      reason: expect.stringMatching(/tourne déjà.*Nouvel essai : il repart dans 1 s\./),
    });
  });
});

describe("ServerProcess, when things go wrong (N4, N37)", () => {
  const run = (mode: string, command = process.execPath) => {
    const states: ServerState[] = [];
    const server = new ServerProcess({
      command,
      script: fake,
      args: ["--port", "4999"],
      env: () => ({ ...process.env, FAKE_MODE: mode }),
      onState: (state) => states.push(state),
    });
    return { server, states };
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("reads a line cut in the middle of a character, and one ended by \\r\\n", async () => {
    const { server, states } = run("split");
    server.start();
    await wait(1_000);
    expect(states.map((s) => s.kind)).toEqual(["starting", "ready"]);
    expect(server.state).toEqual({ kind: "ready", url: "http://127.0.0.1:4999/#token=abc" });
    await server.stop();
  });

  it("does not start again a server that cannot open its database, and says why", async () => {
    const { server, states } = run("cannot");
    server.start();
    await wait(2_500);
    expect(states.filter((s) => s.kind === "starting")).toHaveLength(1);
    expect(server.state).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/abîmée.*remplace x par la sauvegarde y/),
    });
    expect(stateLabel(server.state, 4747)).toBe("Ne peut pas démarrer");
    expect(statusPage(server.state, "/logs")).toContain("MoonAgentic ne peut pas démarrer");
    await server.stop();
  });

  it("keeps the server's own reason when its supervisor then says it starts again", async () => {
    const { server } = run("port");
    server.start();
    await wait(800);
    expect(server.state).toEqual({
      kind: "restarting",
      reason: expect.stringContaining("port est déjà pris"),
    });
    await server.stop();
  });

  it("tries again when the program itself cannot be started, and stops at once", async () => {
    const missing = path.join(os.tmpdir(), "moonagentic-introuvable", "electron");
    const { server, states } = run("steady", missing);
    server.start();
    await wait(3_000);
    expect(states.filter((s) => s.kind === "starting").length).toBeGreaterThanOrEqual(2);
    expect(
      states.some(
        (s) => s.kind === "restarting" && s.reason.includes("Impossible de lancer le serveur"),
      ),
    ).toBe(true);
    const before = Date.now();
    await server.stop();
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(server.state.kind).toBe("stopped");
  });
});

describe("login shell PATH", () => {
  it("reads the PATH between its marks, whatever else the shell printed", () => {
    expect(
      pathFromShell(
        "Bienvenue\n__MOONAGENTIC_PATH__/opt/homebrew/bin:/usr/bin__MOONAGENTIC_PATH__",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
    expect(pathFromShell("rien")).toBeUndefined();
  });

  it("puts the shell's folders first, each once", () => {
    expect(mergePaths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });
});

describe("settings", () => {
  it("keeps sleep prevention on unless turned off", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-desktop-"));
    const file = path.join(dir, "settings.json");
    expect(readSettings(file)).toEqual(DEFAULTS);
    writeSettings(file, { preventSleep: false, backgroundHintShown: true });
    expect(readSettings(file)).toEqual({ preventSleep: false, backgroundHintShown: true });
    writeFileSync(file, "{oops");
    expect(readSettings(file)).toEqual(DEFAULTS);
  });
});

describe("status page", () => {
  it("names the state and escapes what it shows", () => {
    expect(stateLabel({ kind: "ready", url: "x" }, 4747)).toBe("En marche, port 4747");
    const page = statusPage({ kind: "restarting", reason: "<b>port</b>" }, "C:\\logs");
    expect(page).toContain("MoonAgentic redémarre");
    expect(page).not.toContain("<b>port</b>");
  });
});

describe("renameImports", () => {
  it("points relative imports at the JavaScript files", () => {
    expect(renameImports(`import { a } from "./a.ts";\nexport { b } from '../b.ts';`)).toBe(
      `import { a } from "./a.js";\nexport { b } from '../b.js';`,
    );
    expect(renameImports(`import x from "zod";`)).toBe(`import x from "zod";`);
  });
});
