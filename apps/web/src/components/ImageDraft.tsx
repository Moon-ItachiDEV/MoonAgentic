import { useEffect, useState } from "react";

/**
 * Where the image an agent is generating will appear: a grid of dots, lit as a wave passes
 * over it, and the time spent so far. No agent tells how far along its image is, so no
 * percentage is shown: the wave says it is at work, the seconds are real.
 */
export function ImageDraft({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const elapsed =
    seconds < 60
      ? `${seconds} s`
      : `${Math.floor(seconds / 60)} min ${`${seconds % 60}`.padStart(2, "0")}`;
  return (
    <div className="img-draft" role="status" aria-label="Création de l'image en cours">
      <span className="img-draft-label shimmer">Crée l'image…</span>
      <div className="img-draft-canvas" aria-hidden>
        <span className="img-draft-time">{elapsed}</span>
      </div>
    </div>
  );
}
