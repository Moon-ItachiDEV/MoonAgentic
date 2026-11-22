import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agyPlaces, findCommand, shortName } from "../src/agents.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("agents the user adds", () => {
  it("finds a command by path, with ~ for the home folder", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moonagentic-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(path.join(home, "bin"));
    const name = process.platform === "win32" ? "mon-agent.cmd" : "mon-agent";
    writeFileSync(path.join(home, "bin", name), "");
    chmodSync(path.join(home, "bin", name), 0o755);

    expect(findCommand("~/bin/mon-agent", home)).toBe(path.join(home, "bin", name));
    expect(findCommand(path.join(home, "bin", "mon-agent"), home)).toBe(
      path.join(home, "bin", name),
    );
    expect(findCommand("~/bin/absent", home)).toBeUndefined();
    expect(findCommand("~/bin", home)).toBeUndefined();
    expect(findCommand(path.basename(process.execPath).replace(/\.exe$/, ""))).toBeDefined();
  });

  it("finds agy where its installer puts it, off the PATH", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moonagentic-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const [place] = agyPlaces({ LOCALAPPDATA: path.join(home, "AppData", "Local") }, home);
    expect(findCommand(place!)).toBeUndefined();
    mkdirSync(path.dirname(place!), { recursive: true });
    const file = process.platform === "win32" ? `${place}.exe` : place!;
    writeFileSync(file, "");
    chmodSync(file, 0o755);
    expect(findCommand(place!)).toBe(file);
  });

  it("gives an agent two letters for its badge", () => {
    expect(shortName("Mon agent")).toBe("Ma");
    expect(shortName("hermes")).toBe("He");
    expect(shortName("  ")).toBe("?");
  });
});
