import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentRefused,
  Attachments,
  cleanName,
  MAX_INLINE_IMAGE_BYTES,
  MAX_PENDING,
  PENDING_TTL_MS,
  sniffImage,
} from "../src/attachments.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The first bytes of each kind of image, followed by filler. */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.from("GIF89a....");
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 ");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-images-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, images: new Attachments(dir) };
}

const status = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AttachmentRefused ? error.status : error;
  }
  return "accepted";
};

describe("images sent with a message", () => {
  it("tells the kind of image from its bytes, whatever its name says", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(SVG)).toBeUndefined();
    expect(sniffImage(Buffer.from("#!/bin/sh\n"))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });

  it("keeps only real images of a fair size, under a name fit to show", () => {
    const { images } = setup();
    expect(status(() => images.add(Buffer.alloc(0)))).toBe(400);
    expect(status(() => images.add(SVG, "dessin.svg"))).toBe(415);
    // A script named like an image is still not one.
    expect(status(() => images.add(Buffer.from("#!/bin/sh\n"), "photo.png"))).toBe(415);
    const heavy = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(status(() => images.add(heavy))).toBe(413);

    expect(images.add(PNG, "../../etc/capture d'écran.png")).toMatchObject({
      name: ".. .. etc capture d'écran.png",
      mime: "image/png",
      size: PNG.length,
    });
    expect(images.add(JPEG).name).toBe("image.jpg");
    expect(cleanName("  \u0000\n ", "image/webp")).toBe("image.webp");
    expect(cleanName("a".repeat(500), "image/gif")).toHaveLength(120);
  });

  it("gives the images to the thread their message is sent in, all of them or none", () => {
    const { dir, images } = setup();
    const one = images.add(PNG, "un.png");
    const two = images.add(JPEG, "deux.jpg");
    // Not the thread's yet: nothing reads them by a thread's address.
    expect(images.find("fil-1", one.id)).toBeUndefined();

    expect(status(() => images.bind("fil-1", [one.id, "absente"]))).toBe(404);
    expect(status(() => images.bind("fil-1", [one.id, one.id]))).toBe(400);
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, n) => `image-${n}`);
    expect(status(() => images.bind("fil-1", many))).toBe(400);
    expect(existsSync(path.join(dir, "fil-1"))).toBe(false);

    expect(images.bind("fil-1", [one.id, two.id])).toEqual([one, two]);
    expect(images.find("fil-1", one.id)).toMatchObject({ image: one });
    // Another thread does not read them, and they cannot be sent a second time.
    expect(images.find("fil-2", one.id)).toBeUndefined();
    expect(status(() => images.bind("fil-2", [one.id]))).toBe(404);
  });

  it("never takes an id or a thread for a path", () => {
    const { dir, images } = setup();
    const image = images.add(PNG);
    images.bind("fil-1", [image.id]);
    expect(images.find("fil-1", `../fil-1/${image.id}`)).toBeUndefined();
    expect(images.find("../" + path.basename(dir) + "/fil-1", image.id)).toBeUndefined();
    expect(images.find(".", image.id)).toBeUndefined();
    expect(status(() => images.bind("../ailleurs", [images.add(PNG).id]))).toBe(404);
    images.forget("..");
    images.forget("pending");
    images.discard("../fil-1/" + image.id);
    expect(images.find("fil-1", image.id)).toMatchObject({ image });
    expect(existsSync(path.join(dir, "pending"))).toBe(true);
  });

  it("throws away what is taken off, what waited too long, and a deleted thread's images", () => {
    const { dir, images } = setup();
    const kept = images.add(PNG);
    const removed = images.add(PNG);
    const old = images.add(PNG);
    images.discard(removed.id);
    expect(status(() => images.bind("fil-1", [removed.id]))).toBe(404);
    expect(readdirSync(path.join(dir, "pending")).some((f) => f.startsWith(removed.id))).toBe(
      false,
    );

    const longAgo = new Date(Date.now() - PENDING_TTL_MS - 60_000);
    for (const name of [`${old.id}.png`, `${old.id}.json`]) {
      utimesSync(path.join(dir, "pending", name), longAgo, longAgo);
    }
    images.sweep();
    expect(readdirSync(path.join(dir, "pending")).sort()).toEqual(
      [`${kept.id}.png`, `${kept.id}.json`].sort(),
    );

    images.bind("fil-1", [kept.id]);
    images.forget("fil-1");
    expect(images.find("fil-1", kept.id)).toBeUndefined();
    expect(existsSync(path.join(dir, "fil-1"))).toBe(false);
  });

  it("stops taking images when too many wait for a message", () => {
    const { images } = setup();
    for (let n = 0; n < MAX_PENDING; n++) images.add(PNG);
    expect(status(() => images.add(PNG))).toBe(429);
  });

  it("hands an agent the image itself when it takes images, a link to its file otherwise", () => {
    const { images } = setup();
    const small = images.add(PNG, "petite.png");
    const large = images.add(Buffer.concat([PNG, Buffer.alloc(MAX_INLINE_IMAGE_BYTES)]), "g.png");
    const sent = images.bind("fil-1", [small.id, large.id]);

    const [inline, linked] = images.blocks("fil-1", sent, true);
    expect(inline).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG.toString("base64"),
    });
    // Too large to go inside the message: the agent opens the file.
    expect(linked).toMatchObject({ type: "resource_link", name: "g.png", mimeType: "image/png" });

    const links = images.blocks("fil-1", sent, false);
    expect(links.map((b) => b.type)).toEqual(["resource_link", "resource_link"]);
    expect(links[0]).toMatchObject({ name: "petite.png", size: PNG.length });
    // The file carries the extension of its kind: an agent tells an image from text by it.
    expect((links[0] as { uri: string }).uri).toMatch(/^file:\/\/.*fil-1\/[0-9a-f-]+\.png$/);
    // An image that is gone is left out, not sent as a broken link.
    images.forget("fil-1");
    expect(images.blocks("fil-1", sent, true)).toEqual([]);
  });
});
