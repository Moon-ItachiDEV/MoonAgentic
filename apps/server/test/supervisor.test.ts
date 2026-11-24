import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupNow } from "../src/backups.ts";
import {
  createLineBuffer,
  DailyLog,
  MAX_RESTART_DELAY_MS,
  redact,
  restartDelay,
  shouldRedactOutput,
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
  it("keeps tokens, Bearer credentials, GitHub tokens and API keys out of the log", () => {
    expect(redact("MoonAgentic est prêt : http://127.0.0.1:4747/?token=Ab_3-x9")).toBe(
      "MoonAgentic est prêt : http://127.0.0.1:4747/?token=…",
    );
    expect(redact("MoonAgentic est prêt : http://127.0.0.1:4747/#token=Ab_3-x9")).toBe(
      "MoonAgentic est prêt : http://127.0.0.1:4747/#token=…",
    );
    expect(redact("ws /ws?ticket=abc_123-XYZ")).toBe("ws /ws?ticket=…");
    expect(redact("Authorization: Bearer s3cret-token-99")).toBe("Authorization: Bearer …");
    expect(redact("Bearer sans secret")).toBe("Bearer sans secret");
    expect(redact("token ghp_1234567890abcdef and github_pat_11ABCDEF_9999")).toBe(
      "token ghp_… and github_pat_…",
    );
    expect(redact("key sk-ant-api03-abcdefghijklmno and sk-proj-123456789012345")).toBe(
      "key sk-ant-… and sk-proj-…",
    );
  });

  it("buffers split pipe chunks into whole lines before redacting", () => {
    const lines: string[] = [];
    const buf = createLineBuffer((line) => lines.push(redact(line)));
    buf.push("MoonAgentic est prêt : http://127.0.0.1:4747/#token=abc");
    buf.push("def123\nAuthorization: Bearer ");
    buf.push("ghp_split999999");
    buf.flush();
    expect(lines).toEqual([
      "MoonAgentic est prêt : http://127.0.0.1:4747/#token=…",
      "Authorization: Bearer …",
    ]);
    expect(lines.join("\n")).not.toContain("def123");
    expect(lines.join("\n")).not.toContain("split999999");
  });

  it("detects service managers where stdout/stderr must be redacted", () => {
    const piped = () => ["9:99999"];
    expect(shouldRedactOutput({}, piped)).toBe(false);
    // Inherited systemd vars on a piped CI runner or terminal do not match fd 1/2.
    expect(shouldRedactOutput({ INVOCATION_ID: "abc", JOURNAL_STREAM: "8:12345" }, piped)).toBe(
      false,
    );
    // Actual systemd service unit where stdout/stderr is wired to the journal stream.
    expect(shouldRedactOutput({ JOURNAL_STREAM: "8:12345" }, () => ["8:12345"])).toBe(true);
    expect(shouldRedactOutput({ NSSM_SERVICE_NAME: "MoonAgentic" }, piped)).toBe(true);
    expect(shouldRedactOutput({ MOONAGENTIC_REDACT_STDOUT: "1" }, piped)).toBe(true);
    expect(
      shouldRedactOutput({ JOURNAL_STREAM: "8:12345", MOONAGENTIC_REDACT_STDOUT: "0" }, () => [
        "8:12345",
      ]),
    ).toBe(false);
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

  it("stops writing a day's file once it is full, then starts again the next day", () => {
    const dir = tempDir();
    const morning = new Date(2026, 10, 20, 9, 0, 0);
    const log = new DailyLog(dir, 14, 200);
    for (let i = 0; i < 50; i++) log.write(`ligne ${i} qui revient en boucle`, morning);
    const today = readFileSync(path.join(dir, "moonagentic-2026-11-20.log"), "utf8");
    expect(today.length).toBeLessThan(400);
    expect(today).toContain("Journal plein pour aujourd'hui");
    expect(today.match(/Journal plein/g)).toHaveLength(1);
    // A restart the same day does not write past it either.
    const again = new DailyLog(dir, 14, 200);
    again.write("après redémarrage", morning);
    expect(readFileSync(path.join(dir, "moonagentic-2026-11-20.log"), "utf8")).toBe(today);
    again.write("le lendemain", new Date(2026, 10, 21, 9, 0, 0));
    expect(readFileSync(path.join(dir, "moonagentic-2026-11-21.log"), "utf8")).toBe(
      "09:00:00 le lendemain\n",
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
      console.log("prêt #token=secret");
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

  it("redacts split-chunk secrets in both DailyLog and forwarded stdout when redactOutput is enabled", async () => {
    const dir = tempDir();
    const script = path.join(dir, "split.mjs");
    writeFileSync(
      script,
      `process.stdout.write("prêt http://127.0.0.1:4747/#token=firstHalf");
      setTimeout(() => {
        process.stdout.write("SecondHalfSecret\\n");
        process.stderr.write("err ghp_splitErrToken123456\\n");
        process.exit(0);
      }, 30);`,
    );
    let out = "";
    let err = "";
    const code = await new Promise<number>((resolve) => {
      supervise({
        script,
        args: [],
        logDir: path.join(dir, "logs"),
        redactOutput: true,
        stdout: { write: (chunk) => (out += String(chunk)) },
        stderr: { write: (chunk) => (err += String(chunk)) },
        exit: resolve,
      });
    });
    expect(code).toBe(0);
    const [file] = readdirSync(path.join(dir, "logs"));
    const logged = readFileSync(path.join(dir, "logs", file!), "utf8");
    for (const sink of [logged, out, err]) {
      expect(sink).not.toContain("firstHalf");
      expect(sink).not.toContain("SecondHalfSecret");
      expect(sink).not.toContain("splitErrToken123456");
    }
    expect(out).toContain("#token=…");
    expect(err).toContain("ghp_…");
    expect(logged).toContain("#token=…");
    expect(logged).toContain("ghp_…");
  });
});

describe("daily backups", () => {
  it("copies the database once a day and keeps the last ones", async () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "state.sqlite"));
    store.addProject({ id: "p", name: "Projet", path: dir, createdAt: 1 });
    const backups = path.join(dir, "backups");
    const day = (d: number) => new Date(2026, 10, d, 12).getTime();

    const first = await backupNow(store, backups, day(20), 2);
    expect(first && existsSync(first)).toBe(true);
    // A copy cut short by a power cut is not taken for the day's copy.
    writeFileSync(path.join(backups, "state-2026-11-21.sqlite.tmp"), "moitié");
    // Once a day only.
    expect(await backupNow(store, backups, day(20), 2)).toBeUndefined();
    await backupNow(store, backups, day(21), 2);
    await backupNow(store, backups, day(22), 2);
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

  it("writes with synchronous NORMAL, as WAL allows without risking the database", () => {
    const store = new Store(path.join(tempDir(), "state.sqlite"));
    expect(store.db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    store.close();
  });

  it("keeps the server answering while a large database is copied", async () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "state.sqlite"));
    store.db.exec("CREATE TABLE filler (data BLOB)");
    const insert = store.db.prepare("INSERT INTO filler VALUES (randomblob(4096))");
    store.transaction(() => {
      for (let i = 0; i < 6_000; i++) insert.run();
    });
    // Counts the turns of the event loop while the copy runs: a copy made in one go, as
    // VACUUM INTO does, lets none through until it is done.
    let turns = 0;
    let copying = true;
    const tick = () => {
      if (!copying) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const copy = await backupNow(store, path.join(dir, "backups"));
    copying = false;
    expect(turns).toBeGreaterThan(10);
    store.close();
    const restored = new Store(copy!);
    expect(restored.db.prepare("SELECT count(*) AS n FROM filler").get()).toEqual({ n: 6_000 });
    restored.close();
  });
});
