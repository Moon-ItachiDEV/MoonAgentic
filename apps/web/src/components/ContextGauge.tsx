import type { ContextUsage } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { money } from "../status.ts";

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`
    : n >= 1000
      ? `${Math.round(n / 1000).toLocaleString("fr-FR")} k`
      : n.toLocaleString("fr-FR");

const RADIUS = 7;
const CIRCLE = 2 * Math.PI * RADIUS;

/** How full the agent's context is, with an action such as compacting it. */
export function ContextGauge({
  usage,
  action,
}: {
  usage: ContextUsage;
  action?: { label: string; disabled: boolean; run: () => void } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const share = Math.min(1, usage.used / usage.size);
  const percent = Math.round(share * 100);
  const level = share >= 0.9 ? " full" : share >= 0.7 ? " high" : "";

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="gauge-wrap" ref={root}>
      <button
        className={`gauge${level}`}
        aria-label={`Contexte utilisé : ${percent} %`}
        aria-expanded={open}
        title={`Contexte utilisé : ${percent} %`}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <circle className="track" cx="9" cy="9" r={RADIUS} />
          <circle
            className="fill"
            cx="9"
            cy="9"
            r={RADIUS}
            strokeDasharray={`${share * CIRCLE} ${CIRCLE}`}
          />
        </svg>
      </button>
      {open && (
        <div className="gauge-pop" role="dialog" aria-label="Contexte de l'agent">
          <b>Contexte : {percent} %</b>
          <span>
            {tokens(usage.used)} sur {tokens(usage.size)} jetons
          </span>
          {usage.cost && <span>Coût de ce fil : {money(usage.cost)}</span>}
          {action && (
            <button
              className="btn sm"
              disabled={action.disabled}
              onClick={() => {
                action.run();
                setOpen(false);
              }}
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
