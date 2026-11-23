import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RemoteAccess, RemoteAddress } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";

const ASK_TIMEOUT_MS = 5_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const EVERYWHERE = new Set(["0.0.0.0", "::"]);

/** What `tailscale status --json` says of this machine. */
export interface TailscaleState {
  running: boolean;
  /** The machine's name on the network, when MagicDNS gives it one. */
  name?: string;
  ips: string[];
}

/** What Tailscale told us, or `undefined` when it is not installed. */
export interface TailscaleProbe {
  state: TailscaleState;
  /** The addresses `tailscale serve` publishes MoonAgentic's port at. */
  served: RemoteAddress[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function parseTailscaleStatus(json: string): TailscaleState {
  const status = parseJson(json);
  const self = isRecord(status) && isRecord(status.Self) ? status.Self : {};
  const name = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === "string")
    : [];
  return {
    running: isRecord(status) && status.BackendState === "Running",
    ...(name ? { name } : {}),
    ips,
  };
}

/** True when a `tailscale serve` target is this machine's own `port`, over plain HTTP. */
function proxiesTo(target: unknown, port: number): boolean {
  if (typeof target !== "string") return false;
  // Tailscale also accepts a bare port, or `host:port`, for an HTTP target.
  const address = /^\d+$/.test(target)
    ? `http://127.0.0.1:${target}`
    : target.includes("://")
      ? target
      : `http://${target}`;
  try {
    const url = new URL(address);
    // An address leaves out the port when it is the protocol's own: 80 for plain HTTP.
    return (
      url.protocol === "http:" && LOOPBACK.has(url.hostname) && Number(url.port || 80) === port
    );
  } catch {
    return false;
  }
}

/**
 * The HTTPS addresses `tailscale serve status --json` publishes `port` at. Only a site's
 * root counts: the app's own addresses start at `/`. A `serve` left running in a terminal
 * is listed under `Foreground`, one started with `--bg` at the top.
 */
export function parseTailscaleServe(json: string, port: number): RemoteAddress[] {
  const config = parseJson(json);
  if (!isRecord(config)) return [];
  const configs = [
    config,
    ...(isRecord(config.Foreground) ? Object.values(config.Foreground) : []),
  ];
  const found = new Map<string, RemoteAddress>();
  for (const one of configs) {
    if (!isRecord(one) || !isRecord(one.Web)) continue;
    const funnel = isRecord(one.AllowFunnel) ? one.AllowFunnel : {};
    for (const [site, web] of Object.entries(one.Web)) {
      const handlers = isRecord(web) && isRecord(web.Handlers) ? web.Handlers : {};
      const root = handlers["/"];
      if (!isRecord(root) || !proxiesTo(root.Proxy, port)) continue;
      // Without TLS on that port, the site is served over plain HTTP inside the tunnel.
      const sitePort = site.slice(site.lastIndexOf(":") + 1);
      const tcp = isRecord(one.TCP) && isRecord(one.TCP[sitePort]) ? one.TCP[sitePort] : {};
      const https = tcp.HTTPS === true;
      const host = site.replace(https ? /:443$/ : /:80$/, "");
      const url = `${https ? "https" : "http"}://${host}`;
      found.set(url, {
        kind: https ? "tailscale-https" : "tailscale",
        url,
        ...(funnel[site] === true ? { public: true } : {}),
      });
    }
  }
  return [...found.values()];
}

/** Where Tailscale's CLI lives: its Windows and macOS installers do not always put it on the PATH. */
export function findTailscale(): string | undefined {
  const onPath = findOnPath("tailscale");
  if (onPath && !/\.(cmd|bat)$/i.test(onPath)) return onPath;
  const places =
    process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"]
          .filter((dir): dir is string => !!dir)
          .map((dir) => path.join(dir, "Tailscale", "tailscale.exe"))
      : process.platform === "darwin"
        ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        : [];
  return places.find((place) => existsSync(place));
}

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: ASK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** Asks the Tailscale installed on this machine, if there is one, what it knows. */
export async function probeTailscale(port: number): Promise<TailscaleProbe | undefined> {
  const tailscale = findTailscale();
  if (!tailscale) return undefined;
  let state: TailscaleState;
  try {
    state = parseTailscaleStatus(await run(tailscale, ["status", "--json"]));
  } catch {
    // Installed, but its service does not answer: the same to the user as not connected.
    return { state: { running: false, ips: [] }, served: [] };
  }
  if (!state.running) return { state, served: [] };
  try {
    const served = parseTailscaleServe(await run(tailscale, ["serve", "status", "--json"]), port);
    return { state, served };
  } catch {
    return { state, served: [] };
  }
}

/** This machine's IPv4 addresses on its networks, Tailscale's own left out. */
export function lanAddresses(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
  exclude: string[] = [],
): string[] {
  const found: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const one of list ?? []) {
      // 169.254.x.x is what a card gives itself when no network answered.
      if (one.family !== "IPv4" || one.internal || one.address.startsWith("169.254.")) continue;
      if (!exclude.includes(one.address) && !found.includes(one.address)) found.push(one.address);
    }
  }
  return found;
}

const withPort = (host: string, port: number) =>
  `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

/**
 * Every address another device can open MoonAgentic at, the safest first: nothing is
 * listed that does not answer. A server that listens on 127.0.0.1 only is reachable through
 * `tailscale serve` and nothing else.
 */
export function remoteAccess(input: {
  /** The address the server listens on, as given to `--host`. */
  host: string;
  port: number;
  tailscale: TailscaleProbe | undefined;
  lan: string[];
}): RemoteAccess {
  const { host, port, tailscale } = input;
  const exposed = !LOOPBACK.has(host);
  const everywhere = EVERYWHERE.has(host);
  const state = tailscale?.state;
  const addresses: RemoteAddress[] = [...(tailscale?.served ?? [])];
  if (state?.running && (everywhere || state.ips.includes(host))) {
    const name = everywhere ? (state.name ?? state.ips[0]) : host;
    if (name) addresses.push({ kind: "tailscale", url: withPort(name, port) });
  }
  if (everywhere) {
    for (const ip of input.lan) addresses.push({ kind: "lan", url: withPort(ip, port) });
  } else if (exposed && !state?.ips.includes(host)) {
    addresses.push({ kind: "lan", url: withPort(host, port) });
  }
  return {
    port,
    exposed,
    tailscale: !tailscale ? "absent" : state?.running ? "ready" : "stopped",
    ...(state?.running && state.name ? { tailscaleName: state.name } : {}),
    addresses,
  };
}

/** How this server can be reached right now: asks Tailscale and reads the network cards. */
export async function findRemoteAccess(host: string, port: number): Promise<RemoteAccess> {
  const tailscale = await probeTailscale(port);
  return remoteAccess({
    host,
    port,
    tailscale,
    lan: lanAddresses(os.networkInterfaces(), tailscale?.state.ips ?? []),
  });
}
