import { describe, expect, it } from "vitest";
import {
  lanAddresses,
  parseTailscaleServe,
  parseTailscaleStatus,
  remoteAccess,
  type TailscaleProbe,
} from "../src/remote.ts";

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: {
    DNSName: "mini.tail1234.ts.net.",
    TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"],
    Online: true,
  },
});

const serve = (proxy: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { "mini.tail1234.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
    ...extra,
  });

describe("what Tailscale says", () => {
  it("reads this machine's name and addresses", () => {
    expect(parseTailscaleStatus(STATUS)).toEqual({
      running: true,
      name: "mini.tail1234.ts.net",
      ips: ["100.64.0.7", "fd7a:115c:a1e0::7"],
    });
  });

  it("is not running when signed out, stopped, or unreadable", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" })).running).toBe(
      false,
    );
    expect(parseTailscaleStatus("pas du JSON")).toEqual({ running: false, ips: [] });
  });

  it("finds the HTTPS address `tailscale serve` publishes the port at", () => {
    for (const proxy of ["http://127.0.0.1:4747", "http://localhost:4747", "4747"]) {
      expect(parseTailscaleServe(serve(proxy), 4747)).toEqual([
        { kind: "tailscale-https", url: "https://mini.tail1234.ts.net" },
      ]);
    }
  });

  it("finds it on port 80 too, which an address leaves out", () => {
    for (const proxy of ["http://127.0.0.1:80", "http://127.0.0.1", "80"]) {
      expect(parseTailscaleServe(serve(proxy), 80)).toHaveLength(1);
    }
    expect(parseTailscaleServe(serve("http://127.0.0.1"), 4747)).toEqual([]);
  });

  it("leaves out what is published for another port, another machine or another path", () => {
    expect(parseTailscaleServe(serve("http://127.0.0.1:3000"), 4747)).toEqual([]);
    expect(parseTailscaleServe(serve("http://192.168.1.9:4747"), 4747)).toEqual([]);
    expect(parseTailscaleServe(serve("https+insecure://127.0.0.1:4747"), 4747)).toEqual([]);
    const underPath = JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: {
        "mini.tail1234.ts.net:443": { Handlers: { "/moon": { Proxy: "http://127.0.0.1:4747" } } },
      },
    });
    expect(parseTailscaleServe(underPath, 4747)).toEqual([]);
    expect(parseTailscaleServe("{}", 4747)).toEqual([]);
    expect(parseTailscaleServe("", 4747)).toEqual([]);
  });

  it("keeps another HTTPS port, and says when Funnel opens the address to everyone", () => {
    const config = JSON.stringify({
      TCP: { "8443": { HTTPS: true } },
      Web: {
        "mini.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4747" } } },
      },
      AllowFunnel: { "mini.tail1234.ts.net:8443": true },
    });
    expect(parseTailscaleServe(config, 4747)).toEqual([
      { kind: "tailscale-https", url: "https://mini.tail1234.ts.net:8443", public: true },
    ]);
  });

  it("also reads a `tailscale serve` left running in a terminal", () => {
    const config = JSON.stringify({
      Foreground: { abc: JSON.parse(serve("http://127.0.0.1:4747")) },
    });
    expect(parseTailscaleServe(config, 4747)).toEqual([
      { kind: "tailscale-https", url: "https://mini.tail1234.ts.net" },
    ]);
  });
});

describe("the addresses of this machine", () => {
  it("lists IPv4 addresses of real networks only", () => {
    const found = lanAddresses(
      {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "192.168.1.20", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
        tailscale0: [{ address: "100.64.0.7", family: "IPv4", internal: false }],
        dead: [{ address: "169.254.3.4", family: "IPv4", internal: false }],
      } as unknown as Parameters<typeof lanAddresses>[0],
      ["100.64.0.7"],
    );
    expect(found).toEqual(["192.168.1.20"]);
  });
});

describe("how the server can be reached", () => {
  const ready: TailscaleProbe = { state: parseTailscaleStatus(STATUS), served: [] };
  const served: TailscaleProbe = {
    ...ready,
    served: [{ kind: "tailscale-https", url: "https://mini.tail1234.ts.net" }],
  };
  const lan = ["192.168.1.20"];

  it("has no address when it listens on this machine only and nothing publishes it", () => {
    expect(remoteAccess({ host: "127.0.0.1", port: 4747, tailscale: undefined, lan })).toEqual({
      port: 4747,
      exposed: false,
      tailscale: "absent",
      addresses: [],
    });
    expect(remoteAccess({ host: "127.0.0.1", port: 4747, tailscale: ready, lan })).toEqual({
      port: 4747,
      exposed: false,
      tailscale: "ready",
      tailscaleName: "mini.tail1234.ts.net",
      addresses: [],
    });
  });

  it("is reached through `tailscale serve` while listening on this machine only", () => {
    expect(
      remoteAccess({ host: "127.0.0.1", port: 4747, tailscale: served, lan }).addresses,
    ).toEqual([{ kind: "tailscale-https", url: "https://mini.tail1234.ts.net" }]);
  });

  it("lists the Tailscale name, then the local network, when it listens everywhere", () => {
    expect(remoteAccess({ host: "0.0.0.0", port: 4747, tailscale: served, lan }).addresses).toEqual(
      [
        { kind: "tailscale-https", url: "https://mini.tail1234.ts.net" },
        { kind: "tailscale", url: "http://mini.tail1234.ts.net:4747" },
        { kind: "lan", url: "http://192.168.1.20:4747" },
      ],
    );
    expect(
      remoteAccess({ host: "0.0.0.0", port: 4747, tailscale: undefined, lan }).addresses,
    ).toEqual([{ kind: "lan", url: "http://192.168.1.20:4747" }]);
  });

  it("lists only the address it listens on when given one", () => {
    expect(
      remoteAccess({ host: "100.64.0.7", port: 4747, tailscale: ready, lan }).addresses,
    ).toEqual([{ kind: "tailscale", url: "http://100.64.0.7:4747" }]);
    expect(
      remoteAccess({ host: "192.168.1.20", port: 4747, tailscale: ready, lan }).addresses,
    ).toEqual([{ kind: "lan", url: "http://192.168.1.20:4747" }]);
  });

  it("says Tailscale is stopped when it is installed but not connected", () => {
    const stopped: TailscaleProbe = { state: { running: false, ips: [] }, served: [] };
    expect(remoteAccess({ host: "127.0.0.1", port: 4747, tailscale: stopped, lan }).tailscale).toBe(
      "stopped",
    );
  });
});
