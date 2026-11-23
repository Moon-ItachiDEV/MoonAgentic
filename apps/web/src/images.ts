// The images joined to a message: which files are taken, how a heavy one is made lighter,
// and how they go to the server and come back from it.
import {
  IMAGE_TYPES,
  type ImageType,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
} from "@moonagentic/protocol";

/** What the file picker offers. */
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
/** An image heavier than this is drawn again smaller, so an agent takes it in the message. */
export const REDRAW_OVER_BYTES = 4 * 1024 * 1024;
/** The longest side of an image drawn again: more than an agent looks at. */
export const REDRAW_MAX_SIDE = 2048;
const REDRAW_QUALITY = 0.86;

export const NOT_AN_IMAGE = "Seules les images peuvent être jointes : PNG, JPEG, GIF ou WebP.";
export const TOO_MANY = `Pas plus de ${MAX_IMAGES_PER_MESSAGE} images par message.`;
export const TOO_HEAVY = `Image trop lourde : ${MAX_IMAGE_BYTES / 1024 / 1024} Mo au plus.`;

const isKept = (type: string): type is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(type);

/** What to do with a file before it is sent. */
export type Plan = "send" | "redraw" | "refuse";

/**
 * A file of a kind the server keeps goes as it is unless it is heavy. Another kind of image,
 * such as a phone's HEIC or a BMP, is drawn again as a JPEG when the browser can read it.
 * SVG is never drawn: it is not a picture but a document.
 */
export function planFor(type: string, size: number): Plan {
  if (!type.startsWith("image/") || type === "image/svg+xml") return "refuse";
  if (!isKept(type)) return "redraw";
  // Drawing a GIF again would keep its first frame only.
  if (type === "image/gif") return size > MAX_IMAGE_BYTES ? "refuse" : "send";
  return size > REDRAW_OVER_BYTES ? "redraw" : "send";
}

/** The size an image is drawn again at: same shape, its longest side within the limit. */
export function fitWithin(
  width: number,
  height: number,
  max: number = REDRAW_MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The name of a file once it is a JPEG. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return `${base || "image"}.jpg`;
}

/** How many of the files picked still fit in the message. */
export function roomFor(already: number, picked: number): number {
  return Math.max(0, Math.min(picked, MAX_IMAGES_PER_MESSAGE - already));
}

/**
 * The files of a paste that are meant as images. A spreadsheet or a word processor copies
 * its text with a picture of it: there the text is what the user pastes.
 */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data || [...data.types].includes("text/plain")) return [];
  const files = [...data.files];
  if (files.length) return files;
  // A screenshot pasted from the clipboard may come as an item only.
  return [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

/** True when what is dragged over the page is files, not text picked in it. */
export function carriesFiles(data: DataTransfer | null): boolean {
  return !!data && [...data.types].includes("Files");
}

export interface Prepared {
  blob: Blob;
  name: string;
}

/** A photo taken by the phone has no name worth showing. */
const nameOf = (file: File) => file.name || "image";

/** The file as it goes to the server: itself, or drawn again lighter. Throws what to tell the user. */
export async function prepareImage(file: File): Promise<Prepared> {
  const plan = planFor(file.type, file.size);
  if (plan === "refuse") {
    throw new Error(file.type === "image/gif" ? TOO_HEAVY : NOT_AN_IMAGE);
  }
  if (plan === "send") return { blob: file, name: nameOf(file) };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // The browser cannot read it. One of a kind the server keeps still goes if it fits.
    if (isKept(file.type) && file.size <= MAX_IMAGE_BYTES)
      return { blob: file, name: nameOf(file) };
    throw new Error(isKept(file.type) ? TOO_HEAVY : NOT_AN_IMAGE);
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(TOO_HEAVY);
    // A JPEG has no transparency: what was see-through shows on white, as on a page.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", REDRAW_QUALITY),
    );
    if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error(TOO_HEAVY);
    return { blob, name: jpegName(nameOf(file)) };
  } finally {
    bitmap.close();
  }
}
