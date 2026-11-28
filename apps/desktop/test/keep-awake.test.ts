import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AWAKE_FLAGS,
  keepAwakeScript,
  keepAwakeSpawn,
  sleepBlockerKind,
  UPDATE_AWAKE_SECONDS,
} from "../src/keep-awake.ts";

describe("keeping the computer awake", () => {
  it("asks Windows for the display, the only request modern standby gives way to", () => {
    // « prevent-app-suspension » is PowerRequestExecutionRequired on Windows 8 and later: it
    // keeps the app from being suspended, not the computer from sleeping (27/11, mini-PC
    // in modern standby at 14:33 with « Empêcher la veille » on).
    expect(sleepBlockerKind("win32")).toBe("prevent-display-sleep");
    expect(sleepBlockerKind("darwin")).toBe("prevent-app-suspension");
    expect(sleepBlockerKind("linux")).toBe("prevent-app-suspension");
  });

  it("holds the system and the display for the time of an update", () => {
    expect(AWAKE_FLAGS).toBe(0x80000003);
    const script = keepAwakeScript(UPDATE_AWAKE_SECONDS);
    expect(script).toContain("SetThreadExecutionState([uint32]2147483651)");
    expect(script).toContain("Start-Sleep -Seconds 900");
    expect(keepAwakeScript(-5)).toContain("Start-Sleep -Seconds 1");
    expect(keepAwakeScript(1e9)).toContain("Start-Sleep -Seconds 86400");
    const run = keepAwakeSpawn();
    expect(run.file).toBe("powershell.exe");
    expect(run.args.at(-1)).toBe(script);
    expect(run.options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
  });
});

describe.runIf(process.platform === "win32")("on a real Windows", () => {
  it("is listed by powercfg as keeping the system and the display on", async () => {
    const { file, args, options } = keepAwakeSpawn(60);
    const child = spawn(file, args, { ...options, detached: false });
    try {
      /** What holds each of Windows's requests now: « DISPLAY: », « SYSTEM: »… then who, or « None. ». */
      const held = async () => {
        const { stdout } = await promisify(execFile)("powercfg", ["/requests"], {
          windowsHide: true,
        });
        const sections = new Map<string, string>();
        let current = "";
        for (const line of stdout.split(/\r?\n/)) {
          const head = /^([A-Z]+):\s*$/.exec(line);
          if (head?.[1]) current = head[1];
          else if (current) sections.set(current, `${sections.get(current) ?? ""}${line}\n`);
        }
        return (name: string) => (sections.get(name) ?? "").toLowerCase();
      };
      // PowerShell has to start and compile its call first: a few seconds on a free computer,
      // and it seems more than the eight once waited here on a runner busy with another test
      // file (CI, 2026-11-28: « None. » after 8 s). Asked again until it holds, not once.
      await expect
        .poll(async () => (await held())("DISPLAY"), { timeout: 45_000, interval: 1_000 })
        .toContain("powershell.exe");
      expect((await held())("SYSTEM")).toContain("powershell.exe");
    } finally {
      child.kill();
    }
  }, 60_000);
});
