import type { Item, Mascot } from "@moonagentic/protocol";
import { activityGlyph, TEST_CMD } from "./activity.ts";

/** The faces of Breezydev's moon, each one a thing the agent really does. */
export type MascotExpression =
  "idle" | "reading" | "coding" | "review" | "error" | "testing" | "success";

/**
 * The face the agent's moon makes for the item it is at: the same reading of the item as
 * the working line's words and picture, so the moon never shows what is not happening.
 */
export function mascotExpression(item: Item | undefined): MascotExpression {
  if (item?.kind === "tool" && !item.questions) {
    if (item.status === "failed") return "error";
    if (item.toolKind === "execute" && TEST_CMD.test(item.title) && item.status === "completed")
      return "success";
  }
  switch (activityGlyph(item)) {
    case "lit":
    case "cherche":
    case "web":
      return "reading";
    case "modifie":
    case "ecrit":
    case "commande":
      return "coding";
    case "pense":
      return "review";
    case "tests":
      return "testing";
    default:
      // Starting, waiting on the user or in line: the moon rests and blinks.
      return "idle";
  }
}

export const MASCOT_SHAPE_NAMES: Record<Mascot["shape"], string> = {
  crescent: "Croissant",
  full: "Pleine lune",
  orb: "Orbe",
};

export const MASCOT_COLOR_NAMES: Record<Mascot["color"], string> = {
  ice: "Glacier",
  violet: "Améthyste",
  pink: "Rosée",
  mint: "Menthe",
  amber: "Ambre",
  silver: "Argent",
};
