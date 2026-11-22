import { useId, type SVGProps } from "react";

// Orbite mark: a crescent moon with its agents on a tilted orbit. The orbit passes behind the
// moon (masked) and in front of it; the front arc and agents cut a gap into the crescent.
const CRESCENT = "M36.03 27.03A12.4 12.4 0 1 1 23.28 11.62A10 10 0 0 0 36.03 27.03Z";
const BACK_ARC = "M-19.4 0A19.4 6.8 0 0 1 19.4 0";
const FRONT_ARC = "M19.4 0A19.4 6.8 0 0 1-19.4 0";
const ORBIT = "translate(24 24) rotate(-20)";
const TINT = "var(--moon-orbit, var(--accent))";
const FRONT_AGENTS = [
  { cx: 36.5, cy: 25.34, r: 4.14, gap: 6.34 },
  { cx: 6.08, cy: 31.22, r: 3.44, gap: 5.64 },
];

/** `currentColor` paints the moon; `--moon-orbit` overrides the orbit tint. */
export function MoonMark(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg viewBox="2.5 2.5 43 43" aria-hidden {...props}>
      <defs>
        <mask id={`${id}b`} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <path d={CRESCENT} fill="#000" stroke="#000" strokeWidth={3.08} />
        </mask>
        <mask id={`${id}f`} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <path d={FRONT_ARC} transform={ORBIT} fill="none" stroke="#000" strokeWidth={7} />
          {FRONT_AGENTS.map((a) => (
            <circle key={a.cx} cx={a.cx} cy={a.cy} r={a.gap} fill="#000" />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${id}b)`}>
        <path
          d={BACK_ARC}
          transform={ORBIT}
          fill="none"
          stroke={TINT}
          strokeWidth={2.6}
          opacity={0.5}
          strokeLinecap="round"
        />
        <circle cx={29.42} cy={15.44} r={2.81} fill={TINT} opacity={0.72} />
      </g>
      <path d={CRESCENT} fill="currentColor" mask={`url(#${id}f)`} />
      <path
        d={FRONT_ARC}
        transform={ORBIT}
        fill="none"
        stroke={TINT}
        strokeWidth={2.6}
        opacity={0.85}
        strokeLinecap="round"
      />
      {FRONT_AGENTS.map((a) => (
        <circle key={a.cx} cx={a.cx} cy={a.cy} r={a.r} fill={TINT} opacity={0.72} />
      ))}
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand" role="img" aria-label="MoonAgentic">
      <MoonMark />
      <span aria-hidden>
        <b>Moon</b>Agentic
      </span>
    </span>
  );
}
