/** The colour a share of a subscription is drawn in: quiet, then amber near the limit, red at it. */
export const usageColor = (percent: number): string =>
  percent >= 100 ? "var(--err)" : percent >= 80 ? "#d4901c" : "var(--accent)";

/** A share used, as a ring around its figure. */
export function Ring({ percent }: { percent: number }) {
  const r = 12.5;
  const around = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, percent));
  return (
    <span className="ring">
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r={r} fill="none" stroke="var(--track)" strokeWidth="3" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          stroke={usageColor(percent)}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${((around * shown) / 100).toFixed(1)} ${around.toFixed(1)}`}
        />
      </svg>
      <b>{Math.min(999, Math.round(percent))}</b>
    </span>
  );
}
