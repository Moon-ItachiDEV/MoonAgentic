import type { SearchHit } from "@moonagentic/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { connection, newId, type State } from "../connection.ts";
import { IconChat, IconCompose, IconFolder, IconPin, IconSearch } from "./icons.tsx";

export interface QuickAction {
  label: string;
  icon: ReactNode;
  /** Keys shown beside it. */
  keys?: string;
  run: () => void;
}

interface Entry {
  key: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  keys?: string;
  run: () => void;
}

/** True when every character of `query` appears in `text`, in order. */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of text.toLowerCase()) if (ch === q[i]) i += 1;
  return i === q.length;
}

const SEARCH_DELAY_MS = 150;
const MAX_THREADS = 12;

/** Ctrl K: threads, projects, actions, and messages from every thread. */
export function QuickSearch(props: {
  state: State;
  actions: QuickAction[];
  onOpenThread: (threadId: string, itemId?: string) => void;
  onPickProject: (projectId: string) => void;
  onClose: () => void;
}) {
  const { state } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim();

  // Messages are searched on the server, which holds every thread's timeline.
  useEffect(() => {
    if (q.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      connection
        .ask({ type: "search", requestId: newId(), query: q })
        .then((reply) => current && setHits({ query: q, hits: reply.hits }))
        .catch(() => undefined);
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q]);

  const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? "";
  const threadTitle = (id: string) => state.threads.find((t) => t.id === id)?.title ?? "";
  const threads = state.threads
    .filter((t) => !q || fuzzyMatch(q, t.title))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
    .slice(0, q ? MAX_THREADS : 6);
  const entries: Entry[] = [
    ...props.actions
      .filter((a) => !q || fuzzyMatch(q, a.label))
      .map((a, i) => ({ key: `action:${i}`, group: "Actions", ...a })),
    ...threads.map((t) => ({
      key: `thread:${t.id}`,
      group: q ? "Fils" : "Fils récents",
      label: t.title,
      detail: projectName(t.projectId),
      icon: t.pinned ? <IconPin filled /> : <IconCompose size={15} />,
      run: () => props.onOpenThread(t.id),
    })),
    ...state.projects
      .filter((p) => q && fuzzyMatch(q, p.name))
      .map((p) => ({
        key: `project:${p.id}`,
        group: "Projets",
        label: p.name,
        detail: p.path,
        icon: <IconFolder size={15} />,
        run: () => props.onPickProject(p.id),
      })),
    ...(q.length >= 2 && hits?.query === q ? hits.hits : []).map((h) => ({
      key: `hit:${h.threadId}:${h.itemId}`,
      group: "Messages",
      label: h.snippet,
      detail: `${h.kind === "user" ? "Toi" : "Agent"} · ${threadTitle(h.threadId)}`,
      icon: <IconChat />,
      run: () => props.onOpenThread(h.threadId, h.itemId),
    })),
  ];
  const highlighted = Math.min(active, Math.max(0, entries.length - 1));

  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    props.onClose();
    entry.run();
  };

  let group = "";
  return (
    <div
      className="scrim qs-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="qs" role="dialog" aria-modal aria-label="Recherche rapide">
        <div className="qs-in">
          <IconSearch />
          <input
            autoFocus
            value={query}
            placeholder="Fils, messages, projets, actions…"
            aria-label="Rechercher"
            role="combobox"
            aria-expanded
            aria-controls="qs-list"
            aria-activedescendant={entries.length ? `qs-${highlighted}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(entries.length ? (highlighted + 1) % entries.length : 0);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(entries.length ? (highlighted - 1 + entries.length) % entries.length : 0);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(entries[highlighted]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              }
            }}
          />
          <kbd>Échap</kbd>
        </div>
        <div className="qs-list" id="qs-list" role="listbox" ref={list}>
          {entries.length === 0 && (
            <div className="qs-empty">
              {q.length >= 2 && hits?.query !== q ? "Je cherche…" : "Aucun résultat."}
            </div>
          )}
          {entries.map((entry, i) => {
            const heading = entry.group !== group ? (group = entry.group) : null;
            return (
              <div key={entry.key} role="presentation">
                {heading && <div className="qs-grp">{heading}</div>}
                <button
                  id={`qs-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === highlighted}
                  className={i === highlighted ? "on" : undefined}
                  onMouseMove={() => i !== highlighted && setActive(i)}
                  onClick={() => choose(entry)}
                >
                  <span className="qs-ic">{entry.icon}</span>
                  <span className="tx">
                    {entry.label}
                    {entry.detail && <small>{entry.detail}</small>}
                  </span>
                  {entry.keys && <kbd>{entry.keys}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
