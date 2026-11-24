// Looks for a newer MoonAgentic among the versions published on GitHub, and on Windows
// downloads its installer in the background, checked against the release's SHA256SUMS.txt.
// Nothing is installed from here unless the server asks, once the user said so.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

export const REPO = "Moon-ItachiDEV/MoonAgentic";
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Where a release's files are downloaded from, and nowhere else. */
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
const SUMS = "SHA256SUMS.txt";
/** An installer larger than this is not one of ours. */
export const MAX_INSTALLER_BYTES = 1024 ** 3;
const MAX_NOTES = 20;
const ASK_TIMEOUT_MS = 30_000;
/** A download that stalls this long gives up, to be tried again at the next look. */
const STALL_MS = 60_000;

export interface UpdateNote {
  title: string;
  number?: number;
}

/** What the shell reports of its look for a newer version; see `AppUpdate` on the server. */
export interface ShellUpdate {
  state: "none" | "checking" | "downloading" | "ready" | "available" | "failed";
  checkedAt?: number;
  version?: string;
  size?: number;
  progress?: number;
  notes?: UpdateNote[];
  url?: string;
  error?: string;
}

interface Asset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  version: string;
  page: string;
  notes: UpdateNote[];
  assets: Asset[];
}

/** `v0.1.5` or `0.1.5` as numbers; undefined for anything else. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** True when `candidate` comes after `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return false;
}

/**
 * The pull requests a release's notes list, as GitHub writes them
 * (`* Title by @someone in https://github.com/…/pull/130`); other list lines as they are.
 */
export function parseNotes(body: string): UpdateNote[] {
  const notes: UpdateNote[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = /^\s*[*-]\s+(.+?)\s*$/.exec(line)?.[1];
    if (!item || item.startsWith("**Full Changelog**")) continue;
    const pr = /^(.+?)\s+by\s+@\S+\s+in\s+https:\/\/github\.com\/\S+\/pull\/(\d+)$/.exec(item);
    const title = (pr ? pr[1]! : item).slice(0, 300);
    notes.push(pr ? { title, number: Number(pr[2]) } : { title });
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

/** The release GitHub describes, keeping only files downloaded from its own address. */
export function readRelease(json: unknown): Release | undefined {
  if (!json || typeof json !== "object") return undefined;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return undefined;
  const tag = typeof r.tag_name === "string" ? r.tag_name : "";
  const version = parseVersion(tag)?.join(".");
  if (!version) return undefined;
  const page =
    typeof r.html_url === "string" && r.html_url.startsWith(`https://github.com/${REPO}/`)
      ? r.html_url
      : `https://github.com/${REPO}/releases`;
  const assets: Asset[] = [];
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    const { name, browser_download_url: url, size } = (a ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !/^[\w.-]+$/.test(name)) continue;
    if (typeof url !== "string" || !url.startsWith(DOWNLOADS)) continue;
    if (typeof size !== "number" || size < 0) continue;
    assets.push({ name, url, size });
  }
  return { version, page, notes: parseNotes(typeof r.body === "string" ? r.body : ""), assets };
}

/** The installer of a release for this computer: Windows only, the others update by hand. */
export const installerOf = (release: Release, platform: NodeJS.Platform) =>
  platform === "win32"
    ? release.assets.find((a) => a.name.endsWith("-windows-x64.exe"))
    : undefined;

/** The SHA-256 a `sha256sum` listing gives a file, in lower case. */
export function sumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return undefined;
}

/**
 * What the installer is started with: silent (no wizard on a computer nobody looks at), in
 * the folder MoonAgentic is installed in, then MoonAgentic started again. `/D=` comes last
 * and unquoted, as NSIS wants it.
 */
export const installerArgs = (installDir: string) => [
  "--updated",
  "/S",
  "--force-run",
  `/D=${installDir}`,
];

/**
 * How the installer is spawned on Windows. Node would put `/D=` between quotes when the
 * folder holds a space (« C:\Users\Prénom Nom\… »), and NSIS then ignores it: the command
 * line is written as is. Only the installer's own path is quoted, so the installer still
 * finds where its arguments start.
 */
export function installerSpawn(installer: string, installDir: string) {
  return {
    file: installer,
    args: installerArgs(installDir),
    options: {
      argv0: `"${installer}"`,
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore" as const,
    },
  };
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface UpdaterOptions {
  current: string;
  platform: NodeJS.Platform;
  /** Where installers are downloaded; only the latest one stays. */
  dir: string;
  onState: (state: ShellUpdate) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

export class Updater {
  private readonly options: UpdaterOptions;
  private readonly fetch: typeof fetch;
  private current: ShellUpdate = { state: "none" };
  private running: Promise<void> | undefined;
  /** The installer downloaded and checked, for the version it is ready with. */
  private file: string | undefined;

  constructor(options: UpdaterOptions) {
    this.options = options;
    this.fetch = options.fetch ?? fetch;
  }

  get state(): ShellUpdate {
    return this.current;
  }

  /** The installer ready to run, when there is one. */
  get installer(): string | undefined {
    return this.current.state === "ready" ? this.file : undefined;
  }

  /** Looks once; a look under way is not started again. */
  check(): Promise<void> {
    this.running ??= this.look().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Says why installing could not go on, keeping what was found. */
  fail(error: string): void {
    this.set({ ...this.current, state: "failed", error });
  }

  private set(state: ShellUpdate): void {
    this.current = state;
    this.options.onState(state);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async ask(url: string): Promise<Response> {
    const res = await this.fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "MoonAgentic" },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    return res;
  }

  private async look(): Promise<void> {
    const was = this.current;
    // A version ready stays ready while the next look goes on: it can be installed meanwhile.
    const ready = was.state === "ready";
    if (!ready) this.set({ ...was, state: "checking" });
    let release: Release | undefined;
    try {
      const res = await this.ask(LATEST);
      // No release published yet.
      if (res.status === 404) return this.set({ state: "none", checkedAt: this.now() });
      if (!res.ok) throw new Error(`GitHub a répondu ${res.status}.`);
      release = readRelease(await res.json());
      if (!release) throw new Error("La dernière version publiée n'est pas lisible.");
    } catch (error) {
      if (ready) return this.set({ ...was, checkedAt: this.now() });
      return this.set({ ...was, state: "failed", checkedAt: this.now(), error: describe(error) });
    }
    if (!isNewer(release.version, this.options.current)) {
      this.clean();
      return this.set({ state: "none", checkedAt: this.now() });
    }
    const found: ShellUpdate = {
      state: "available",
      checkedAt: this.now(),
      version: release.version,
      notes: release.notes,
      url: release.page,
    };
    const installer = installerOf(release, this.options.platform);
    // macOS: an unsigned app cannot replace itself. The page to download it from is given.
    if (!installer) return this.set(found);
    try {
      await this.download(release, installer, found);
    } catch (error) {
      this.set({ ...found, state: "failed", size: installer.size, error: describe(error) });
    }
  }

  private async download(release: Release, installer: Asset, found: ShellUpdate) {
    if (installer.size > MAX_INSTALLER_BYTES) throw new Error("L'installeur publié est trop gros.");
    const sums = release.assets.find((a) => a.name === SUMS);
    if (!sums) throw new Error(`La version ${release.version} n'a pas d'empreinte publiée.`);
    const sumsRes = await this.ask(sums.url);
    if (!sumsRes.ok) throw new Error(`Empreintes introuvables (${sumsRes.status}).`);
    const expected = sumFor((await sumsRes.text()).slice(0, 64 * 1024), installer.name);
    if (!expected) throw new Error(`Aucune empreinte pour ${installer.name}.`);
    const { dir } = this.options;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, installer.name);
    const base = { ...found, size: installer.size };
    // Already downloaded at an earlier look: checked again rather than fetched again.
    if (
      await sha256Of(file).then(
        (h) => h === expected,
        () => false,
      )
    ) {
      this.file = file;
      this.clean(installer.name);
      return this.set({ ...base, state: "ready" });
    }
    this.clean();
    this.set({ ...base, state: "downloading", progress: 0 });
    const partial = `${file}.part`;
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), STALL_MS);
    try {
      const res = await this.fetch(installer.url, {
        headers: { "user-agent": "MoonAgentic" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Téléchargement refusé (${res.status}).`);
      const hash = createHash("sha256");
      const out = createWriteStream(partial);
      let got = 0;
      let shown = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(stall);
          stall = setTimeout(() => controller.abort(), STALL_MS);
          got += chunk.length;
          if (got > installer.size) throw new Error("L'installeur reçu est plus gros que prévu.");
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
          const progress = installer.size ? got / installer.size : 0;
          if (progress - shown >= 0.02) {
            shown = progress;
            this.set({ ...base, state: "downloading", progress });
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          out.end((error?: Error | null) => (error ? reject(error) : resolve())),
        );
      }
      if (got !== installer.size) throw new Error("Le téléchargement s'est arrêté avant la fin.");
      if (hash.digest("hex") !== expected) {
        throw new Error("L'empreinte de l'installeur ne correspond pas : il n'est pas gardé.");
      }
      renameSync(partial, file);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    } finally {
      clearTimeout(stall);
    }
    this.file = file;
    this.set({ ...base, state: "ready" });
  }

  /** Removes the installers kept, but the one named. */
  private clean(keep?: string): void {
    try {
      for (const name of readdirSync(this.options.dir)) {
        if (name !== keep) rmSync(path.join(this.options.dir, name), { force: true });
      }
    } catch {
      // No folder yet.
    }
    if (!keep) this.file = undefined;
  }
}
