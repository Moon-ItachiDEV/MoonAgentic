import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The release flow and the checks the app is held to are files of the repository: what they
// let a step do, and on which systems the tests run, is read here like any other rule.
const ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const read = (name: string) => readFileSync(path.join(WORKFLOWS, name), "utf8");
const workflows = () => readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

/** The lines of a workflow up to its `jobs:`, then each job's lines by its key. */
function split(text: string): { top: string; jobs: Map<string, string> } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string>();
  let name: string | undefined;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([\w-]+):\s*$/.exec(line);
    if (key) jobs.set((name = key[1]!), "");
    else if (name) jobs.set(name, `${jobs.get(name)}${line}\n`);
  }
  return { top: lines.slice(0, start).join("\n"), jobs };
}

/** What a `permissions:` block at this indentation grants, as `scope: level` pairs. */
function permissions(block: string, indent: number): Record<string, string> | undefined {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^ {${indent}}permissions:`).test(l));
  if (at < 0) return undefined;
  const inline = /permissions:\s*(\S.*)$/.exec(lines[at]!)?.[1];
  if (inline) return { all: inline.trim() };
  const granted: Record<string, string> = {};
  for (const line of lines.slice(at + 1)) {
    const pair = new RegExp(`^ {${indent + 2}}([\\w-]+):\\s*(\\S+)`).exec(line);
    if (!pair) break;
    granted[pair[1]!] = pair[2]!;
  }
  return granted;
}

describe("the release flow (N40)", () => {
  it("runs every action from a commit, not from a tag its owner can move", () => {
    const loose: string[] = [];
    for (const file of workflows()) {
      for (const [, action] of read(file).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(action!)) loose.push(`${file}: ${action}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it("gives the token write access to the release job only", () => {
    const { top, jobs } = split(read("desktop.yml"));
    expect(permissions(top, 0)).toEqual({ contents: "read" });
    const writers = [...jobs].filter(([, body]) =>
      Object.values(permissions(body, 4) ?? {}).includes("write"),
    );
    expect(writers.map(([name]) => name)).toEqual(["release"]);
    expect(permissions(jobs.get("release")!, 4)).toEqual({ contents: "write" });
  });

  it("lets the checks read the repository, and nothing more", () => {
    const { top, jobs } = split(read("ci.yml"));
    expect(permissions(top, 0)).toEqual({ contents: "read" });
    for (const body of jobs.values()) expect(permissions(body, 4)).toBeUndefined();
  });

  it("keeps no token in the folder a build runs its packages' scripts in", () => {
    const kept: string[] = [];
    for (const file of workflows()) {
      for (const [name, body] of split(read(file)).jobs) {
        const steps = body.split(/\n(?= {6}- )/);
        for (const step of steps) {
          if (/uses:\s*actions\/checkout@/.test(step) && !/persist-credentials:\s*false/.test(step))
            kept.push(`${file} ${name}`);
        }
      }
    }
    expect(kept).toEqual([]);
  });
});

describe("the tests on Windows (M5)", () => {
  it("runs the browser checks on Windows too", () => {
    const { jobs } = split(read("ci.yml"));
    const windows = [...jobs.values()].filter((body) => /runs-on:\s*windows-/.test(body));
    expect(windows.some((body) => /run:\s*pnpm e2e\b/.test(body))).toBe(true);
    expect(windows.some((body) => /run:\s*pnpm test\b/.test(body))).toBe(true);
  });

  it("leaves no browser check out on Windows", () => {
    const dir = path.join(ROOT, "e2e");
    const skipped = readdirSync(dir)
      .filter((f) => f.endsWith(".e2e.ts"))
      .filter((f) =>
        /skipIf\(process\.platform === "win32"/.test(readFileSync(path.join(dir, f), "utf8")),
      );
    expect(skipped).toEqual([]);
  });
});
