import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  carriesFiles,
  fitWithin,
  jpegName,
  pastedImages,
  planFor,
  REDRAW_MAX_SIDE,
  REDRAW_OVER_BYTES,
  roomFor,
} from "./images.ts";

/** What a paste or a drop carries, as the browser gives it. */
function transfer(types: string[], files: string[], items: string[] = []): DataTransfer {
  return {
    types,
    files: files.map((name) => ({ name })),
    items: items.map((name) => ({ kind: "file", getAsFile: () => ({ name }) })),
  } as unknown as DataTransfer;
}

describe("images joined to a message", () => {
  it("sends a light image as it is, draws a heavy or foreign one again, refuses the rest", () => {
    expect(planFor("image/png", 2000)).toBe("send");
    expect(planFor("image/webp", REDRAW_OVER_BYTES)).toBe("send");
    expect(planFor("image/jpeg", REDRAW_OVER_BYTES + 1)).toBe("redraw");
    // A phone's own format, or one the server does not keep: a JPEG is made of it.
    expect(planFor("image/heic", 2000)).toBe("redraw");
    expect(planFor("image/bmp", 2000)).toBe("redraw");
    // A GIF drawn again would lose its animation: it goes whole, or not at all.
    expect(planFor("image/gif", REDRAW_OVER_BYTES + 1)).toBe("send");
    expect(planFor("image/gif", MAX_IMAGE_BYTES + 1)).toBe("refuse");
    // SVG is a document that can carry scripts, not a picture.
    expect(planFor("image/svg+xml", 2000)).toBe("refuse");
    expect(planFor("application/pdf", 2000)).toBe("refuse");
    expect(planFor("", 2000)).toBe("refuse");
  });

  it("keeps an image's shape when it makes it smaller", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(4096, 2048)).toEqual({ width: REDRAW_MAX_SIDE, height: REDRAW_MAX_SIDE / 2 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1536, height: 2048 });
    // Never down to nothing, however thin.
    expect(fitWithin(10_000, 2)).toEqual({ width: 2048, height: 1 });
  });

  it("names a drawn-again image as the JPEG it now is", () => {
    expect(jpegName("IMG_0042.HEIC")).toBe("IMG_0042.jpg");
    expect(jpegName("capture d'écran.png")).toBe("capture d'écran.jpg");
    expect(jpegName("sans-extension")).toBe("sans-extension.jpg");
    expect(jpegName("")).toBe("image.jpg");
  });

  it("takes no more images than a message may carry", () => {
    expect(roomFor(0, 3)).toBe(3);
    expect(roomFor(MAX_IMAGES_PER_MESSAGE - 2, 5)).toBe(2);
    expect(roomFor(MAX_IMAGES_PER_MESSAGE, 1)).toBe(0);
  });

  it("pastes text as text when it comes with a picture of itself", () => {
    expect(pastedImages(transfer(["Files"], ["capture.png"])).map((f) => f.name)).toEqual([
      "capture.png",
    ]);
    // A screenshot may come as an item only.
    expect(pastedImages(transfer(["Files"], [], ["ecran.png"])).map((f) => f.name)).toEqual([
      "ecran.png",
    ]);
    // An image copied from a web page comes with its HTML, not with plain text.
    expect(pastedImages(transfer(["text/html", "Files"], ["photo.jpg"]))).toHaveLength(1);
    // Cells copied from a spreadsheet: the text is what is pasted.
    expect(pastedImages(transfer(["text/plain", "text/html", "Files"], ["cellules.png"]))).toEqual(
      [],
    );
    expect(pastedImages(transfer(["text/plain"], []))).toEqual([]);
    expect(pastedImages(null)).toEqual([]);
  });

  it("tells files dragged over the page from text picked in it", () => {
    expect(carriesFiles(transfer(["Files"], []))).toBe(true);
    expect(carriesFiles(transfer(["text/plain"], []))).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});
