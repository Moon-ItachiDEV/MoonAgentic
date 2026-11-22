import type { AgentInfo, PlanTask, Thread } from "@moonagentic/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { planLabel, timeline, timelineTicks } from "../planner.ts";

const BAR = 30;
const GAP = 6;
const PAD = 10;

/** Pixels a day takes: wide by week, narrow by month; one width on a phone. */
const dayWidth = (zoom: "sem" | "mois", narrow: boolean) =>
  narrow ? 22 : zoom === "sem" ? 32 : 16;

/**
 * The planner's cards over time, a lane per agent. A bar is drawn from real dates once its
 * work began (solid), and from the planned ones before (dashed). It moves only while its
 * thread really runs.
 */
export function PlanTimeline({
  cards,
  threads,
  agents,
  zoom,
  onOpen,
}: {
  cards: PlanTask[];
  threads: Thread[];
  agents: AgentInfo[];
  zoom: "sem" | "mois";
  onOpen: (id: string) => void;
}) {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 860);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth <= 860);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  // The day changes while the page stays open: looked at again every minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const px = dayWidth(zoom, narrow);
  const t = timeline(cards, threads, agents, now, px);
  const ticks = timelineTicks(t.from, t.days);
  const label = narrow ? 104 : 168;
  const x = (day: number) => label + day * px;

  // Opens on today, a third of the way in; a change of zoom comes back to it.
  const scroller = useRef<HTMLDivElement>(null);
  const todayX = x(t.today);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, todayX - label - (el.clientWidth - label) / 3);
    // Only when the scale changes: new cards must not move what the user is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [px, label]);

  if (cards.length === 0) {
    return <div className="pl-tl-none">Aucune tâche à placer dans le temps.</div>;
  }

  return (
    <div className="pl-tl" ref={scroller} role="region" aria-label="Timeline">
      <div className="pl-tl-in" style={{ width: x(t.days) + 24 }}>
        <div className="pl-tl-head">
          <div className="pl-tl-corner" style={{ width: label }} />
          {ticks.months.map((m, i) => (
            // The month's name stays in view for as long as its days are.
            <div
              key={`m${m.day}`}
              className="m"
              style={{
                left: x(m.day),
                width: ((ticks.months[i + 1]?.day ?? t.days) - m.day) * px,
              }}
            >
              <span style={{ left: label }}>{m.label}</span>
            </div>
          ))}
          {ticks.weeks.map((w) => (
            <span key={`w${w.day}`} className="w" style={{ left: x(w.day) + 6 }}>
              {w.label}
            </span>
          ))}
          <span className="pl-tl-pill" style={{ left: todayX + px / 2 }}>
            Aujourd'hui
          </span>
        </div>
        <div className="pl-tl-grid" aria-hidden>
          {ticks.weeks
            .filter((w) => w.day > 0)
            .map((w) => (
              <i key={`w${w.day}`} style={{ left: x(w.day) }} />
            ))}
          {ticks.months
            .filter((m) => m.day > 0)
            .map((m) => (
              <i key={`m${m.day}`} className="mo" style={{ left: x(m.day) }} />
            ))}
          <i className="today" style={{ left: todayX + px / 2 }} />
        </div>
        {t.lanes.map((lane) => (
          <section
            key={lane.name}
            className="pl-tl-lane"
            aria-label={lane.name || "Sans agent"}
            style={{ height: PAD * 2 + lane.rows * BAR + (lane.rows - 1) * GAP }}
          >
            <div className="pl-tl-who" style={{ width: label }}>
              <b>{lane.name || "Sans agent"}</b>
              <small>
                {lane.bars.length} tâche{lane.bars.length > 1 ? "s" : ""}
              </small>
            </div>
            {lane.bars.map((bar) => (
              <button
                key={bar.card.id}
                className={`pl-tl-bar s-${bar.card.status}${bar.planned ? " planned" : ""}${bar.tight ? " tight" : ""}${
                  bar.work.tone ? ` t-${bar.work.tone}` : ""
                }`}
                style={{
                  left: x(bar.day) + 1,
                  width: bar.days * px - 2,
                  top: PAD + bar.row * (BAR + GAP),
                  height: BAR,
                }}
                title={`#${bar.card.number} ${bar.card.title}`}
                aria-label={`Tâche ${bar.card.number} : ${bar.card.title}, ${planLabel(bar.card.status)}${
                  bar.work.label ? `, ${bar.work.label}` : ""
                }`}
                onClick={() => onOpen(bar.card.id)}
              >
                <i />
                <span>{bar.card.title}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
