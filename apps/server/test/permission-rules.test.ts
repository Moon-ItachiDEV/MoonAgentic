import { describe, expect, it } from "vitest";
import { commandOf, grantKey, readOnlyCall, readOnlyCommand } from "../src/permission-rules.ts";

describe("permission rules", () => {
  it("lets commands that only read pass", () => {
    for (const cmd of [
      "git diff main --stat",
      "git log -5 --oneline && git status",
      "git -C ../repo show HEAD:src/a.ts",
      "git --no-pager diff 2>&1",
      "rg -n 'foo > bar' src | head -40",
      'grep -rn "a;b" apps/web/src',
      "cat README.md",
      "sed -n '1,80p' src/app.ts",
      "ls -la; wc -l src/*.ts",
      "find . -name '*.ts' -not -path './node_modules/*'",
      "Get-Content src/app.ts | Select-Object -First 40",
      "gh pr view 155 --json files",
      "git branch --show-current",
      "cd apps/web && git diff",
    ]) {
      expect(readOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  it("asks for anything that can write or run something else", () => {
    for (const cmd of [
      "git commit -m x",
      "git push",
      "git branch feature",
      "git -c core.pager=sh log",
      "git diff --output=x.patch",
      "cat a > b",
      "echo $(rm -rf /)",
      "echo `id`",
      "sed -i 's/a/b/' x",
      "sed -n '1p;w out' x",
      "find . -delete",
      "find . -exec rm {} ;",
      "rm -rf dist",
      "npm test",
      "ls & rm x",
      "cat 'unclosed",
      "gh api -X POST repos/x/y/issues",
      "sort -o out in",
    ]) {
      expect(readOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  it("finds the command an agent runs, whatever shape it sends", () => {
    const call = (rawInput: unknown, title = "t") => ({
      toolCallId: "x",
      title,
      kind: "execute" as const,
      rawInput,
    });
    expect(commandOf(call({ command: "git diff" }))).toBe("git diff");
    expect(commandOf(call({ command: ["bash", "-lc", "git log -3"] }))).toBe("git log -3");
    expect(commandOf(call({ command: "/bin/bash -lc 'git status'" }))).toBe("git status");
    expect(
      commandOf(call({ command: 'powershell.exe -NoProfile -Command "Get-Content a.ts"' })),
    ).toBe("Get-Content a.ts");
    expect(commandOf(call(undefined, "git show HEAD"))).toBe("git show HEAD");
    expect(readOnlyCall(call({ command: ["bash", "-lc", "git log -3"] }))).toBe(true);
    expect(readOnlyCall({ toolCallId: "r", title: "Lire", kind: "read" })).toBe(true);
    expect(readOnlyCall({ toolCallId: "e", title: "Modifier", kind: "edit" })).toBe(false);
  });

  it("remembers a grant by the program it runs", () => {
    const run = (command: string) => ({
      toolCallId: "x",
      title: command,
      kind: "execute" as const,
      rawInput: { command },
    });
    expect(grantKey(run("npm test"))).toBe("execute:npm test");
    expect(grantKey(run("npm test -- --run"))).toBe("execute:npm test");
    expect(grantKey(run("cargo build --release"))).toBe("execute:cargo");
    expect(grantKey({ toolCallId: "e", title: "Modifier a.ts", kind: "edit" })).toBe("edit");
    expect(grantKey({ toolCallId: "o", title: "Run thing", kind: "other" }, "mcp__x__y")).toBe(
      "other:mcp__x__y",
    );
  });
});
