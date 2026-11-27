const mouse =
  typeof matchMedia === "function" ? matchMedia("(hover: hover) and (pointer: fine)") : undefined;

/**
 * A screen worked with the fingers: a phone, a tablet, whose keyboard comes up on the screen.
 * The same test as the page's `data-dev="touch"`.
 */
export function touchScreen(): boolean {
  return mouse !== undefined && !mouse.matches;
}
