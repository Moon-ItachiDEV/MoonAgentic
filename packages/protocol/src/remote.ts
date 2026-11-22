/** One address MoonAgentic can be opened at from another device. */
export interface RemoteAddress {
  /**
   * `tailscale-https`: published by `tailscale serve`, encrypted, with a certificate.
   * `tailscale`: the machine's Tailscale name or address, encrypted by the tunnel.
   * `lan`: an address on the local network, with no encryption.
   */
  kind: "tailscale-https" | "tailscale" | "lan";
  /** Without the token, and without a trailing slash: `https://mini.tail1234.ts.net`. */
  url: string;
  /** Tailscale Funnel is on for it: the whole internet can reach this address. */
  public?: boolean;
}

/** How this MoonAgentic can be reached from another device, as found when asked. */
export interface RemoteAccess {
  /** The port MoonAgentic listens on. */
  port: number;
  /** Whether it listens beyond this machine (`--host`), not only on 127.0.0.1. */
  exposed: boolean;
  /** `absent`: not installed. `stopped`: installed, but not connected. */
  tailscale: "absent" | "stopped" | "ready";
  /** This machine's name on the Tailscale network, such as `mini.tail1234.ts.net`. */
  tailscaleName?: string;
  /** The addresses that work right now, the best one first. None when there is none. */
  addresses: RemoteAddress[];
}
