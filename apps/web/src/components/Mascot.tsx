import type { Mascot as MascotChoice } from "@moonagentic/protocol";
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { MascotExpression } from "../mascot.ts";
import { defineMoonMascot } from "../moon-mascot.ts";
import { pageSight } from "../visibility.ts";

// The app's own sight of the page: the desktop window hidden in the tray counts as unseen.
defineMoonMascot(pageSight);

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "moon-mascot": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        shape?: string;
        color?: string;
        expression?: string;
        label?: string;
        /** No button of its own: for a moon inside another control. */
        decorative?: "";
        /** Drawn once: for a state that is over. */
        still?: "";
      };
    }
  }
}

/**
 * The agent's moon on its own sky. `size` is the tile's side in pixels; the moon fills it.
 * Its face is what the agent does now, so it is only shown where that is known. It is
 * decorative here (it sits in the working line and in buttons), so it has no button of
 * its own; the large one in the settings is the one that winks.
 */
export function Mascot({
  mascot,
  expression = "idle",
  name,
  size = 36,
  still,
}: {
  mascot: MascotChoice;
  expression?: MascotExpression;
  /** The agent's name, read aloud on the button that makes it wink. */
  name: string;
  size?: number;
  /** For a state that is over, such as a stopped turn: drawn once, not animated. */
  still?: boolean;
}) {
  return (
    <span
      className="mascot"
      data-moon={mascot.color}
      style={{ inlineSize: size, blockSize: size }}
      title={name}
      aria-hidden
    >
      <moon-mascot
        shape={mascot.shape}
        color={mascot.color}
        expression={expression}
        decorative=""
        still={still ? "" : undefined}
      />
    </span>
  );
}
