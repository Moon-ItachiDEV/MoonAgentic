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
import { AgentBadge } from "./AgentBadge.tsx";
import { IconRefresh, IconSearch, IconStar, IconX } from "./icons.tsx";
import { StateGlyph } from "./StateGlyph.tsx";

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
 * with the arrow keys), models the app already picks to start from, and every model of every
 * agent ready, each with its star.
 */
export function ModelFavorites(props: { agents: AgentInfo[]; favorites: Favorites }) {
  const { agents, favorites } = props;
  const saved = useSyncExternalStore(connection.subscribe, connection.getState).favoriteOrder;
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
      const rows = [...(list.current?.querySelectorAll<HTMLElement>(".mf-fav") ?? [])];
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
      <p className="mf-lead">
        Tes favoris forment la roue du composer, dans cet ordre, et passent en premier partout où tu
        choisis un modèle : coordinateur, équipe, Planner, tâches planifiées.
      </p>

      <section className="mf-sec">
        <div className="mf-sh">
          <h2>Favoris</h2>
          {shown.length > 0 && <span className="mf-aux num">{shown.length}</span>}
          <span className="mf-sp" />
          {shown.length > 1 && (
            <span className="mf-hint">Glisse une ligne par sa poignée pour changer l'ordre</span>
          )}
        </div>
        {shown.length ? (
          <div className="mf-card" ref={list}>
            {shown.map((ref, i) => {
              const agent = agents.find((a) => a.id === ref.agentId);
              const name = nameOf(agent, ref.model);
              const key = keyOf(ref);
              return (
                <div key={key} className={`mf-row mf-fav${moving?.key === key ? " drag" : ""}`}>
                  {shown.length > 1 && (
                    <button
                      className="mf-grip"
                      data-key={key}
                      aria-label={`Déplacer ${name}, rang ${i + 1} sur ${shown.length}. Flèches haut et bas pour le déplacer.`}
                      onPointerDown={(e) => startDrag(e, ref)}
                      onKeyDown={(e) => nudge(e, ref)}
                    >
                      <Grip />
                    </button>
                  )}
                  <span className="mf-rank num">{i + 1}</span>
                  <AgentBadge agent={agent ?? { id: ref.agentId, short: "?" }} />
                  <span className="mf-tx">
                    <b>{name}</b>
                    <small>
                      {agent?.name ?? ref.agentId}
                      {agent?.defaultModel === ref.model ? " · par défaut" : ""}
                      {agent && !agent.available ? " · indisponible" : ""}
                    </small>
                  </span>
                  <button
                    className="mf-x"
                    aria-label={`Retirer ${name} des favoris`}
                    onClick={() => star(ref.agentId, ref.model, false)}
                  >
                    <IconX size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mf-card mf-empty">
            <span className="mf-ico">
              <IconStar size={17} />
            </span>
            <span className="mf-tx">
              <b>Aucun favori pour l'instant</b>
              <small>
                Touche l'étoile d'un modèle : il rejoint la roue du composer.
                {suggestions.length > 0 &&
                  " Tu peux aussi partir des modèles que l'app utilise déjà."}
              </small>
            </span>
          </div>
        )}
      </section>

      {suggestions.length > 0 && (
        <section className="mf-sec">
          <div className="mf-sh">
            <h2>Pour commencer</h2>
            <span className="mf-aux">Les modèles que l'app choisit déjà par défaut</span>
          </div>
          <div className="mf-card">
            {suggestions.map((s) => {
              const agent = agents.find((a) => a.id === s.agentId);
              const name = nameOf(agent, s.model);
              return (
                <div key={`${s.agentId}/${s.model}`} className="mf-row">
                  <AgentBadge agent={agent} />
                  <span className="mf-tx">
                    <b>{name}</b>
                    <small>
                      {agent?.name} · {s.roles.join(", ")}
                    </small>
                  </span>
                  <button
                    className="mf-star"
                    aria-pressed={false}
                    aria-label={`Ajouter ${name} aux favoris`}
                    onClick={() => star(s.agentId, s.model, true)}
                  >
                    <IconStar size={16} />
                  </button>
                </div>
              );
            })}
            <div className="mf-foot">
              <small>
                {suggestions.length > 1
                  ? `${suggestions.length} modèles, dans cet ordre dans la roue.`
                  : "Un modèle."}
              </small>
              {suggestions.length > 1 && (
                <button
                  className="btn pri sm"
                  onClick={() => suggestions.forEach((s) => star(s.agentId, s.model, true))}
                >
                  <IconStar size={13} />
                  Tout ajouter
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="mf-sec">
        <div className="mf-sh">
          <h2>Tous les modèles</h2>
          <span className="mf-sp" />
          <label className="mf-find">
            <IconSearch size={14} />
            <input
              type="search"
              placeholder="Rechercher un modèle"
              aria-label="Rechercher un modèle"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            />
          </label>
        </div>
        <div className="mf-card">
          {ready.length === 0 && (
            <p className="mf-none">Aucun agent prêt. Vérifie-les dans Réglages › Agents.</p>
          )}
          {ready.length > 0 && listed.length === 0 && (
            <p className="mf-none">Aucun modèle ne contient « {query.trim()} ».</p>
          )}
          {listed.map((agent) => {
            const models = agent.models;
            const agentHit = matches(agent.name);
            const rows = models?.filter((m) => agentHit || matches(modelLabel(m)) || matches(m.id));
            return (
              <div key={agent.id} className="mf-grp">
                <div className="mf-gh">
                  <AgentBadge agent={agent} />
                  <b>{agent.name}</b>
                  {models && (
                    <small className="num">
                      {models.length} modèle{models.length > 1 ? "s" : ""}
                    </small>
                  )}
                </div>
                {reading(agent) ? (
                  <div className="mf-work">
                    <StateGlyph kind="lit" size={13} />
                    Démarrage de {agent.name} pour lire ses modèles…
                  </div>
                ) : !models ? (
                  <div className="mf-unk">
                    <span>
                      {agent.modelsError
                        ? `${agent.name} n'a pas donné ses modèles : ${agent.modelsError}`
                        : "Ses modèles ne sont pas encore connus : il n'a pas encore démarré sur cette machine."}
                    </span>
                    <button className="btn acc sm" onClick={() => discover(agent)}>
                      <IconRefresh size={13} />
                      {agent.modelsError ? "Réessayer" : "Lire ses modèles"}
                    </button>
                  </div>
                ) : (
                  rows?.map((m) => {
                    const rank = order.findIndex((r) => r.agentId === agent.id && r.model === m.id);
                    const on = rank >= 0;
                    const name = modelLabel(m);
                    return (
                      <div key={m.id} className="mf-row mf-m">
                        <span className="mf-tx">
                          <b>{name}</b>
                        </span>
                        {agent.defaultModel === m.id && <span className="mf-pill">Par défaut</span>}
                        {on && <span className="mf-pill on num">{rank + 1}</span>}
                        <button
                          className="mf-star"
                          aria-pressed={on}
                          aria-label={`${on ? "Retirer" : "Ajouter"} ${name} ${on ? "des" : "aux"} favoris`}
                          onClick={() => star(agent.id, m.id, !on)}
                        >
                          <IconStar size={16} filled={on} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

const Grip = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden>
    <g fill="currentColor">
      <circle cx="2.5" cy="3" r="1.3" />
      <circle cx="7.5" cy="3" r="1.3" />
      <circle cx="2.5" cy="8" r="1.3" />
      <circle cx="7.5" cy="8" r="1.3" />
      <circle cx="2.5" cy="13" r="1.3" />
      <circle cx="7.5" cy="13" r="1.3" />
    </g>
  </svg>
);
