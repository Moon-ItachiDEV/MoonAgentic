import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandOf,
  editInsideFolder,
  grantKey,
  grantKeys,
  readOnlyCall,
  readOnlyCommand,
} from "../src/permission-rules.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("permission rules", () => {
  it("lets commands that only read pass", () => {
    for (const cmd of [
      "git diff main --stat",
      "git log -5 --oneline && git status",
      "git -C ../repo show HEAD:src/a.ts",
      "git --no-pager diff 2>&1",
      "git diff 2>/dev/null",
      "rg -n 'foo > bar' src | head -40",
      'grep -rn "a;b" apps/web/src',
      "cat README.md",
      "sed -n '1,80p' src/app.ts",
      "ls -la; wc -l src/*.ts",
      "find . -name '*.ts' -not -path './node_modules/*'",
      "Get-Content src/app.ts | Select-Object -First 40",
      "gh pr view 155 --json files",
      "git branch --show-current",
      "git branch -a",
      "git tag -l 'v*'",
      "git remote -v",
      "sort a.txt | uniq -c",
      "cd apps/web && git diff",
    ]) {
      expect(readOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  it("asks for anything that can write, execute arbitrary code, or hide syntax", () => {
    for (const cmd of [
      "git commit -m x",
      "git push",
      "git branch feature",
      "git branch -l -D main",
      "git tag v1.0",
      "git tag -a v1.0",
      "git tag -l -d v1.0",
      "git remote add origin https://example.com/a.git",
      "git -c core.pager=sh log",
      "git -ccore.pager=sh log",
      "git --work-tree=/tmp status",
      "git diff --output=x.patch",
      "git diff --output x.patch",
      "git grep -O sh foo",
      "git grep -nO sh foo",
      "GIT_PAGER=sh git log",
      "GIT_EXTERNAL_DIFF=/tmp/x git diff",
      "LD_PRELOAD=/tmp/x.so ls",
      "cat a > b",
      "cat a >/dev/null.txt",
      'echo "x\'" > /tmp/pwned; echo "\'y"',
      'echo "a\\" > /tmp/pwned"',
      "echo $(rm -rf /)",
      "echo ${HOME}",
      "echo `id`",
      "(rm -rf /)",
      "sed -i 's/a/b/' x",
      "sed -n -i '1,5p' src/app.ts",
      "sed -n '1,5p' src/app.ts -i",
      "sed -n -- '-e w out' '1,5p'",
      "sed -n -e '1p' -e '1w out' src/app.ts",
      "sed -n '1p;w out' x",
      "rg --pre sh foo",
      "rg --pre=sh foo",
      "find . -delete",
      "find . -exec rm {} ;",
      "rm -rf dist",
      "npm test",
      "ls & rm x",
      "ls |& head",
      "cat 'unclosed",
      "gh api -X POST repos/x/y/issues",
      "sort -o out in",
      "sort -uo out in",
      "sort --compress-program=sh a.txt",
      "tree -ao out.txt",
      "uniq in.txt out.txt",
      "file -C",
      "file -bC",
      "bash -lc 'git status' && rm -rf / && echo 'x'",
    ]) {
      expect(readOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  it("asks when another spelling hides a command, a write or a program of the project", () => {
    for (const cmd of [
      // `\'` is a plain quote in bash: what follows it is not inside quotes.
      "echo \\' ; rm -rf x ; echo \\'",
      "ls \\; rm x",
      // Long options are taken shortened.
      "sort --out=x a.txt",
      "sort --o x a.txt",
      "sort --compress-prog=sh a.txt",
      "git grep --open-files-in=sh foo",
      "file --comp",
      "rg --hostname-bin ./x --hyperlink-format 'file://{host}{path}' foo",
      // A file of the project named like a program that reads.
      "./cat README.md",
      "scripts/diff a b",
      "/tmp/x/ls",
      "x\\cat a",
      // PowerShell runs a block given to a command that reads.
      "Get-ChildItem | Sort-Object { Remove-Item $_ -Force }",
      "dir | Sort-Object {Remove-Item x}",
    ]) {
      expect(readOnlyCommand(cmd), cmd).toBe(false);
    }
    for (const cmd of [
      "Get-Content apps\\web\\src\\a.ts",
      "/usr/bin/git status",
      "git log --oneline | sort -r",
      "rg -n foo src",
    ]) {
      expect(readOnlyCommand(cmd), cmd).toBe(true);
    }
    const call = (rawInput: unknown) => ({
      toolCallId: "x",
      title: "t",
      kind: "execute" as const,
      rawInput,
    });
    // The shell reads a file of its own before the script, or runs another one.
    expect(readOnlyCall(call({ command: ["bash", "--rcfile", "rc", "-i", "-c", "ls"] }))).toBe(
      false,
    );
    expect(readOnlyCall(call({ command: ["pwsh", "-File", "x.ps1", "-Command", "ls"] }))).toBe(
      false,
    );
    expect(readOnlyCall(call({ command: ["pwsh", "-NoProfile", "-Command", "ls"] }))).toBe(true);
    // The arguments sent apart from the program count as much as it.
    expect(readOnlyCall(call({ command: "find", args: [".", "-delete"] }))).toBe(false);
    expect(readOnlyCall(call({ command: "find", args: [".", "-name", "a.ts"] }))).toBe(true);
    expect(grantKeys(call({ command: "git", args: ["push"] }))).toEqual(["execute:git push"]);
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
    // A command of an unknown shape is not taken at its title, which may read as one that reads.
    for (const rawInput of [
      { command: { argv: ["rm", "-rf", "/"] } },
      { command: ["rm", 1] },
      { cmd: 5 },
      { args: ["-rf", "/"] },
    ]) {
      expect(commandOf(call(rawInput, "git log")), JSON.stringify(rawInput)).toBeUndefined();
      expect(readOnlyCall(call(rawInput, "git log")), JSON.stringify(rawInput)).toBe(false);
    }
    // Never unwrap across embedded quotes into trailing chained commands.
    expect(readOnlyCall(call({ command: "bash -lc 'git status' && rm -rf / && echo 'x'" }))).toBe(
      false,
    );
    expect(readOnlyCall(call({ command: ["bash", "-lc", "git log -3"] }))).toBe(true);
    expect(readOnlyCall({ toolCallId: "r", title: "Lire", kind: "read" })).toBe(true);
    expect(readOnlyCall({ toolCallId: "e", title: "Modifier", kind: "edit" })).toBe(false);
  });

  it("remembers grants across every non-read-only segment and rejects unsafe shell syntax", () => {
    const run = (command: string) => ({
      toolCallId: "x",
      title: command,
      kind: "execute" as const,
      rawInput: { command },
    });
    expect(grantKey(run("npm test"))).toBe("execute:npm test");
    expect(grantKey(run("npm test -- --run"))).toBe("execute:npm test");
    expect(grantKey(run("npm run lint"))).toBe("execute:npm run lint");
    expect(grantKey(run("cargo build --release"))).toBe("execute:cargo");
    expect(grantKey({ toolCallId: "e", title: "Modifier a.ts", kind: "edit" })).toBe("edit");
    expect(grantKey({ toolCallId: "o", title: "Run thing", kind: "other" }, "mcp__x__y")).toBe(
      "other:mcp__x__y",
    );

    // Leading read-only commands (`cd`) do not become the grant key.
    expect(grantKeys(run("cd apps/web && npm test"))).toEqual(["execute:npm test"]);
    // Chaining a second command requires a grant for BOTH segments (`npm test` does not cover `rm`).
    expect(grantKeys(run("npm test && rm -rf /"))).toEqual(["execute:npm test", "execute:rm"]);
    // `git -C` skips the directory argument so the subcommand is the real one.
    expect(grantKeys(run("git -C ../repo push --force"))).toEqual(["execute:git push"]);
    // Redirections, substitutions, env overrides and raw shell wrappers are never blanket-granted.
    expect(grantKeys(run("npm test > out.txt"))).toBeUndefined();
    expect(grantKeys(run("npm test && echo $(id)"))).toBeUndefined();
    expect(grantKeys(run("GIT_PAGER=sh git push"))).toBeUndefined();
    expect(grantKeys(run("bash script.sh"))).toBeUndefined();
    expect(grantKeys(run("sudo rm -rf /"))).toBeUndefined();
  });

  it("auto-approves only edits whose every named path stays inside the thread folder", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "moon-edits-"));
    tempDirs.push(base);
    const work = path.join(base, "work");
    const outside = path.join(base, "work-evil");
    mkdirSync(path.join(work, "src"), { recursive: true });
    mkdirSync(path.join(work, ".git", "hooks"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(work, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(path.join(outside, "secret.txt"), "nope\n");
    symlinkSync(
      outside,
      path.join(work, "escape-dir"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let hasFileSymlink = false;
    try {
      symlinkSync(path.join(outside, "secret.txt"), path.join(work, "src", "escape-file.ts"));
      hasFileSymlink = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    const edit = (patch: Partial<Parameters<typeof editInsideFolder>[0]> = {}) => ({
      toolCallId: "e",
      title: "Modifier",
      kind: "edit" as const,
      ...patch,
    });

    // Valid edits inside the folder (relative, absolute, new nested file, locations, Codex changes, diff content, file:// URI).
    expect(editInsideFolder(edit({ rawInput: { file_path: "src/app.ts" } }), work)).toBe(true);
    expect(
      editInsideFolder(edit({ rawInput: { file_path: path.join(work, "src", "app.ts") } }), work),
    ).toBe(true);
    expect(editInsideFolder(edit({ rawInput: { file_path: "src/new/deep/file.ts" } }), work)).toBe(
      true,
    );
    expect(editInsideFolder(edit({ locations: [{ path: "src/app.ts" }] }), work)).toBe(true);
    expect(
      editInsideFolder(
        edit({ rawInput: { changes: { "src/app.ts": {}, "src/other.ts": {} } } }),
        work,
      ),
    ).toBe(true);
    expect(
      editInsideFolder(
        edit({ content: [{ type: "diff", path: "src/app.ts", newText: "x" }] }),
        work,
      ),
    ).toBe(true);
    expect(
      editInsideFolder(
        edit({ rawInput: { uri: pathToFileURL(path.join(work, "src", "app.ts")).href } }),
        work,
      ),
    ).toBe(true);
    expect(
      editInsideFolder(
        edit({
          rawInput: {
            file_path: "src/app.ts",
            edits: [{ old_string: "1", new_string: "2" }],
          },
        }),
        work,
      ),
    ).toBe(true);

    // Rejects escapes, symlinks, `.git`, missing paths, mixed good+bad payloads, and non-edit kinds.
    expect(
      editInsideFolder(edit({ rawInput: { file_path: "../work-evil/secret.txt" } }), work),
    ).toBe(false);
    expect(
      editInsideFolder(edit({ rawInput: { file_path: path.join(outside, "secret.txt") } }), work),
    ).toBe(false);
    if (hasFileSymlink) {
      expect(editInsideFolder(edit({ rawInput: { file_path: "src/escape-file.ts" } }), work)).toBe(
        false,
      );
    }
    expect(editInsideFolder(edit({ rawInput: { file_path: "escape-dir/new.ts" } }), work)).toBe(
      false,
    );
    expect(editInsideFolder(edit({ rawInput: { file_path: ".git/hooks/pre-push" } }), work)).toBe(
      false,
    );
    expect(editInsideFolder(edit({ rawInput: { file_path: ".git/config" } }), work)).toBe(false);
    expect(editInsideFolder(edit({ rawInput: { file_path: "." } }), work)).toBe(false);
    expect(editInsideFolder(edit({ rawInput: { file_path: "src/a.ts\0.txt" } }), work)).toBe(false);
    expect(editInsideFolder(edit({}), work)).toBe(false);
    expect(
      editInsideFolder(edit({ rawInput: { patch: "*** Update File: src/app.ts" } }), work),
    ).toBe(false);
    // A valid location cannot hide an outside path in rawInput.
    expect(
      editInsideFolder(
        edit({
          locations: [{ path: "src/app.ts" }],
          rawInput: { file_path: path.join(outside, "secret.txt") },
        }),
        work,
      ),
    ).toBe(false);
    // Non-edit kinds never pass here.
    expect(
      editInsideFolder(
        {
          toolCallId: "x",
          title: "Run",
          kind: "execute",
          locations: [{ path: "src/app.ts" }],
          rawInput: { command: "rm -rf src/app.ts" },
        },
        work,
      ),
    ).toBe(false);
    expect(
      editInsideFolder(
        {
          toolCallId: "d",
          title: "Delete",
          kind: "delete",
          locations: [{ path: "src/app.ts" }],
        },
        work,
      ),
    ).toBe(false);
    expect(editInsideFolder(edit({ rawInput: { file_path: "src/app.ts" } }), undefined)).toBe(
      false,
    );
  });
});
