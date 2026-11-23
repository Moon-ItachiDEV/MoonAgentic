import type { Mascot as MascotChoice } from "@moonagentic/protocol";
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { MascotExpression } from "../mascot.ts";
import { defineMoonMascot } from "../moon-mascot.ts";

defineMoonMascot();

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "moon-mascot": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        shape?: string;
        color?: string;
        expression?: string;
        label?: string;
      };
    }
  }
}

/**
 * The agent's moon on its own sky. `size` is the tile's side in pixels; the moon fills it.
 * Its face is what the agent does now, so it is only shown where that is known.
 */
export function Mascot({
  mascot,
  expression = "idle",
  name,
  size = 36,
}: {
  mascot: MascotChoice;
  expression?: MascotExpression;
  /** The agent's name, read aloud on the button that makes it wink. */
  name: string;
  size?: number;
}) {
  return (
    <span
      className="mascot"
      data-moon={mascot.color}
      style={{ inlineSize: size, blockSize: size }}
      title={name}
    >
      <moon-mascot
        shape={mascot.shape}
        color={mascot.color}
        expression={expression}
        label={`Faire un clin d’œil à ${name}`}
      />
    </span>
  );
}
