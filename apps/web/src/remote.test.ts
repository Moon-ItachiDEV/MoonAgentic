import type { RemoteAccess } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { addressText, remoteAdvice, remoteLink } from "./remote.ts";

const access = (over: Partial<RemoteAccess>): RemoteAccess => ({
  port: 4747,
  exposed: false,
  tailscale: "absent",
  addresses: [],
  ...over,
});

describe("remote access, as told to the user", () => {
  it("builds the link another device opens", () => {
    expect(
      remoteLink({ kind: "tailscale-https", url: "https://mini.tail1234.ts.net" }, "a_b-c"),
    ).toBe("https://mini.tail1234.ts.net/#token=a_b-c");
  });

  it("warns about an address with no encryption, or open to the internet", () => {
    expect(addressText({ kind: "tailscale-https", url: "https://m.ts.net" }).tone).toBe("ok");
    expect(addressText({ kind: "lan", url: "http://192.168.1.20:4747" }).tone).toBe("warn");
    const funnel = addressText({ kind: "tailscale-https", url: "https://m.ts.net", public: true });
    expect(funnel.tone).toBe("warn");
    expect(funnel.detail).toContain("tout Internet");
  });

  it("gives the command to run when Tailscale is ready but does not publish the app", () => {
    const advice = remoteAdvice(access({ tailscale: "ready", tailscaleName: "mini.ts.net" }));
    expect(advice?.command).toBe("tailscale serve --bg 4747");
    expect(advice?.text).toContain("mini.ts.net");
  });

  it("has nothing to add once the HTTPS address is there", () => {
    expect(
      remoteAdvice(
        access({
          tailscale: "ready",
          addresses: [{ kind: "tailscale-https", url: "https://m.ts.net" }],
        }),
      ),
    ).toBeNull();
  });

  it("says what is missing when Tailscale is stopped or absent", () => {
    expect(remoteAdvice(access({ tailscale: "stopped" }))?.text).toContain("pas connecté");
    expect(remoteAdvice(access({}))?.text).toContain("--host 0.0.0.0");
    const lanOnly = access({
      exposed: true,
      addresses: [{ kind: "lan", url: "http://192.168.1.20:4747" }],
    });
    expect(remoteAdvice(lanOnly)?.command).toBeUndefined();
  });
});
