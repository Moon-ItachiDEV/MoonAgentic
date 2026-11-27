import {
  type AgentInfo,
  type FavoriteRef,
  type Favorites,
  orderedFavorites,
} from "@moonagentic/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection } from "../connection.ts";
import { favoriteSuggestions } from "../favorite-suggestions.ts";
import { modelLabel } from "../model-label.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";

const same = (a: FavoriteRef, b: FavoriteRef) => a.agentId === b.agentId && a.model === b.model;
const keyOf = (r: FavoriteRef) => `${r.agentId}/${r.model}`;

const star = (agentId: string, model: string, starred: boolean) => {
  if (!connection.send({ type: "favorites.toggle", agentId, model, starred }))
    connection.notify("Pas de connexion au serveur MoonAgentic.");
};

/** The name a favorite is shown by: its agent's name for it, or its id before the list is known. */
const nameOf = (agent: AgentInfo | undefined, model: string) => {
  const known = agent?.models?.find((m) => m.id === model);
  return known ? modelLabel(known) : model;
};

/**
 * Réglages › Modèles: the favorites in the wheel's order (drag a line by its handle, or move it
 * with the arrow keys), models the app already picks to start from, and « Ajouter un favori »
 * for every model of every agent ready.
 */
export function ModelFavorites(props: { agents: AgentInfo[]; favorites: Favorites }) {
  const { agents, favorites } = props;
  const saved = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().favoriteOrder,
  );
  const order = orderedFavorites(favorites, saved);
  // While a line is dragged, the order on screen; sent when it is let go.
  const [moving, setMoving] = useState<{ key: string; order: FavoriteRef[] } | null>(null);
  // Sent but not yet back from the server: shown meanwhile, so quick key presses add up.
  const [sent, setSent] = useState<FavoriteRef[] | null>(null);
  useEffect(() => setSent(null), [saved, favorites]);
  const shown = moving?.order ?? sent ?? order;
  const list = useRef<HTMLDivElement>(null);
  // Stops listening to a drag still going when the page closes.
  const unlisten = useRef<(() => void) | null>(null);
  useEffect(() => () => unlisten.current?.(), []);
  const [query, setQuery] = useState("");
  // The check each agent had when « Lire ses modèles » was pressed: over once it has another.
  const [asked, setAsked] = useState<Record<string, number | null>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** « Modifier » shows what takes a favorite out. */
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!focusKey) return;
    // The moved line keeps the focus, for the next arrow key.
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const reorder = (next: FavoriteRef[]) => {
    setSent(next);
    if (!connection.send({ type: "favorites.reorder", order: next }))
      connection.notify("Pas de connexion au serveur MoonAgentic.");
  };

  const startDrag = (event: React.PointerEvent, ref: FavoriteRef) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let current = shown;
    setMoving({ key: keyOf(ref), order: current });
    const move = (e: PointerEvent) => {
      const rows = [...(list.current?.querySelectorAll<HTMLElement>(".fv") ?? [])];
      const from = current.findIndex((r) => same(r, ref));
      // The line goes where the pointer is, past the middle of its neighbour.
      let to = from;
      rows.forEach((row, i) => {
        const box = row.getBoundingClientRect();
        const middle = box.top + box.height / 2;
        if (i < from && e.clientY < middle && to === from) to = i;
        if (i > from && e.clientY > middle) to = i;
      });
      if (to === from) return;
      const next = current.filter((r) => !same(r, ref));
      next.splice(to, 0, ref);
      current = next;
      setMoving({ key: keyOf(ref), order: next });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
      unlisten.current = null;
    };
    const drop = () => {
      stop();
      if (current.some((r, i) => !same(r, shown[i]!))) reorder(current);
      setMoving(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
    unlisten.current = stop;
  };

  const nudge = (event: React.KeyboardEvent, ref: FavoriteRef) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const from = shown.findIndex((r) => same(r, ref));
    const to = from + (event.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= shown.length) return;
    const next = shown.filter((r) => !same(r, ref));
    next.splice(to, 0, ref);
    setFocusKey(keyOf(ref));
    reorder(next);
  };

  const discover = (agent: AgentInfo) => {
    if (!connection.send({ type: "agent.discover", agentId: agent.id })) {
      connection.notify("Pas de connexion au serveur MoonAgentic.");
      return;
    }
    setAsked((a) => ({ ...a, [agent.id]: agent.check?.at ?? null }));
  };
  const reading = (agent: AgentInfo) =>
    asked[agent.id] !== undefined && asked[agent.id] === (agent.check?.at ?? null);

  const suggestions = shown.length ? [] : favoriteSuggestions(agents, favorites);
  const ready = agents.filter((a) => a.available);
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const found = (agent: AgentInfo) =>
    matches(agent.name) || !!agent.models?.some((m) => matches(modelLabel(m)) || matches(m.id));
  const listed = ready.filter(found);

  return (
    <>
      <div className="gl2">
        Favoris
        <span className="sp" />
        {shown.length > 0 && (
          <button className="lk" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
            {editing ? "OK" : "Modifier"}
          </button>
        )}
      </div>
      <div className={`ins${editing ? " fved" : ""}`} ref={list}>
        {shown.map((ref, i) => {
          const agent = agents.find((a) => a.id === ref.agentId);
          const name = nameOf(agent, ref.model);
          const key = keyOf(ref);
          return (
            <div key={key} className={`it ro fv${moving?.key === key ? " drag" : ""}`}>
              <button
                className="fvx press"
                aria-label={`Retirer ${name} des favoris`}
                tabIndex={editing ? 0 : -1}
                onClick={() => star(ref.agentId, ref.model, false)}
              >
                <i />
              </button>
              <span className="tx">
                {name}
                <small>
                  {agent?.name ?? ref.agentId}
                  {agent && !agent.available ? " · indisponible" : ""}
                </small>
              </span>
              {shown.length > 1 && (
                <button
                  className="grip"
                  data-key={key}
                  aria-label={`Déplacer ${name}, rang ${i + 1} sur ${shown.length}. Flèches haut et bas pour le déplacer.`}
                  onPointerDown={(e) => startDrag(e, ref)}
                  onKeyDown={(e) => nudge(e, ref)}
                >
                  <I n="grip" s={18} />
                </button>
              )}
            </div>
          );
        })}
        <button className="it acc" onClick={() => setAdding(true)}>
          <I n="plus" s={18} />
          <span className="tx">Ajouter un favori</span>
        </button>
      </div>

      {suggestions.length > 0 && (
        <>
          <div className="gl2">
            Pour commencer
            <span className="sp" />
            {suggestions.length > 1 && (
              <button
                className="lk"
                onClick={() => suggestions.forEach((s) => star(s.agentId, s.model, true))}
              >
                Tout ajouter
              </button>
            )}
          </div>
          <div className="ins">
            {suggestions.map((s) => {
              const agent = agents.find((a) => a.id === s.agentId);
              const name = nameOf(agent, s.model);
              return (
                <button
                  key={`${s.agentId}/${s.model}`}
                  className="it fva"
                  aria-pressed={false}
                  aria-label={`Ajouter ${name} aux favoris`}
                  onClick={() => star(s.agentId, s.model, true)}
                >
                  <span className="tx">
                    {name}
                    <small>
                      {agent?.name} · {s.roles.join(", ")}
                    </small>
                  </span>
                  <span className="fvc">
                    <I n="check" s={14} />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <Sheet open={adding} onClose={() => setAdding(false)} title="Ajouter un favori" tall>
        <div className="sbody">
          <label className="fvs">
            <I n="search" s={17} />
            <input
              type="search"
              placeholder="Rechercher"
              aria-label="Rechercher un modèle"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !query) return;
                e.preventDefault();
                setQuery("");
              }}
            />
          </label>
          {listed.length === 0 && (
            <div className="fvn">{ready.length ? "Aucun modèle" : "Aucun agent prêt"}</div>
          )}
          {listed.map((agent) => {
            const models = agent.models;
            const agentHit = matches(agent.name);
            const rows = models?.filter((m) => agentHit || matches(modelLabel(m)) || matches(m.id));
            return (
              <div key={agent.id}>
                <div className="gl2">
                  {agent.name}
                  <span className="sp" />
                  {reading(agent) ? (
                    <span className="ppill" role="status">
                      Lecture des modèles…
                    </span>
                  ) : (
                    !models && (
                      <button className="lk" onClick={() => discover(agent)}>
                        {agent.modelsError ? "Réessayer" : "Lire ses modèles"}
                      </button>
                    )
                  )}
                </div>
                {!models && agent.modelsError && !reading(agent) && (
                  <div className="ins">
                    <div className="it ro">
                      <span className="tx">
                        <small className="erx">{agent.modelsError}</small>
                      </span>
                    </div>
                  </div>
                )}
                {!!rows?.length && (
                  <div className="ins">
                    {rows.map((m) => {
                      const rank = order.findIndex(
                        (r) => r.agentId === agent.id && r.model === m.id,
                      );
                      const on = rank >= 0;
                      const name = modelLabel(m);
                      return (
                        <button
                          key={m.id}
                          className="it fva"
                          aria-pressed={on}
                          aria-label={`${on ? "Retirer" : "Ajouter"} ${name} ${on ? "des" : "aux"} favoris`}
                          onClick={() => star(agent.id, m.id, !on)}
                        >
                          <span className="tx">{name}</span>
                          {on && <span className="fvr">{rank + 1}</span>}
                          <span className="fvc">
                            <I n="check" s={14} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
