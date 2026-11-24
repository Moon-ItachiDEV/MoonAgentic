import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopCrashLog, formatDesktopError, redactDesktopLine } from "../src/crash-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-desktop-log-"));
  dirs.push(dir);
  return dir;
}

describe("DesktopCrashLog", () => {
  it("writes redacted timestamped lines to desktop-YYYY-MM-DD.log", () => {
    const dir = tempDir();
    const log = new DesktopCrashLog(dir);
    const day = new Date("2026-04-15T09:05:06");
    log.write("[main] crash token=abc123 Bearer mysecret12345678 ghp_abcdef123456", day);
    const content = readFileSync(log.file(day), "utf8");
    expect(content).toContain("09:05:06 [main] crash token=… Bearer … ghp_…");
    expect(content).not.toContain("abc123");
    expect(content).not.toContain("mysecret12345678");
    expect(content).not.toContain("ghp_abcdef123456");
  });

  it("caps daily log size and prunes old files", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "desktop-2026-04-01.log"), "old-1\n");
    writeFileSync(path.join(dir, "desktop-2026-04-02.log"), "old-2\n");
    const log = new DesktopCrashLog(dir, 2, 120);
    const day = new Date("2026-04-15T10:00:00");
    log.write("premiere ligne", day);
    log.write("x".repeat(200), day);
    log.write("ligne ignoree apres plafond", day);

    const content = readFileSync(log.file(day), "utf8");
    expect(content).toContain("premiere ligne");
    expect(content).toContain("Journal bureau plein pour aujourd'hui");
    expect(content).not.toContain("ligne ignoree apres plafond");
    expect(readdirSync(dir).sort()).toEqual(["desktop-2026-04-02.log", "desktop-2026-04-15.log"]);
  });

  it("formats errors and redacts API keys", () => {
    expect(formatDesktopError(new Error("boom"))).toContain("boom");
    expect(formatDesktopError("plain text")).toBe("plain text");
    expect(redactDesktopLine("key sk-ant-1234567890abcdef")).toBe("key sk-ant-…");
  });
});
