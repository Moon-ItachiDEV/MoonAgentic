import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlackBox,
  type BoxState,
  cpuMeter,
  explainPrevious,
  isTailscale,
  KEPT_SAMPLES,
  parseTasklist,
  parseWindowsEvents,
  type Sample,
  type SampleInput,
  clock as clockText,
  windowsEventsScript,
} from "../src/black-box.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-black-box-"));
  dirs.push(dir);
  return dir;
}

const GB = 1024 ** 3;
const MIN = 60_000;
const T0 = new Date("2026-11-27T14:30:00").getTime();
const healthy: SampleInput = {
  freeMem: 8 * GB,
  totalMem: 16 * GB,
  cpu: 12,
  diskFree: 200 * GB,
  net: ["192.168.1.20", "100.88.1.2"],
  server: "prêt",
};

/** A box on a clock the test moves, measuring what `measure` holds. */
function boxAt(dir: string, version = "0.1.16", boot = T0 - 3600_000) {
  const clock = { now: T0 };
  let measure: SampleInput = healthy;
  let tops = 0;
  const box = new BlackBox({
    dir,
    version,
    pid: 4242,
    now: () => clock.now,
    bootAt: () => boot,
    sample: () => measure,
    topProcesses: async () => {
      tops += 1;
      return [
        { name: "node.exe", mem: 9 * GB },
        { name: "claude.exe", mem: 3 * GB },
      ];
    },
  });
  return {
    box,
    clock,
    set: (m: Partial<SampleInput>) => {
      measure = { ...healthy, ...m };
    },
    tops: () => tops,
    log: () => readFileSync(path.join(dir, "boite-noire.log"), "utf8"),
    state: () => JSON.parse(readFileSync(path.join(dir, "boite-noire.json"), "utf8")) as BoxState,
  };
}

describe("the black box across a freeze", () => {
  it("after Windows restarted, says so with the last measures and what they show", async () => {
    const dir = tempDir();
    // First run: healthy, then memory runs out and the processor saturates, then nothing.
    const a = boxAt(dir);
    a.box.open();
    for (let i = 0; i < 3; i += 1) {
      await a.box.tick();
      a.clock.now += MIN;
    }
    a.set({ freeMem: 0.5 * GB, cpu: 99 });
    for (let i = 0; i < 3; i += 1) {
      await a.box.tick();
      a.clock.now += MIN;
    }
    const lastAt = a.state().lastAt;
    expect(a.log()).toContain("Mémoire presque pleine");
    expect(a.log()).toContain("plus gros : node.exe 9,0 Go, claude.exe 3,0 Go");
    expect(a.log()).toContain("Processeur saturé depuis 3 min");
    // The biggest programs are listed once, not every minute.
    expect(a.tops()).toBe(1);

    // The power is cut; Windows starts again 20 minutes later and MoonAgentic with it.
    const boot = lastAt + 20 * MIN;
    const b = boxAt(dir, "0.1.16", boot);
    b.clock.now = boot + 2 * MIN;
    const opening = b.box.open();
    const text = opening.report.join("\n");
    expect(text).toContain("Arrêt précédent INATTENDU : Windows a redémarré");
    expect(text).toContain("soit 20 min sans signe de vie avant le redémarrage");
    expect(text).toContain("mémoire presque pleine (3 % libre");
    expect(text).toContain("processeur saturé depuis");
    expect(opening.unexpected).toEqual({ from: lastAt - 15 * MIN, to: boot + 2 * MIN });
    expect(b.log()).toContain("Arrêt précédent INATTENDU");
    // The new run starts its own box.
    expect(b.state()).toMatchObject({ startedAt: boot + 2 * MIN, samples: [] });
    expect(b.state().stop).toBeUndefined();
  });

  it("tells an app that stopped alone from Windows restarting", () => {
    const prev: BoxState = {
      version: "0.1.16",
      pid: 1,
      startedAt: T0,
      bootAt: T0 - 3600_000,
      lastAt: T0 + 10 * MIN,
      samples: [{ ...healthy, at: T0 + 10 * MIN }],
    };
    const opening = explainPrevious(prev, {
      at: T0 + 30 * MIN,
      bootAt: T0 - 3600_000,
      version: "0.1.16",
    });
    expect(opening.report[0]).toContain("MoonAgentic s'est arrêté seul, Windows a continué");
    expect(opening.report.join("\n")).toContain("Rien d'anormal dans les dernières mesures");
    expect(opening.unexpected).toBeDefined();
  });

  it("says when an update froze the computer, and when one succeeded", () => {
    const dir = tempDir();
    const a = boxAt(dir, "0.1.15");
    a.box.open();
    void a.box.tick();
    a.clock.now += MIN;
    a.box.updating("0.1.16");
    // The computer froze while the installer ran: no stop written.
    const boot = a.clock.now + 30 * MIN;
    const b = boxAt(dir, "0.1.15", boot);
    b.clock.now = boot + MIN;
    const frozen = b.box.open().report.join("\n");
    expect(frozen).toContain("Une mise à jour vers 0.1.16 était lancée depuis");
    expect(frozen).toContain("La mise à jour vers 0.1.16");
    expect(frozen).toContain("n'a pas remplacé l'app : toujours 0.1.15");

    // A normal update: stopped for the installer, started again on the new version.
    b.box.updating("0.1.16");
    b.box.stop("mise à jour vers 0.1.16");
    b.box.stop("MoonAgentic quitté");
    expect(b.state().stop?.reason).toBe("mise à jour vers 0.1.16");
    const c = boxAt(dir, "0.1.16", boot);
    c.clock.now = b.clock.now + 2 * MIN;
    const opening = c.box.open();
    expect(opening.unexpected).toBeUndefined();
    expect(opening.report.join("\n")).toContain("Arrêt précédent normal");
    expect(opening.report.join("\n")).toContain(
      "Mise à jour de 0.1.15 vers 0.1.16 réussie : lancée à",
    );
  });

  it("notices a freeze it lives through, and tells it from sleep", async () => {
    const dir = tempDir();
    const a = boxAt(dir);
    a.box.open();
    await a.box.tick();
    a.clock.now += 19 * MIN;
    await a.box.tick();
    expect(a.log()).toContain("Aucune mesure pendant 19 min");
    expect(a.log()).toContain("sans mise en veille : Windows ou MoonAgentic était figé");

    a.box.note("L'ordinateur se met en veille.", true);
    a.clock.now += 40 * MIN;
    await a.box.tick();
    expect(a.log()).toContain("Aucune mesure pendant 40 min");
    expect(a.log()).toContain("l'ordinateur était en veille");
  });

  it("writes when the network or Tailscale goes and comes back", async () => {
    const dir = tempDir();
    const a = boxAt(dir);
    a.box.open();
    await a.box.tick();
    a.clock.now += MIN;
    a.set({ net: ["192.168.1.20"] });
    await a.box.tick();
    a.clock.now += MIN;
    a.set({ net: [] });
    await a.box.tick();
    a.clock.now += MIN;
    a.set({});
    await a.box.tick();
    const log = a.log();
    expect(log).toContain("Tailscale a perdu son adresse.");
    expect(log).toContain("Plus aucun réseau.");
    expect(log).toContain("Réseau revenu : 192.168.1.20, 100.88.1.2.");
  });

  it("tells the internet going from the local network going", async () => {
    const dir = tempDir();
    let online = true;
    const clock = { now: T0 };
    const box = new BlackBox({
      dir,
      version: "0.1.16",
      now: () => clock.now,
      bootAt: () => T0 - 3600_000,
      sample: () => healthy,
      online: async () => online,
    });
    box.open();
    await box.tick();
    clock.now += MIN;
    online = false;
    await box.tick();
    const log = () => readFileSync(path.join(dir, "boite-noire.log"), "utf8");
    expect(log()).toContain("Internet coupé : le réseau local reste là");
    expect(log()).not.toContain("Plus aucun réseau");
    // The run stops there: the next start names it among the signs.
    const next = new BlackBox({
      dir,
      version: "0.1.16",
      now: () => clock.now + 10 * MIN,
      bootAt: () => clock.now + 5 * MIN,
      sample: () => healthy,
    });
    const text = next.open().report.join("\n");
    expect(text).toContain(`internet coupé après ${clockText(T0)}`);
    expect(text).toContain("internet coupé · serveur prêt");
    clock.now += MIN;
    online = true;
    await box.tick();
    expect(log()).toContain("Internet revenu.");
  });

  it("knows when nothing answers out there", async () => {
    const { reachable } = await import("../src/black-box.ts");
    const { createServer } = await import("node:net");
    const server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await reachable([{ host: "127.0.0.1", port }], 2_000)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await reachable([{ host: "127.0.0.1", port }], 2_000)).toBe(false);
    expect(await reachable([], 2_000)).toBe(false);
  });

  it("keeps only the last hour of measures", async () => {
    const dir = tempDir();
    const a = boxAt(dir);
    a.box.open();
    for (let i = 0; i < KEPT_SAMPLES + 15; i += 1) {
      await a.box.tick();
      a.clock.now += MIN;
    }
    const samples = a.state().samples;
    expect(samples).toHaveLength(KEPT_SAMPLES);
    expect(samples.at(-1)?.at).toBe(a.clock.now - MIN);
  });

  it("starts on a missing or broken box without failing", () => {
    const dir = tempDir();
    const a = boxAt(dir);
    expect(a.box.open().report[0]).toContain("Première mise en route");
    writeFileSync(path.join(dir, "boite-noire.json"), "{ pas du json");
    const b = boxAt(dir);
    expect(b.box.open().unexpected).toBeUndefined();
  });
});

describe("what the black box reads", () => {
  it("knows Tailscale's addresses", () => {
    expect(isTailscale("100.88.1.2")).toBe(true);
    expect(isTailscale("100.64.0.1")).toBe(true);
    expect(isTailscale("100.128.0.1")).toBe(false);
    expect(isTailscale("192.168.1.20")).toBe(false);
  });

  it("measures the processor from the time each core spent", () => {
    let busy = 0;
    const meter = cpuMeter(
      () =>
        [
          {
            model: "",
            speed: 0,
            times: { user: busy, nice: 0, sys: 0, idle: 1000 + 100 * (busy > 0 ? 1 : 0), irq: 0 },
          },
        ] as os.CpuInfo[],
    );
    // Over the next second of the core: 900 ms busy, 100 ms idle.
    busy = 900;
    expect(meter()).toBeCloseTo(90, 5);
    // No time spent since: nothing to say.
    expect(meter()).toBeUndefined();
  });

  it("reads tasklist in French and in English", () => {
    const fr = [
      '"node.exe","1200","Console","1","1 234 567 Ko"',
      '"node.exe","1300","Console","1","100 000 Ko"',
      '"claude.exe","1400","Console","1","2 000 000 Ko"',
      '"System Idle Process","0","Services","0","8 Ko"',
    ].join("\r\n");
    expect(parseTasklist(fr).slice(0, 2)).toEqual([
      { name: "claude.exe", mem: 2_000_000 * 1024 },
      { name: "node.exe", mem: 1_334_567 * 1024 },
    ]);
    expect(parseTasklist('"Code.exe","1","Console","1","512,000 K"')).toEqual([
      { name: "Code.exe", mem: 512_000 * 1024 },
    ]);
  });

  it("names what Windows' log says of a stop, oldest first", () => {
    const json = JSON.stringify([
      {
        at: "2026-11-27T14:10:00.000Z",
        id: 41,
        provider: "Microsoft-Windows-Kernel-Power",
        level: 1,
        message: "Le système a redémarré sans s'arrêter correctement au préalable.",
      },
      {
        at: "2026-11-27T13:40:00.000Z",
        id: 2004,
        provider: "Microsoft-Windows-Resource-Exhaustion-Detector",
        level: 3,
        message: "Windows a diagnostiqué une condition de mémoire virtuelle insuffisante.",
      },
      {
        at: "2026-11-27T13:45:00.000Z",
        id: 10016,
        provider: "Microsoft-Windows-DistributedCOM",
        level: 3,
        message: "Paramètres d'autorisation",
      },
    ]);
    const lines = parseWindowsEvents(json);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Resource-Exhaustion-Detector 2004 [avertissement]");
    expect(lines[0]).toContain("mémoire virtuelle presque épuisée");
    expect(lines[2]).toContain("Kernel-Power 41 [critique]");
    expect(lines[2]).toContain("redémarrage sans arrêt propre");
    // PowerShell writes one event as an object, not a list.
    const one = parseWindowsEvents(
      JSON.stringify({ at: "2026-11-27T14:10:00Z", id: 6008, provider: "EventLog", level: 2 }),
    );
    expect(one[0]).toContain("l'arrêt précédent était inattendu");
    expect(parseWindowsEvents("")).toEqual([]);
    expect(parseWindowsEvents("pas du json")).toEqual([]);
  });

  it("keeps the known events when the log is long", () => {
    const noise = Array.from({ length: 100 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 10, 27, 12, i % 60, 0)).toISOString(),
      id: 10016,
      provider: "Microsoft-Windows-DistributedCOM",
      level: 3,
      message: `bruit ${i}`,
    }));
    const json = JSON.stringify([
      {
        at: "2026-11-27T11:00:00Z",
        id: 1074,
        provider: "User32",
        level: 4,
        message: "TrustedInstaller.exe a lancé le redémarrage",
      },
      ...noise,
    ]);
    const lines = parseWindowsEvents(json, 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("redémarrage ou arrêt demandé par un programme");
    expect(lines[0]).toContain("TrustedInstaller.exe");
  });

  it("puts only the two times into the PowerShell script", () => {
    const script = windowsEventsScript(
      Date.UTC(2026, 10, 27, 13, 25),
      Date.UTC(2026, 10, 27, 14, 12),
    );
    expect(script).toContain("[datetime]::Parse('2026-11-27T13:25:00.000Z')");
    expect(script).toContain("[datetime]::Parse('2026-11-27T14:12:00.000Z')");
    expect(script).toContain("LogName = 'System'");
    expect(script).toContain("ConvertTo-Json -Compress");
  });
});

describe("one measure on one line", () => {
  it("is readable", async () => {
    const { sampleLine } = await import("../src/black-box.ts");
    const s: Sample = { ...healthy, at: T0 };
    expect(sampleLine(s)).toBe(
      "14:30:00 · RAM libre 8,0 Go sur 16,0 Go (50 %) · processeur 12 % · disque libre 200,0 Go · réseau 192.168.1.20, Tailscale 100.88.1.2 · serveur prêt",
    );
  });
});

describe.runIf(process.platform === "win32")("on a real Windows", () => {
  it("reads the System log of the last day and the biggest programs", async () => {
    const { windowsEvents, windowsTopProcesses } = await import("../src/black-box.ts");
    const now = Date.now();
    const lines = await windowsEvents(now - 24 * 3600_000, now);
    expect(lines[0]).toMatch(/^ {2}Journal de Windows \(/);
    expect(lines.join("\n")).not.toContain("illisible");
    const top = await windowsTopProcesses();
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]?.mem).toBeGreaterThan(0);
  }, 90_000);
});
