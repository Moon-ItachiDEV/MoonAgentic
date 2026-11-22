// oxlint-disable shadcn/no-raw-colors -- mask luminance (white keeps, black cuts), not theme colours
import { useId, type SVGProps } from "react";

// Orbite mark: crescent moon with its agents on a tilted orbit. The orbit passes behind the
// moon (masked) and in front of it; the front arc and agents cut a gap into the crescent.
const GEOMETRY = {
  detailed: {
    viewBox: "0 0 48 48",
    crescent: "M34.86 27.79A11.5 11.5 0 1 1 22.39 12.61A9.9 9.9 0 0 0 34.86 27.79Z",
    backArc: "M-20 0A20 6.4 0 0 1 20 0",
    frontArc: "M20 0A20 6.4 0 0 1-20 0",
    ring: 1.35,
    crescentGap: 2.24,
    arcGap: 4.55,
    backOpacity: 0.38,
    frontOpacity: 0.75,
    backAgent: { cx: 29.78, cy: 15.7, r: 1.75 },
    frontAgents: [
      { cx: 36.71, cy: 24.91, r: 3.37, gap: 4.97 },
      { cx: 5.51, cy: 31.39, r: 2.51, gap: 4.11 },
    ],
  },
  compact: {
    viewBox: "2.5 2.5 43 43",
    crescent: "M36.03 27.03A12.4 12.4 0 1 1 23.28 11.62A10 10 0 0 0 36.03 27.03Z",
    backArc: "M-19.4 0A19.4 6.8 0 0 1 19.4 0",
    frontArc: "M19.4 0A19.4 6.8 0 0 1-19.4 0",
    ring: 2.6,
    crescentGap: 3.08,
    arcGap: 7,
    backOpacity: 0.5,
    frontOpacity: 0.85,
    backAgent: { cx: 29.42, cy: 15.44, r: 2.81 },
    frontAgents: [
      { cx: 36.5, cy: 25.34, r: 4.14, gap: 6.34 },
      { cx: 6.08, cy: 31.22, r: 3.44, gap: 5.64 },
    ],
  },
} as const;

const ORBIT_TRANSFORM = "translate(24 24) rotate(-20)";
const ORBIT_COLOR = "var(--moon-orbit, var(--primary))";

/** MoonAgentic's mark. `currentColor` paints the moon; `--moon-orbit` overrides the orbit tint. */
export function MoonMark({
  detailed = false,
  ...props
}: SVGProps<SVGSVGElement> & { readonly detailed?: boolean }) {
  const id = useId();
  const g = detailed ? GEOMETRY.detailed : GEOMETRY.compact;
  const behind = `${id}-behind`;
  const front = `${id}-front`;
  return (
    <svg {...props} viewBox={g.viewBox} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id={behind} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <path d={g.crescent} fill="#000" stroke="#000" strokeWidth={g.crescentGap} />
        </mask>
        <mask id={front} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <path
            d={g.frontArc}
            transform={ORBIT_TRANSFORM}
            fill="none"
            stroke="#000"
            strokeWidth={g.arcGap}
          />
          {g.frontAgents.map((agent) => (
            <circle key={agent.cx} cx={agent.cx} cy={agent.cy} r={agent.gap} fill="#000" />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${behind})`}>
        <path
          d={g.backArc}
          transform={ORBIT_TRANSFORM}
          fill="none"
          stroke={ORBIT_COLOR}
          strokeWidth={g.ring}
          opacity={g.backOpacity}
          strokeLinecap="round"
        />
        <circle {...g.backAgent} fill={ORBIT_COLOR} opacity={0.72} />
      </g>
      <path d={g.crescent} fill="currentColor" mask={`url(#${front})`} />
      <path
        d={g.frontArc}
        transform={ORBIT_TRANSFORM}
        fill="none"
        stroke={ORBIT_COLOR}
        strokeWidth={g.ring}
        opacity={g.frontOpacity}
        strokeLinecap="round"
      />
      {g.frontAgents.map((agent) => (
        <circle
          key={agent.cx}
          cx={agent.cx}
          cy={agent.cy}
          r={agent.r}
          fill={ORBIT_COLOR}
          opacity={0.72}
        />
      ))}
    </svg>
  );
}

/** Horizontal lockup: mark plus "Moon" bold, "Agentic" regular. */
export function MoonAgenticWordmark({ className }: { readonly className?: string }) {
  return (
    <span className={className} role="img" aria-label="MoonAgentic">
      <MoonMark className="inline-block size-[1.35em] shrink-0 align-[-0.3em]" aria-hidden />
      <span className="ml-1.5 tracking-tight" aria-hidden>
        {/* oxlint-disable-next-line t3code/no-untranslated-copy -- product wordmark */}
        <b className="font-semibold">{"Moon"}</b>
        {/* oxlint-disable-next-line t3code/no-untranslated-copy -- product wordmark */}
        <span className="font-normal">{"Agentic"}</span>
      </span>
    </span>
  );
}
