// What MoonAgentic changes in Hermes Agent's own setup, through Hermes's own commands rather
// than by editing its files: `hermes config set` writes `config.yaml` with the rest of the
// file kept as it is, and `hermes gateway restart` makes the Discord gateway read it again.
// Checked against Hermes's documentation (cli-commands.md, `hermes config` and `hermes
// gateway`) and its ACP adapter (`acp_adapter/model_catalog.py`, model ids `provider:model`).
import { execFile } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { spawnPlan } from "./spawn.ts";

/** What one Hermes command answered. */
export interface HermesRun {
  code: number;
  out: string;
  err: string;
}

/** Runs `hermes <args>`, never through a shell. */
export type HermesRunner = (args: string[], timeoutMs: number) => Promise<HermesRun>;

const COMMAND_MS = 60_000;
/** A gateway restart waits for Hermes's chats to stop, then for the gateway to start again. */
const RESTART_MS = 180_000;
/** Where a copy of `config.yaml` is kept before MoonAgentic changes it. */
export const BACKUP_SUFFIX = ".avant-moonagentic";

export function hermesRunner(
  command: string,
  platform: NodeJS.Platform = process.platform,
): HermesRunner {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      let plan;
      try {
        plan = spawnPlan(command, args, platform);
      } catch (error) {
        // A `.cmd` on Windows takes no JSON or spaces: the lines are then copied by hand.
        resolve({
          code: 1,
          out: "",
          err: `MoonAgentic ne peut pas passer ce réglage à ${command} (${
            error instanceof Error ? error.message : String(error)
          }) : copie le réglage dans config.yaml.`,
        });
        return;
      }
      execFile(
        plan.command,
        plan.args,
        {
          windowsHide: true,
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          // Hermes's own messages, in UTF-8 even on Windows.
          env: { ...process.env, PYTHONIOENCODING: "utf-8", NO_COLOR: "1" },
        },
        (error, out, err) => {
          if (error && (error as { killed?: boolean }).killed) {
            resolve({
              code: 124,
              out: String(out),
              err: `Erreur : délai dépassé, Hermes n'a pas répondu en ${Math.round(timeoutMs / 1000)} s.`,
            });
            return;
          }
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({
            code,
            out: String(out),
            err: String(err) || (error && code === 1 ? error.message : ""),
          });
        },
      );
    });
}

const COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The last meaningful line Hermes wrote, to say why a command failed. */
export function reason(run: HermesRun): string {
  // Colours, when Hermes still adds them.
  const plain = `${run.err}\n${run.out}`.replace(COLOURS, "");
  const lines = plain
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^(✗|error|erreur)/i.test(l)) ?? lines.at(-1);
  return (line ?? `code ${run.code}`).slice(0, 400);
}

/**
 * A model as Hermes's ACP adapter lists it, `provider:model`, split as Hermes does: a named
 * custom endpoint is `custom:<name>`, anything else is cut at the first colon.
 */
export function splitModel(id: string): { provider?: string; model: string } {
  const text = id.trim();
  const named = /^(custom:[^:]+):(.+)$/i.exec(text);
  if (named) return { provider: named[1]!.toLowerCase(), model: named[2]! };
  const colon = text.indexOf(":");
  if (colon > 0 && colon < text.length - 1) {
    return { provider: text.slice(0, colon).toLowerCase(), model: text.slice(colon + 1) };
  }
  return { model: text };
}

/** Hermes's `model:` section as `hermes config get model --json` prints it. */
export function modelOf(printed: string): { provider?: string; model: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(printed.trim());
  } catch {
    return undefined;
  }
  // An old config has the model as a plain string.
  if (typeof value === "string" && value.trim()) return { model: value.trim() };
  if (typeof value !== "object" || value === null) return undefined;
  const section = value as Record<string, unknown>;
  // Hermes reads both `default` and `model`.
  const model = [section.default, section.model].find(
    (v): v is string => typeof v === "string" && !!v.trim(),
  );
  if (!model) return undefined;
  const provider =
    typeof section.provider === "string" && section.provider.trim() && section.provider !== "auto"
      ? section.provider.trim()
      : undefined;
  return { ...(provider ? { provider } : {}), model: model.trim() };
}

/** What reading `mcp_servers.moonagentic` from Hermes's `config.yaml` gave. */
export type InstalledEntry =
  { state: "found"; entry: Record<string, unknown> } | { state: "missing" } | { state: "unknown" };

/** Hermes's own setup, changed with its commands. */
export class HermesCli {
  private readonly run: HermesRunner;
  constructor(run: HermesRunner) {
    this.run = run;
  }

  private async must(args: string[], timeoutMs = COMMAND_MS): Promise<HermesRun> {
    const done = await this.run(args, timeoutMs);
    if (done.code !== 0) throw new Error(`hermes ${args[0]} ${args[1]} : ${reason(done)}`);
    return done;
  }

  /** Keeps a copy of `config.yaml` as it was before MoonAgentic first changed it. */
  async backup(): Promise<string | undefined> {
    const file = (await this.must(["config", "path"])).out.trim().split(/\r?\n/).at(-1)?.trim();
    if (!file || !existsSync(file)) return undefined;
    const copy = `${file}${BACKUP_SUFFIX}`;
    if (!existsSync(copy)) copyFileSync(file, copy);
    return copy;
  }

  /** Writes MoonAgentic's entry under `mcp_servers`, replacing the one already there. */
  async install(entry: Record<string, unknown>): Promise<void> {
    await this.backup();
    await this.must(["config", "set", "mcp_servers.moonagentic", JSON.stringify(entry)]);
    // A Hermes from before August 2026 writes the JSON as a string, which it cannot use.
    const written = (await this.must(["config", "get", "mcp_servers.moonagentic", "--json"])).out;
    let value: unknown;
    try {
      value = JSON.parse(written.trim());
    } catch {
      value = undefined;
    }
    if (typeof value !== "object" || value === null || !("command" in value)) {
      throw new Error("Hermes trop ancien pour ce réglage : mets-le à jour (hermes update).");
    }
  }

  /**
   * MoonAgentic's entry as Hermes's `config.yaml` has it now: `missing` when the key is unset
   * or holds a non-object value (like an older Hermes's string), `unknown` when `hermes` itself
   * failed or timed out so callers do not overwrite a working config.
   */
  async installed(): Promise<InstalledEntry> {
    const done = await this.run(["config", "get", "mcp_servers.moonagentic", "--json"], COMMAND_MS);
    if (done.code !== 0) {
      return done.code === 1 &&
        /\b(not set|not found|does not exist)\b/i.test(`${done.err}\n${done.out}`)
        ? { state: "missing" }
        : { state: "unknown" };
    }
    try {
      const value: unknown = JSON.parse(done.out.trim());
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { state: "found", entry: value as Record<string, unknown> }
        : { state: "missing" };
    } catch {
      return { state: "unknown" };
    }
  }

  /**
   * Restarts the gateway, even while it works: it was asked for from MoonAgentic. Without a
   * gateway service installed, `--detach` starts it in the background, as Hermes's desktop
   * app does, rather than as this command, which would never end.
   */
  async restart(): Promise<void> {
    await this.must(["gateway", "restart", "--yes", "--detach"], RESTART_MS);
  }

  /**
   * Finds Hermes's gateway, or starts it when none runs (`hermes gateway ensure`, which never
   * replaces a gateway already there). Ready, or why not.
   */
  async ensureGateway(): Promise<{ running: boolean; reason?: string }> {
    const done = await this.run(["gateway", "ensure", "--json", "--timeout", "60"], 90_000);
    if (done.code === 0) return { running: true };
    let said: Record<string, unknown> = {};
    try {
      said = JSON.parse(done.out.trim().split(/\r?\n/).at(-1) ?? "") as Record<string, unknown>;
    } catch {
      // Not JSON: its last line says why.
    }
    const text = [said.message, said.reason_code, said.state].find(
      (v): v is string => typeof v === "string" && !!v.trim(),
    );
    return { running: false, reason: (text ?? reason(done)).slice(0, 300) };
  }

  async model(): Promise<{ provider?: string; model: string } | undefined> {
    return modelOf((await this.must(["config", "get", "model", "--json"])).out);
  }

  /** Sets the default model; the provider first, which clears another provider's endpoint. */
  async setModel(id: string): Promise<void> {
    const { provider, model } = splitModel(id);
    await this.backup();
    if (provider) await this.must(["config", "set", "model.provider", provider]);
    await this.must(["config", "set", "model.default", model]);
  }
}
