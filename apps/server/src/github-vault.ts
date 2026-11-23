import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GithubVault } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";

/** Where MoonAgentic keeps its GitHub sign-in. Nothing here ever logs or returns it elsewhere. */
export interface TokenVault {
  readonly kind: GithubVault;
  read(): Promise<string | undefined>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

const VAULT_TIMEOUT_MS = 20_000;
/** Names the secret in the macOS keychain and the Linux secret service. */
const SERVICE = "MoonAgentic";
const ACCOUNT = "github";

/** Runs a command with `input` on its standard input: secrets never go on a command line. */
function pipe(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: VAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim().split("\n")[0] || error.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

/** A file only its owner reads, in MoonAgentic's private data folder. */
export function fileVault(file: string): TokenVault {
  return {
    kind: "file",
    read: async () => {
      if (!existsSync(file)) return undefined;
      return readFileSync(file, "utf8").trim() || undefined;
    },
    write: async (token) => {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, token, { mode: 0o600 });
    },
    clear: async () => rmSync(file, { force: true }),
  };
}

/** PowerShell run without profile, with the script passed in a form no shell rereads. */
function powershell(script: string, input: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // By its full path: a `powershell.exe` earlier on PATH would be handed the token.
  const exe = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return pipe(
    exe,
    [
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    input,
  );
}

const DPAPI =
  "Add-Type -AssemblyName System.Security;$e=[Text.Encoding]::UTF8.GetBytes('MoonAgentic');";

/**
 * Sealed with the user's Windows account (DPAPI): the file is useless to anyone else, even an
 * administrator copying it to another machine or account.
 */
export function windowsVault(file: string): TokenVault {
  return {
    kind: "windows",
    read: async () => {
      if (!existsSync(file)) return undefined;
      const sealed = readFileSync(file, "utf8").trim();
      if (!sealed) return undefined;
      const out = await powershell(
        `${DPAPI}$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
          "[Console]::Out.Write([Text.Encoding]::UTF8.GetString(" +
          "[Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')))",
        sealed,
      );
      return out.trim() || undefined;
    },
    write: async (token) => {
      const sealed = await powershell(
        `${DPAPI}$t=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd().Trim());` +
          "[Console]::Out.Write([Convert]::ToBase64String(" +
          "[Security.Cryptography.ProtectedData]::Protect($t,$e,'CurrentUser')))",
        token,
      );
      if (!sealed.trim()) throw new Error("Windows n'a pas pu chiffrer la connexion GitHub.");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, sealed.trim(), { mode: 0o600 });
    },
    clear: async () => rmSync(file, { force: true }),
  };
}

/** The macOS keychain, through `security`, fed on its standard input. */
export function macosVault(): TokenVault {
  return {
    kind: "macos",
    read: async () => {
      try {
        const out = await pipe(
          "security",
          ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
          "",
        );
        return out.trim() || undefined;
      } catch {
        return undefined; // none kept
      }
    },
    write: async (token) => {
      // A token is letters, digits and `_`: nothing to quote.
      if (!/^[A-Za-z0-9_]+$/.test(token)) throw new Error("Jeton GitHub inattendu.");
      await pipe(
        "security",
        ["-i"],
        `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${token}\n`,
      );
    },
    clear: async () => {
      await pipe("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], "").catch(
        () => {},
      );
    },
  };
}

/** The Linux secret service (GNOME Keyring, KWallet), through `secret-tool`. */
export function linuxVault(secretTool: string): TokenVault {
  const attrs = ["service", SERVICE.toLowerCase(), "account", ACCOUNT];
  return {
    kind: "linux",
    read: async () => {
      try {
        return (await pipe(secretTool, ["lookup", ...attrs], "")).trim() || undefined;
      } catch {
        return undefined;
      }
    },
    write: async (token) => {
      await pipe(secretTool, ["store", `--label=${SERVICE} GitHub`, ...attrs], token);
    },
    clear: async () => {
      await pipe(secretTool, ["clear", ...attrs], "").catch(() => {});
    },
  };
}

/**
 * The vault this system offers, with a file in the data folder as the last resort: a Linux
 * server without a desktop session has no secret service to talk to.
 */
export function systemVault(dataDir: string, platform = process.platform): TokenVault {
  const file = fileVault(path.join(dataDir, "github-token"));
  if (platform === "win32") return windowsVault(path.join(dataDir, "github-token.dpapi"));
  if (platform === "darwin") return macosVault();
  const secretTool = findOnPath("secret-tool");
  if (!secretTool || !process.env.DBUS_SESSION_BUS_ADDRESS) return file;
  const linux = linuxVault(secretTool);
  // When the secret service refuses to store it, the file keeps it, and says so.
  let kind: GithubVault = "linux";
  return {
    get kind() {
      return kind;
    },
    read: async () => (await linux.read()) ?? (await file.read()),
    write: async (token) => {
      try {
        await linux.write(token);
        kind = "linux";
        await file.clear();
      } catch {
        kind = "file";
        await file.write(token);
      }
    },
    clear: async () => {
      await linux.clear();
      await file.clear();
    },
  };
}
