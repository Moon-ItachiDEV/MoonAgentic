// The images sent with a message: kept on this machine, each with the thread it was sent in.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  IMAGE_TYPES,
  type ImageRef,
  type ImageType,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
} from "@moonagentic/protocol";

/** An image an agent takes inside the message itself; a larger one is given as a file. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** How long an image sent to the server waits for its message before it is thrown away. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** How many images may wait for their message at once. */
export const MAX_PENDING = 64;

/** Where images wait until the message they go with is sent. */
const PENDING = "pending";
/** The ids this module makes, and the thread ids it files images under: never a path. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/** A refusal the user can do something about: said as it is, with its HTTP status. */
export class AttachmentRefused extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * What kind of image the bytes are, read from the bytes themselves: what the browser or the
 * file's name says is never trusted. SVG is left out on purpose, as it can carry scripts.
 */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  const starts = (...head: number[]) => head.every((byte, i) => bytes[i] === byte);
  const ascii = (at: number, word: string) =>
    [...word].every((letter, i) => bytes[at + i] === letter.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return undefined;
}

const EXTENSION: Record<ImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A name fit to show and to hand to an agent: no folder, no control character, not too long. */
export function cleanName(given: string | undefined, type: ImageType): string {
  const base = (given ?? "")
    .replace(/[\\/]/g, " ")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return base || `image.${EXTENSION[type]}`;
}

export class Attachments {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private folder(threadId: string): string {
    if (!SAFE_NAME.test(threadId)) throw new AttachmentRefused("Image introuvable.", 404);
    return path.join(this.dir, threadId);
  }

  /**
   * The two files of an image: its bytes, and what is known about it. The bytes carry the
   * extension of their kind, as an agent given the file tells an image from text by it.
   */
  private files(folder: string, id: string, type: ImageType): { bytes: string; about: string } {
    if (!SAFE_NAME.test(id)) throw new AttachmentRefused("Image introuvable.", 404);
    return {
      bytes: path.join(folder, `${id}.${EXTENSION[type]}`),
      about: path.join(folder, `${id}.json`),
    };
  }

  /** Every file an image of this id may have left in the folder, whatever its kind. */
  private allFiles(folder: string, id: string): string[] {
    if (!SAFE_NAME.test(id)) return [];
    return [
      path.join(folder, `${id}.json`),
      ...Object.values(EXTENSION).map((ext) => path.join(folder, `${id}.${ext}`)),
    ];
  }

  private about(folder: string, id: string): ImageRef | undefined {
    if (!SAFE_NAME.test(id)) throw new AttachmentRefused("Image introuvable.", 404);
    try {
      const read = JSON.parse(
        readFileSync(path.join(folder, `${id}.json`), "utf8"),
      ) as Partial<ImageRef>;
      const type = IMAGE_TYPES.find((t) => t === read.mime);
      if (!type) return undefined;
      const { bytes } = this.files(folder, id, type);
      if (!existsSync(bytes)) return undefined;
      return { id, name: cleanName(read.name, type), mime: type, size: statSync(bytes).size };
    } catch {
      return undefined;
    }
  }

  /** Keeps an image just received until the message it goes with is sent. */
  add(bytes: Buffer, name?: string): ImageRef {
    if (bytes.length === 0) throw new AttachmentRefused("Image vide.");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new AttachmentRefused(
        `Image trop lourde : ${MAX_IMAGE_BYTES / 1024 / 1024} Mo au plus.`,
        413,
      );
    }
    const type = sniffImage(bytes);
    if (!type) {
      throw new AttachmentRefused("Ce fichier n'est pas une image PNG, JPEG, GIF ou WebP.", 415);
    }
    this.sweep();
    const folder = path.join(this.dir, PENDING);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const waiting = readdirSync(folder).filter((file) => !file.endsWith(".json")).length;
    if (waiting >= MAX_PENDING) {
      throw new AttachmentRefused(
        "Trop d'images en attente d'envoi : envoie ou retire celles déjà jointes.",
        429,
      );
    }
    const image: ImageRef = {
      id: randomUUID(),
      name: cleanName(name, type),
      mime: type,
      size: bytes.length,
    };
    const files = this.files(folder, image.id, type);
    writeFileSync(files.bytes, bytes, { mode: 0o600 });
    writeFileSync(files.about, JSON.stringify({ name: image.name, mime: image.mime }), {
      mode: 0o600,
    });
    return image;
  }

  /**
   * Gives the images to the thread their message is sent in: from then on they are its
   * own. All of them or none: one that is missing leaves the others waiting.
   */
  bind(threadId: string, ids: readonly string[]): ImageRef[] {
    if (ids.length > MAX_IMAGES_PER_MESSAGE) {
      throw new AttachmentRefused(`${MAX_IMAGES_PER_MESSAGE} images au plus par message.`);
    }
    if (new Set(ids).size !== ids.length) throw new AttachmentRefused("Image jointe deux fois.");
    const from = path.join(this.dir, PENDING);
    const images = ids.map((id) => {
      const image = this.about(from, id);
      if (!image) {
        throw new AttachmentRefused("Une image jointe n'est plus là : joins-la à nouveau.", 404);
      }
      return image;
    });
    if (!images.length) return [];
    const to = this.folder(threadId);
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const image of images) {
      const waiting = this.files(from, image.id, image.mime);
      const kept = this.files(to, image.id, image.mime);
      renameSync(waiting.about, kept.about);
      renameSync(waiting.bytes, kept.bytes);
    }
    return images;
  }

  /** An image of the thread and the file that holds it, if it is there. */
  find(threadId: string, id: string): { image: ImageRef; file: string } | undefined {
    try {
      const folder = this.folder(threadId);
      const image = this.about(folder, id);
      return image ? { image, file: this.files(folder, id, image.mime).bytes } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Throws away an image that was joined to a message and then taken off before sending. */
  discard(id: string): void {
    for (const file of this.allFiles(path.join(this.dir, PENDING), id)) {
      rmSync(file, { force: true });
    }
  }

  /** Throws away the images of messages taken out of a thread, such as by a step back. */
  remove(threadId: string, ids: readonly string[]): void {
    for (const id of ids) {
      try {
        for (const file of this.allFiles(this.folder(threadId), id)) rmSync(file, { force: true });
      } catch {
        // Still being read (Windows), or not an id of ours: it goes with the thread.
      }
    }
  }

  /** The thread is deleted: its images go with it. */
  forget(threadId: string): void {
    if (!SAFE_NAME.test(threadId) || threadId === PENDING) return;
    rmSync(path.join(this.dir, threadId), { recursive: true, force: true });
  }

  /** Throws away the images that have waited too long for a message that never came. */
  sweep(now: number = Date.now()): void {
    const folder = path.join(this.dir, PENDING);
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      try {
        if (now - statSync(file).mtimeMs > PENDING_TTL_MS) rmSync(file, { force: true });
      } catch {
        // Gone meanwhile: nothing left to throw away.
      }
    }
  }

  /**
   * What the agent receives for each image of a message: the image itself when the agent
   * takes images and it is not too large, a link to its file otherwise.
   */
  blocks(threadId: string, images: readonly ImageRef[], takesImages: boolean): ImageBlock[] {
    return images.flatMap((image): ImageBlock[] => {
      const found = this.find(threadId, image.id);
      if (!found) return [];
      if (takesImages && found.image.size <= MAX_INLINE_IMAGE_BYTES) {
        return [
          {
            type: "image",
            mimeType: found.image.mime,
            data: readFileSync(found.file).toString("base64"),
          },
        ];
      }
      return [
        {
          type: "resource_link",
          uri: pathToFileURL(found.file).href,
          name: found.image.name,
          mimeType: found.image.mime,
          size: found.image.size,
        },
      ];
    });
  }
}

/** An image as an agent receives it. */
export type ImageBlock =
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; size: number };
