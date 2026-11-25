import { describe, expect, it } from "vitest";
import { prLinks, prParts, takePrLinks, withPrLinks } from "./pr-links.ts";

const URL = "https://github.com/Moon-ItachiDEV/MoonAgentic/pull/155";

describe("pull request links", () => {
  it("finds a link and leaves the comma after it out", () => {
    expect(prLinks(`check ${URL}, merci`)).toEqual([
      { url: URL, owner: "Moon-ItachiDEV", repo: "MoonAgentic", number: 155 },
    ]);
  });

  it("keeps a link's tail (files tab) in its address", () => {
    expect(prLinks(`${URL}/files#diff-1`)[0]?.url).toBe(`${URL}/files#diff-1`);
  });

  it("takes links out of the composer text and gives them back in full when sent", () => {
    const { text, links } = takePrLinks(`relis ${URL} stp`);
    expect(text).toBe("relis stp");
    expect(withPrLinks(text, links)).toBe(`relis stp ${URL}`);
    expect(withPrLinks("/revue", links)).toBe(`/revue ${URL}`);
  });

  it("leaves an empty composer when only a link was pasted", () => {
    const { text, links } = takePrLinks(URL);
    expect(text).toBe("");
    expect(withPrLinks(text, links)).toBe(URL);
  });

  it("splits a message into text and links", () => {
    expect(prParts(`check ${URL}`)).toEqual([
      { text: "check " },
      { link: { url: URL, owner: "Moon-ItachiDEV", repo: "MoonAgentic", number: 155 } },
    ]);
  });

  it("counts the same pull request once", () => {
    expect(prLinks(`${URL} ${URL}/files`)).toHaveLength(1);
  });

  it("ignores issues and other GitHub pages", () => {
    expect(prLinks("https://github.com/a/b/issues/3 https://github.com/a/b")).toEqual([]);
  });
});
