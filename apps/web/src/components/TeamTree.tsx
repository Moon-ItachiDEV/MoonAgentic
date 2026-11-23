import type { AgentInfo, Team, Thread } from "@moonagentic/protocol";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { money } from "../status.ts";
import {
  coderKey,
  LEAD,
  memberThreadIds,
  MERGE,
  PR,
  teamTree,
  TOOL_LABEL,
  type Relay,
  type Tone,
  type ToolGroup,
  type TreeNode,
} from "../team-tree.ts";
import { useThreadItems } from "../use-thread-items.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { StateGlyph } from "./StateGlyph.tsx";

const NS = "http://www.w3.org/2000/svg";
/** How long the light of an arrival stays on a card. */
const GLOW_MS = 1250;

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`
    : n >= 1000
      ? `${Math.round(n / 1000).toLocaleString("fr-FR")} k`
      : n.toLocaleString("fr-FR");
const clock = (at: number) =>
  new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const toneColor = (tone: Tone) =>
  tone === "warn" ? "var(--warn)" : tone === "ok" ? "var(--ok)" : "var(--accent)";

const TOOL_ICON: Record<ToolGroup, string> = {
  read: "M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12M6 8h4M6 10.5h4",
  edit: "M10.5 3 13 5.5 6 12.5H3.5V10zM9 4.5l2.5 2.5",
  search: "M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM10 10l3.5 3.5",
  run: "M4 3h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM5 6.5 7 8l-2 1.5M8.5 10H11",
  web: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12",
  other: "M8 2.5v11M2.5 8h11",
};
const ToolIcon = ({ group }: { group: ToolGroup }) => (
  <svg viewBox="0 0 16 16" aria-hidden>
    <path
      d={TOOL_ICON[group]}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const RelayIcon = () => (
  <svg viewBox="0 0 12 12" aria-hidden>
    <path
      d="M2.5 2v3.5a2 2 0 0 0 2 2h5M7.5 5.2l2.3 2.3-2.3 2.3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** How full a context is, from 0 to 1: an agent that gives no size has an empty bar. */
const shareOf = (usage: { used: number; size: number }) =>
  usage.size > 0 ? Math.min(1, Math.max(0, usage.used / usage.size)) : 0;

function Chip({ node }: { node: Pick<TreeNode, "tone" | "label" | "glyph"> }) {
  return (
    <span className="tt-chip" data-tone={node.tone}>
      {node.glyph ? (
        <StateGlyph kind={node.glyph} size={13} />
      ) : node.tone === "ok" ? (
        <svg viewBox="0 0 12 12" aria-hidden>
          <path
            d="m2.5 6.2 2.3 2.3 4.7-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : node.tone === "warn" || node.tone === "err" ? (
        <svg viewBox="0 0 12 12" aria-hidden>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M6 3.6v2.8M6 8.3v.1"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <i className="tt-dot" />
      )}
      {/* Remounted when the state changes, so the new word eases in. */}
      <em key={node.label}>{node.label}</em>
    </span>
  );
}

const Bar = ({ usage }: { usage: NonNullable<TreeNode["usage"]> }) => {
  const share = shareOf(usage);
  return (
    <span className="tt-track">
      <i
        className={share >= 0.9 ? "full" : share >= 0.7 ? "high" : ""}
        style={{ width: `${share * 100}%` }}
      />
    </span>
  );
};

const Card = memo(function Card({
  node,
  short,
  from,
  selected,
  onSelect,
}: {
  node: TreeNode;
  /** The agent's two letters, for an agent that has no logo. */
  short: string | undefined;
  /** The name of whoever handed it its last relay. */
  from: string | undefined;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      className={`tt-card${node.role === "lead" ? " lead" : ""}${node.role === "reviewer" || node.role === "tester" ? " sub" : ""}${node.tone === "work" ? " work" : ""}${node.pending ? " pending" : ""}${selected ? " sel" : ""}`}
      data-key={node.key}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.name}, ${node.sub} : ${node.label}`}
      onClick={() => onSelect(node.key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.key);
        }
      }}
    >
      <i className="tt-wash" />
      <div className="tt-top">
        <AgentBadge agent={{ id: node.agentId, short: short ?? "?" }} />
        <div className="tt-name">
          <b title={node.name}>{node.name}</b>
          <span>{node.sub}</span>
        </div>
        <Chip node={node} />
      </div>
      {node.action && (
        <div className="tt-act" key={node.action} title={node.action}>
          {node.action}
        </div>
      )}
      {node.usage && (
        <div className="tt-ctx">
          <Bar usage={node.usage} />
          <span>
            {tokens(node.usage.used)} / {tokens(node.usage.size)}
          </span>
        </div>
      )}
      {(node.tools.length > 0 || node.relay) && (
        <div className="tt-foot">
          {node.tools.length > 0 && (
            <span className="tt-tools">
              {node.tools.slice(0, 4).map(([group, n]) => (
                <span key={group} title={`${TOOL_LABEL[group]} · ${n}`}>
                  <ToolIcon group={group} />
                </span>
              ))}
            </span>
          )}
          {node.relay && (
            <span className="tt-relay" key={node.relay.at} data-tone={node.relay.tone}>
              <RelayIcon />
              <b>{from}</b> {node.relay.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

type Point = [number, number];
interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
  cx: number;
  my: number;
}

/** A path through the points, its corners rounded. */
function roundPath(points: Point[], radius = 10): string {
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[i + 1]!;
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    if (l1 < 0.5 || l2 < 0.5) continue;
    const r = Math.min(radius, l1 / 2, l2 / 2);
    d += ` L${x1 - ((x1 - x0) / l1) * r},${y1 - ((y1 - y0) / l1) * r} Q${x1},${y1} ${x1 + ((x2 - x1) / l2) * r},${y1 + ((y2 - y1) / l2) * r}`;
  }
  const last = points.at(-1)!;
  return `${d} L${last[0]},${last[1]}`;
}

const isSub = (key: string) => key[0] === "r" || key[0] === "t";
const isCoder = (key: string) => key[0] === "c";
const column = (key: string) => key.slice(1);

/**
 * The way from one card to another along the tree's links, or nothing when the two are not
 * linked. Written from parent to child; a relay going back up takes it the other way round.
 */
function way(rects: Record<string, Rect>, from: string, to: string): Point[] | undefined {
  const a = rects[from];
  const b = rects[to];
  if (!a || !b) return undefined;
  if (from === LEAD && isCoder(to)) {
    const coders = Object.keys(rects).filter(isCoder);
    const bus = (a.b + Math.min(...coders.map((k) => rects[k]!.t))) / 2;
    return [
      [a.cx, a.b],
      [a.cx, bus],
      [b.cx, bus],
      [b.cx, b.t],
    ];
  }
  if (isCoder(from) && isSub(to) && column(from) === column(to)) {
    const x = a.l + 16;
    return [
      [x, a.b],
      [x, b.my],
      [b.l, b.my],
    ];
  }
  if (from[0] === "r" && to[0] === "t" && column(from) === column(to)) {
    const coder = rects[coderKey(Number(column(from)))];
    if (!coder) return undefined;
    const x = coder.l + 16;
    return [
      [x, a.my],
      [x, b.my],
      [b.l, b.my],
    ];
  }
  if ((to === MERGE || to === PR) && from !== LEAD) {
    if (from === MERGE) {
      return [
        [a.cx, a.b],
        [b.cx, b.t],
      ];
    }
    const ends = Object.keys(rects).filter((k) => isCoder(k) || isSub(k));
    const bus = (Math.max(...ends.map((k) => rects[k]!.b)) + b.t) / 2;
    return [
      [a.cx, a.b],
      [a.cx, bus],
      [b.cx, bus],
      [b.cx, b.t],
    ];
  }
  return undefined;
}

/** The points a relay runs along, in the direction it goes. */
function relayWay(rects: Record<string, Rect>, relay: Relay): Point[] | undefined {
  const down = way(rects, relay.from, relay.to);
  if (down) return down;
  // Back to the lead: up the link of the piece's coder.
  const from =
    relay.to === LEAD && isSub(relay.from) ? coderKey(Number(column(relay.from))) : relay.from;
  return way(rects, relay.to, from)?.toReversed();
}

/** The links drawn at rest: `from>to`, parent first. */
function links(model: ReturnType<typeof teamTree>): [string, string][] {
  const out: [string, string][] = [];
  const sink = model.merger ? MERGE : model.pr ? PR : undefined;
  for (const piece of model.pieces) {
    out.push([LEAD, piece.coder.key]);
    if (piece.reviewer) out.push([piece.coder.key, piece.reviewer.key]);
    if (piece.tester) out.push([piece.reviewer?.key ?? piece.coder.key, piece.tester.key]);
    const end = piece.tester ?? piece.reviewer ?? piece.coder;
    if (sink) out.push([end.key, sink]);
  }
  if (model.merger && model.pr) out.push([MERGE, PR]);
  return out;
}

interface Pulse {
  relay: Relay;
  start: number;
  ms: number;
  length: number;
  measure: SVGPathElement;
  group: SVGGElement;
  tails: { el: SVGPathElement; length: number; opacity: number }[];
  head: SVGCircleElement;
  halo: SVGCircleElement;
  end: Point;
}
interface Glow {
  key: string;
  start: number;
  tone: Tone;
  at: Point | undefined;
}

/**
 * A team as a living tree of cards. Each card says what its agent does now, how full its
 * context is, the tools it used and the last thing it was handed. A relay runs as a light
 * along the link and lights the card it reaches; it runs only when the team's timeline
 * records one. A click on a card opens what there is to know about its agent.
 */
export function TeamTree({
  lead,
  team,
  threads,
  agents,
  onOpenThread,
}: {
  lead: Thread;
  team: Team;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
}) {
  const ids = useMemo(() => [lead.id, ...memberThreadIds(team)], [lead.id, team]);
  const items = useThreadItems(ids);
  const model = useMemo(
    () => teamTree({ lead, team, threads, agents, items }),
    [lead, team, threads, agents, items],
  );

  const tree = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pulseLayer = useRef<SVGGElement>(null);
  const rects = useRef<Record<string, Rect>>({});
  const [geo, setGeo] = useState<{ w: number; h: number; paths: Record<string, string> }>({
    w: 0,
    h: 0,
    paths: {},
  });
  const shape = links(model)
    .map((l) => l.join(">"))
    .join(" ");
  const modelRef = useRef(model);
  modelRef.current = model;

  // Where the cards are, and the links between them: measured, since cards size themselves.
  const measure = useCallback(() => {
    const root = tree.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const el of root.querySelectorAll<HTMLElement>("[data-key]")) {
      const r = el.getBoundingClientRect();
      const l = r.left - origin.left;
      const t = r.top - origin.top;
      // The lead's card sits in a tray that goes a little past it.
      const pad = el.dataset.key === LEAD ? 6 : 0;
      next[el.dataset.key!] = {
        l,
        t,
        r: l + r.width,
        b: t + r.height + pad,
        cx: l + r.width / 2,
        my: t + r.height / 2,
      };
    }
    rects.current = next;
    const paths: Record<string, string> = {};
    for (const [from, to] of links(modelRef.current)) {
      const points = way(next, from, to);
      if (points) paths[`${from}>${to}`] = roundPath(points);
    }
    setGeo((old) => {
      const w = root.scrollWidth;
      const h = root.scrollHeight;
      const same =
        old.w === w &&
        old.h === h &&
        Object.keys(paths).length === Object.keys(old.paths).length &&
        Object.entries(paths).every(([k, d]) => old.paths[k] === d);
      return same ? old : { w, h, paths };
    });
  }, []);
  useLayoutEffect(measure, [measure, shape]);
  useEffect(() => {
    const root = tree.current;
    if (!root || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const el of root.querySelectorAll("[data-key]")) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, shape]);

  // The lights: relays on their way, and cards still lit by one that arrived.
  const pulses = useRef<Pulse[]>([]);
  const glows = useRef<Glow[]>([]);
  const frame = useRef(0);
  const tick = useCallback((now: number) => {
    frame.current = 0;
    const root = tree.current;
    if (!root) return;
    pulses.current = pulses.current.filter((p) => {
      const x = Math.min(1, (now - p.start) / p.ms);
      if (x >= 1) {
        p.group.remove();
        glows.current.push({ key: p.relay.to, start: now, tone: p.relay.tone, at: p.end });
        return false;
      }
      // Leaves gently, arrives gently.
      const k = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
      const pos = p.length * k;
      const fade = Math.min(1, x * 8) * Math.min(1, (1 - x) * 5);
      // The tail is longest at full speed.
      const stretch = 0.55 + 0.45 * Math.sin(Math.PI * x);
      for (const tail of p.tails) {
        const from = Math.max(0, pos - tail.length * stretch);
        tail.el.setAttribute("stroke-dasharray", `${Math.max(0.01, pos - from)} ${p.length * 3}`);
        tail.el.setAttribute("stroke-dashoffset", String(-from));
        tail.el.setAttribute("opacity", String(tail.opacity * fade));
      }
      const pt = p.measure.getPointAtLength(pos);
      for (const dot of [p.head, p.halo]) {
        dot.setAttribute("cx", String(pt.x));
        dot.setAttribute("cy", String(pt.y));
      }
      p.head.setAttribute("opacity", String(fade));
      p.halo.setAttribute("opacity", String(0.16 * fade));
      return true;
    });
    glows.current = glows.current.filter((g) => {
      const el = root.querySelector<HTMLElement>(`[data-key="${g.key}"]`);
      if (!el) return false;
      const left = 1 - (now - g.start) / GLOW_MS;
      if (left <= 0) {
        for (const name of ["--g", "--gc", "--wo", "--wr", "--ex", "--ey"]) {
          el.style.removeProperty(name);
        }
        el.classList.remove("lit");
        return false;
      }
      const rect = rects.current[g.key];
      el.classList.add("lit");
      el.style.setProperty("--gc", toneColor(g.tone));
      el.style.setProperty("--g", (left * left).toFixed(3));
      el.style.setProperty("--wo", Math.min(1, left * 1.6).toFixed(3));
      // The light enters where the link meets the card, and washes across it.
      el.style.setProperty(
        "--wr",
        `${reducedMotion() ? 420 : Math.round(24 + (1 - Math.pow(left, 3)) * 400)}px`,
      );
      if (rect && g.at) {
        el.style.setProperty("--ex", `${Math.round(g.at[0] - rect.l)}px`);
        el.style.setProperty("--ey", `${Math.round(g.at[1] - rect.t)}px`);
      }
      return true;
    });
    if (pulses.current.length || glows.current.length) frame.current = requestAnimationFrame(tick);
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      for (const p of pulses.current) p.group.remove();
      pulses.current = [];
      glows.current = [];
    },
    [],
  );

  // A relay runs when the timeline gains one while the tree is on screen: what happened
  // before it was opened is not played again.
  const lastAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    const newest = model.relays.at(-1)?.at ?? 0;
    if (lastAt.current === undefined) {
      lastAt.current = newest;
      return;
    }
    const fresh = model.relays.filter((r) => r.at > lastAt.current!);
    lastAt.current = Math.max(lastAt.current, newest);
    const layer = pulseLayer.current;
    if (!fresh.length || !layer) return;
    const now = performance.now();
    for (const relay of fresh) {
      const points = relayWay(rects.current, relay);
      const end = points?.at(-1);
      if (!points || reducedMotion()) {
        // No travel: the card that receives still takes the light.
        glows.current.push({ key: relay.to, start: now, tone: relay.tone, at: end });
        continue;
      }
      const d = roundPath(points);
      const color = toneColor(relay.tone);
      const group = document.createElementNS(NS, "g");
      const path = (width: number) => {
        const el = document.createElementNS(NS, "path");
        el.setAttribute("d", d);
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", color);
        el.setAttribute("stroke-width", String(width));
        el.setAttribute("stroke-linecap", "round");
        group.appendChild(el);
        return el;
      };
      const measureEl = path(0);
      // Three strokes on top of each other: a long faint tail down to a short bright core.
      const tails = (
        [
          [96, 5, 0.1],
          [54, 2.6, 0.35],
          [22, 2.6, 1],
        ] as const
      ).map(([length, width, opacity]) => ({ el: path(width), length, opacity }));
      const dot = (r: number) => {
        const el = document.createElementNS(NS, "circle");
        el.setAttribute("r", String(r));
        el.setAttribute("fill", color);
        group.appendChild(el);
        return el;
      };
      const halo = dot(8);
      const head = dot(3.2);
      layer.appendChild(group);
      const length = measureEl.getTotalLength();
      pulses.current.push({
        relay,
        start: now,
        // A longer link takes longer, within reason.
        ms: Math.min(950, Math.max(550, length * 2.5)),
        length,
        measure: measureEl,
        group,
        tails,
        head,
        halo,
        end: end!,
      });
    }
    if (!frame.current) frame.current = requestAnimationFrame(tick);
  }, [model.relays, tick]);

  // The links a relay has already taken stay a little darker: the work done so far.
  const went = useMemo(() => {
    const set = new Set<string>();
    for (const r of model.relays) {
      set.add(`${r.from}>${r.to}`);
      set.add(`${r.to}>${r.from}`);
    }
    return set;
  }, [model.relays]);

  const [selected, setSelected] = useState<string>();
  const opener = useRef<HTMLElement | null>(null);
  const select = useCallback((key: string) => {
    opener.current = document.activeElement as HTMLElement | null;
    setSelected((now) => (now === key ? undefined : key));
  }, []);
  const close = useCallback(() => {
    setSelected(undefined);
    opener.current?.focus({ preventScroll: true });
  }, []);
  const chosen = selected ? model.nodes[selected] : undefined;
  useEffect(() => {
    if (!chosen) return;
    const escape = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [chosen, close]);
  // The drawer covers the right of the tree: the chosen card is brought back into view.
  useEffect(() => {
    const el = chosen && tree.current?.querySelector<HTMLElement>(`[data-key="${chosen.key}"]`);
    const box = scroller.current;
    if (!el || !box) return;
    const over = el.getBoundingClientRect().right + 24 - (box.getBoundingClientRect().right - 340);
    if (over > 0) box.scrollBy({ left: over, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [chosen?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (key: string | undefined) =>
    key === PR ? "MoonAgentic" : key ? model.nodes[key]?.name : undefined;
  const shortOf = (id: string) => agents.find((a) => a.id === id)?.short;
  const card = (node: TreeNode) => (
    <Card
      key={node.key}
      node={node}
      short={shortOf(node.agentId)}
      from={nameOf(node.relay?.from)}
      selected={selected === node.key}
      onSelect={select}
    />
  );
  const share = chosen?.usage ? shareOf(chosen.usage) : 0;

  return (
    <div className={`tt${chosen ? " open" : ""}`}>
      <div className="tt-scroll" ref={scroller}>
        <div className="tt-tree" ref={tree}>
          <svg className="tt-wires" width={geo.w} height={geo.h} aria-hidden>
            {Object.entries(geo.paths).map(([key, d]) => (
              <path key={key} d={d} className={went.has(key) ? "went" : undefined} />
            ))}
            <g ref={pulseLayer} />
          </svg>
          <div className="tt-row">{card(model.lead)}</div>
          {model.pieces.length > 0 && (
            <div className="tt-cols">
              {model.pieces.map((piece) => (
                <div className="tt-col" key={piece.coder.key}>
                  {card(piece.coder)}
                  {piece.reviewer && card(piece.reviewer)}
                  {piece.tester && card(piece.tester)}
                </div>
              ))}
            </div>
          )}
          {model.merger && <div className="tt-row tt-fuse">{card(model.merger)}</div>}
          {model.pr && (
            <div className="tt-row tt-ship">
              {model.pr.url ? (
                <a
                  className="tt-pr"
                  data-key={PR}
                  data-tone={model.pr.tone}
                  href={model.pr.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <i className="tt-wash" />
                  <span key={model.pr.label}>{model.pr.label}</span>
                </a>
              ) : (
                <span className="tt-pr" data-key={PR} data-tone={model.pr.tone}>
                  <i className="tt-wash" />
                  <span key={model.pr.label}>{model.pr.label}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <aside className="tt-panel" aria-label="Détail de l'agent" inert={!chosen}>
        {chosen && (
          <>
            <header className="tt-p-head">
              <AgentBadge agent={{ id: chosen.agentId, short: shortOf(chosen.agentId) ?? "?" }} />
              <div className="tt-name">
                <b title={chosen.name}>{chosen.name}</b>
                <span>{chosen.sub}</span>
              </div>
              <Chip node={chosen} />
              <button className="ib" aria-label="Fermer" onClick={close}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path
                    d="m3 3 8 8M11 3l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </header>
            <div className="tt-p-body">
              <section>
                <h3>Sa mission</h3>
                <p className="tt-mission">{chosen.mission}</p>
              </section>
              {chosen.action && (
                <section>
                  <h3>En ce moment</h3>
                  <p>{chosen.action}</p>
                </section>
              )}
              {chosen.usage && (
                <section>
                  <h3>Contexte</h3>
                  <Bar usage={chosen.usage} />
                  <p className="tt-meta">
                    {tokens(chosen.usage.used)} sur {tokens(chosen.usage.size)} jetons ·{" "}
                    {Math.round(share * 100)} %
                    {chosen.usage.cost && ` · Coût de ce fil : ${money(chosen.usage.cost)}`}
                  </p>
                </section>
              )}
              {(chosen.relay || chosen.sent) && (
                <section>
                  <h3>Relais</h3>
                  {chosen.relay && (
                    <p className="tt-rel">
                      <b>Reçu</b>
                      <span>
                        de {nameOf(chosen.relay.from)} · {chosen.relay.text}
                      </span>
                    </p>
                  )}
                  {chosen.sent && (
                    <p className="tt-rel">
                      <b>Envoyé</b>
                      <span>
                        à {nameOf(chosen.sent.to)} · {chosen.sent.text}
                      </span>
                    </p>
                  )}
                </section>
              )}
              {chosen.steps.length > 0 && (
                <section>
                  <h3>Ce qu'il a fait</h3>
                  <ul className="tt-hist">
                    {chosen.steps.map((step, i) => (
                      <li key={`${step.at}-${i}`}>
                        <time>{clock(step.at)}</time>
                        <span title={step.text}>{step.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {chosen.tools.length > 0 && (
                <section>
                  <h3>Outils</h3>
                  <div className="tt-tl">
                    {chosen.tools.map(([group, n]) => (
                      <span key={group}>
                        <ToolIcon group={group} />
                        {TOOL_LABEL[group]} <b>{n}</b>
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>
            <footer className="tt-p-acts">
              <button
                className="btn pri sm"
                disabled={!chosen.threadId}
                onClick={() => chosen.threadId && onOpenThread(chosen.threadId)}
              >
                Ouvrir son fil
              </button>
              {!chosen.threadId && <span className="tt-meta">Pas encore démarré</span>}
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
