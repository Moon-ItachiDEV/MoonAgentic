import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupNow } from "../src/backups.ts";
import {
  DailyLog,
  MAX_RESTART_DELAY_MS,
  redact,
  restartDelay,
  supervise,
} from "../src/supervisor.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-supervisor-"));
  dirs.push(dir);
  return dir;
};

describe("supervisor", () => {
  it("keeps the access token out of the log", () => {
    expect(redact("MoonAgentic est prêt : http://127.0.0.1:4747/?token=Ab_3-x9")).toBe(
      "MoonAgentic est prêt : http://127.0.0.1:4747/?token=…",
    );
  });

  it("waits longer after each crash in a row, up to a minute", () => {
    expect([1, 2, 3, 4].map(restartDelay)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(restartDelay(20)).toBe(MAX_RESTART_DELAY_MS);
  });

  it("writes one log file a day and deletes the oldest past the days kept", () => {
    const dir = tempDir();
    const log = new DailyLog(dir, 2);
    log.write("un\ndeux", new Date(2026, 10, 20, 9, 5, 7));
    log.write("trois", new Date(2026, 10, 21, 10, 0, 0));
    log.write("quatre", new Date(2026, 10, 22, 11, 0, 0));
    expect(readdirSync(dir).sort()).toEqual([
      "moonagentic-2026-11-21.log",
      "moonagentic-2026-11-22.log",
    ]);
    expect(readFileSync(path.join(dir, "moonagentic-2026-11-22.log"), "utf8")).toBe(
      "11:00:00 quatre\n",
    );
  });

  it("starts the server again after a crash, and stops with it once it ends cleanly", async () => {
    const dir = tempDir();
    const script = path.join(dir, "server.mjs");
    const runs = path.join(dir, "runs");
    // Fails the first time, as a crash would, then ends cleanly.
    writeFileSync(
      script,
      `import { appendFileSync, existsSync } from "node:fs";
      const first = !existsSync(${JSON.stringify(runs)});
      appendFileSync(${JSON.stringify(runs)}, "x");
      console.log("prêt ?token=secret");
      if (first) { console.error("boum"); process.exit(1); }`,
    );
    const code = await new Promise<number>((resolve) => {
      supervise({ script, args: [], logDir: path.join(dir, "logs"), exit: resolve });
    });
    expect(code).toBe(0);
    expect(readFileSync(runs, "utf8")).toBe("xx");
    const [file] = readdirSync(path.join(dir, "logs"));
    const logged = readFileSync(path.join(dir, "logs", file!), "utf8");
    expect(logged).toContain("boum");
    expect(logged).toContain("redémarre dans 1 s");
    expect(logged).toContain("token=…");
    expect(logged).not.toContain("secret");
  });
});

describe("daily backups", () => {
  it("copies the database once a day and keeps the last ones", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "state.sqlite"));
    store.addProject({ id: "p", name: "Projet", path: dir, createdAt: 1 });
    const backups = path.join(dir, "backups");
    const day = (d: number) => new Date(2026, 10, d, 12).getTime();

    const first = backupNow(store, backups, day(20), 2);
    expect(first && existsSync(first)).toBe(true);
    // A copy cut short by a power cut is not taken for the day's copy.
    writeFileSync(path.join(backups, "state-2026-11-21.sqlite.tmp"), "moitié");
    // Once a day only.
    expect(backupNow(store, backups, day(20), 2)).toBeUndefined();
    backupNow(store, backups, day(21), 2);
    backupNow(store, backups, day(22), 2);
    expect(readdirSync(backups).sort()).toEqual([
      "state-2026-11-21.sqlite",
      "state-2026-11-22.sqlite",
    ]);
    store.close();

    // A copy opens as the database it was made from.
    const copy = new Store(path.join(backups, "state-2026-11-22.sqlite"));
    expect(copy.listProjects().map((p) => p.name)).toEqual(["Projet"]);
    copy.close();
  });
});
