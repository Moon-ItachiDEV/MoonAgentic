import { useEffect, useRef } from "react";
import { litPath } from "../app-update.ts";

let count = 0;

/**
 * The moon of the updates: its lit share follows a real figure (what is downloaded), a small
 * satellite turns while something works with no figure to give, a corona shows while the app
 * is away, and a tick once it is done. The share glides to each new value: a download is told
 * in steps, the moon fills without a jerk.
 */
export function MoonPhase(props: {
  /** From 0 (new moon) to 1 (full). */
  lit: number;
  /** `live`: lit in the accent, something is under way. */
  live?: boolean;
  /** A satellite on its orbit: at work, with no share to show. */
  spin?: boolean;
  /** The app is away (it restarts): a corona around the dark moon. */
  away?: boolean;
  done?: boolean;
}) {
  const id = useRef(`moon-${++count}`).current;
  const svg = useRef<SVGSVGElement>(null);
  const shown = useRef(props.lit);
  useEffect(() => {
    const paint = () => {
      const d = litPath(shown.current);
      for (const path of svg.current?.querySelectorAll(".lit, .litc") ?? [])
        path.setAttribute("d", d);
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.current = props.lit;
      paint();
      return;
    }
    let frame = 0;
    const step = () => {
      const gap = props.lit - shown.current;
      if (Math.abs(gap) < 0.002) {
        shown.current = props.lit;
        paint();
        return;
      }
      shown.current += gap * 0.09;
      paint();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [props.lit]);
  const d = litPath(shown.current);
  const classes = [
    "umoon",
    props.live && "live",
    props.spin && "spin",
    props.away && "back",
    props.done && "done",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <svg ref={svg} className={classes} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <clipPath id={id}>
          <path className="litc" d={d} />
        </clipPath>
      </defs>
      <g transform="translate(24 24) rotate(-20)">
        <path className="orb" pathLength={1} d="M22 0A22 7 0 0 0 -22 0" />
      </g>
      <circle className="cor" cx="24" cy="24" r="15.4" />
      <circle className="disc" cx="24" cy="24" r="15" />
      <path className="lit" d={d} />
      <g clipPath={`url(#${id})`}>
        <circle className="crat" cx="29" cy="19.5" r="3.1" />
        <circle className="crat" cx="20.5" cy="29" r="2.3" />
        <circle className="crat" cx="30.5" cy="29.5" r="1.5" />
      </g>
      <g transform="translate(24 24) rotate(-20)">
        <path className="orb front" pathLength={1} d="M-22 0A22 7 0 0 0 22 0" />
        <g className="sat">
          <circle r="2.9" />
        </g>
      </g>
      <g className="ok">
        <circle cx="36" cy="35" r="7" />
        <path pathLength={1} d="M32.9 35.2l2.1 2.1 4-4.3" />
      </g>
    </svg>
  );
}

/** A tick that is drawn, not shown at once. */
export function DrawnCheck() {
  return (
    <svg className="uck" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path pathLength={1} d="M5 12.6l4.6 4.6L19.2 7.4" />
    </svg>
  );
}
