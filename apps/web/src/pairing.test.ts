import { describe, expect, it } from "vitest";
import { deviceName, pairLink, seenAgo, shownCode } from "./remote.ts";

describe("pairing a device, as told to the user", () => {
  it("builds the link a phone scans, with the code in the fragment", () => {
    expect(pairLink({ kind: "tailscale-https", url: "https://mini.ts.net" }, "ABCD2345")).toBe(
      "https://mini.ts.net/#pair=ABCD2345",
    );
    expect(shownCode("ABCD2345")).toBe("ABCD-2345");
  });

  it("names a device from its browser", () => {
    expect(
      deviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
    expect(
      deviceName(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
      ),
    ).toBe("Téléphone Android · Chrome");
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
      ),
    ).toBe("PC Windows · Edge");
    expect(deviceName("curl/8")).toBe("Appareil");
  });

  it("says when a device was last seen", () => {
    const now = 10 * 86_400_000;
    expect(seenAgo(now - 30_000, now)).toBe("à l'instant");
    expect(seenAgo(now - 5 * 60_000, now)).toBe("il y a 5 min");
    expect(seenAgo(now - 3 * 3_600_000, now)).toBe("il y a 3 h");
    expect(seenAgo(now - 2 * 86_400_000, now)).toBe("il y a 2 j");
  });
});
