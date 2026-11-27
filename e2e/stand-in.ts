import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in for a command-line tool (`gh`, `tailscale`), put in `bin`: `script` is Node code,
 * run with the tool's arguments. A POSIX system runs it through a shell script; Windows starts
 * a tool only as an `.exe` (the server never takes a `.cmd` as `gh`, which cmd.exe would read
 * as a script), so there it is a small launcher, compiled once with the C# compiler that every
 * Windows has, which runs the script beside it with this Node.
 */
export function standIn(bin: string, name: string, script: string): void {
  mkdirSync(bin, { recursive: true });
  const code = path.join(bin, `${name}.mjs`);
  writeFileSync(code, script);
  if (process.platform === "win32") {
    copyFileSync(launcher(), path.join(bin, `${name}.exe`));
    return;
  }
  const file = path.join(bin, name);
  writeFileSync(
    file,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(code)} "$@"\n`,
  );
  chmodSync(file, 0o755);
}

/**
 * The launcher: it runs `<its name>.mjs` with this Node, passing its own command line on as
 * it came (Node and the launcher split it by the same rules), and ends with the script's code.
 */
function launcher(): string {
  const node = process.execPath;
  const source = `using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

static class StandIn {
  static int Main() {
    string self = Assembly.GetEntryAssembly().Location;
    string script = Path.ChangeExtension(self, ".mjs");
    string line = Environment.CommandLine;
    int i = 0;
    if (line.StartsWith("\\"")) {
      i = line.IndexOf('"', 1);
      i = i < 0 ? line.Length : i + 1;
    } else {
      while (i < line.Length && line[i] != ' ' && line[i] != '\\t') i++;
    }
    var start = new ProcessStartInfo(@"${node.replaceAll('"', '""')}", "\\"" + script + "\\"" + line.Substring(i));
    start.UseShellExecute = false;
    using (var run = Process.Start(start)) {
      run.WaitForExit();
      return run.ExitCode;
    }
  }
}
`;
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const exe = path.join(os.tmpdir(), `moonagentic-stand-in-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const work = path.join(os.tmpdir(), `moonagentic-stand-in-${hash}-${process.pid}`);
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "stand-in.cs"), source);
  const csc = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  execFileSync(csc, ["/nologo", "/out:stand-in.exe", "stand-in.cs"], { cwd: work, stdio: "pipe" });
  try {
    // Test files start side by side: the first one to finish puts it in place.
    renameSync(path.join(work, "stand-in.exe"), exe);
  } catch (error) {
    if (!existsSync(exe)) throw error;
  }
  return exe;
}
