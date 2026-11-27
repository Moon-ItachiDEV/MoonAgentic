import type {
  AgentInfo,
  CoordinatorSettings,
  Favorites,
  Item,
  Project,
  Thread,
} from "@moonagentic/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { looseDefault } from "../default-models.ts";
import { effortOf } from "../effort.ts";
import { renameKey, sendRename } from "../rename.ts";
import { useThreadModel } from "../thread-model.ts";
import { Dropdown } from "../v2/Dropdown.tsx";
import { I } from "../v2/I.tsx";
import { ModelChip, ModelLines, type Route } from "../v2/ModelChip.tsx";
import { type Section, SettingsWindow } from "../v2/SettingsWindow.tsx";
import type { IconName } from "../v2/sprite.ts";
import { useExit } from "../v2/use-exit.ts";
import { useScreen } from "../v2/use-screen.ts";
import { ProjectIcon } from "./ProjectIcon.tsx";
import { Row, routeName, Toggle } from "./ProjectSettings.tsx";

type DiscSection = "general" | "usage";
const SECTIONS: Section<DiscSection>[] = [
  { id: "general", label: "Général", icon: "gear" },
  { id: "usage", label: "Utilisation", icon: "chart" },
];

const ACCESS: Record<Thread["permissionMode"], string> = {
  supervised: "Demande d'abord",
  full: "Accès complet",
};

/** The model a thread runs, with its reflection, as a route. */
const routeOf = (thread: Thread, agents: AgentInfo[]): Route => {
  const effort = effortOf(
    agents.find((a) => a.id === thread.agentId),
    thread.model,
    thread.settings,
  );
  return {
    agentId: thread.agentId,
    ...(thread.model ? { model: thread.model } : {}),
    ...(effort ? { settings: { [effort.setting.id]: effort.value } } : {}),
  };
};

/** « Gemini 4 Hydrogen · Moyen » */
const routeText = (agents: AgentInfo[], route: Route | undefined) => {
  if (!route) return undefined;
  const effort = effortOf(
    agents.find((a) => a.id === route.agentId),
    route.model,
    route.settings,
  );
  return [routeName(agents, route), effort?.name].filter(Boolean).join(" · ");
};

/** What a conversation outside any project starts with while none is set. */
const looseRoute = (agents: AgentInfo[], settings: CoordinatorSettings): Route | undefined =>
  settings.loose ?? looseDefault(agents);

/**
 * A conversation's settings: its name, its model and the one new conversations start with
 * (outside any project), its access, pinned or not, its project, and what it has used. A window
 * on an iPad or a computer; on a phone, a menu dropped from its button, each choice a page of
 * that menu.
 */
export function DiscussionSettings(props: {
  thread: Thread;
  items: Item[] | undefined;
  /** Outside any project (« Discussions »): it can move into one, and sets new ones' model. */
  loose: boolean;
  open: boolean;
  /** On a phone, the button the menu drops from. */
  anchor: React.RefObject<HTMLElement | null>;
  agents: AgentInfo[];
  favorites: Favorites;
  settings: CoordinatorSettings;
  /** Where it can move to. */
  projects: Project[];
  onClose: () => void;
  onDelete: () => void;
}) {
  const { roomy } = useScreen();
  return roomy ? <DiscussionWindow {...props} /> : <DiscussionMenu {...props} />;
}

type Props = Parameters<typeof DiscussionSettings>[0];

function DiscussionWindow(props: Props) {
  const { thread, agents, loose } = props;
  const [section, setSection] = useState<DiscSection>("general");
  const setModel = useThreadModel(thread);
  const running = thread.status === "running" || thread.status === "waiting";
  useEffect(() => {
    if (props.open) setSection("general");
  }, [props.open]);
  return (
    <SettingsWindow
      open={props.open}
      onClose={props.onClose}
      title={loose ? "Paramètres de la discussion" : "Paramètres du fil"}
      sections={SECTIONS}
      section={section}
      onSection={setSection}
      small
    >
      {section === "general" ? (
        <>
          <h2>Général</h2>
          <Row label="Nom">
            <TitleField thread={thread} loose={loose} />
          </Row>
          <h4>Modèles</h4>
          <Row label={loose ? "Cette discussion" : "Ce fil"}>
            <ModelChip
              label={loose ? "Cette discussion" : "Ce fil"}
              agents={agents}
              favorites={props.favorites}
              value={routeOf(thread, agents)}
              disabled={running}
              onChange={setModel}
            />
          </Row>
          {loose && (
            <Row label="Nouvelles discussions">
              <ModelChip
                label="Nouvelles discussions"
                agents={agents}
                favorites={props.favorites}
                value={looseRoute(agents, props.settings)}
                unset="Par défaut"
                onChange={(route) => setLooseModel(route)}
              />
            </Row>
          )}
          <div className="pphr" />
          <Row label="Accès">
            <AccessChip thread={thread} />
          </Row>
          <Row label="Épinglée">
            <Toggle
              on={!!thread.pinned}
              label="Épingler"
              onChange={(pinned) =>
                connection.send({ type: "thread.setPinned", threadId: thread.id, pinned })
              }
            />
          </Row>
          {loose && props.projects.length > 0 && (
            <>
              <div className="pphr" />
              <Row label="Déplacer vers un projet">
                <MoveChip thread={thread} projects={props.projects} />
              </Row>
            </>
          )}
          <h4>Zone de danger</h4>
          <Row label={loose ? "Supprimer la discussion" : "Supprimer le fil"}>
            <button
              type="button"
              className="ppbt red"
              onClick={() => {
                props.onClose();
                props.onDelete();
              }}
            >
              <I n="x" s={14} />
              Supprimer
            </button>
          </Row>
        </>
      ) : (
        <>
          <h2>Utilisation</h2>
          <UsageStats thread={thread} items={props.items} />
        </>
      )}
    </SettingsWindow>
  );
}

const setLooseModel = (route: Route | undefined) =>
  connection.send({
    type: "discussions.setModel",
    ...(route ? { agentId: route.agentId } : {}),
    ...(route?.model ? { model: route.model } : {}),
    ...(route?.settings ? { settings: route.settings } : {}),
  });

/** What the agent has used of its context, as a share; undefined while it does not say. */
const contextShare = (thread: Thread) =>
  thread.usage && thread.usage.size > 0
    ? Math.min(100, Math.round((thread.usage.used / thread.usage.size) * 100))
    : undefined;

/** The messages written in it, the user's and the agent's. */
const messageCount = (items: Item[] | undefined) =>
  items?.filter((i) => i.kind === "user" || i.kind === "agent").length;

function UsageStats(props: { thread: Thread; items: Item[] | undefined }) {
  const share = contextShare(props.thread);
  const messages = messageCount(props.items);
  const cost = props.thread.usage?.cost;
  return (
    <div className="ppstats">
      {messages !== undefined && (
        <div>
          <b>{messages}</b>
          <span>Messages</span>
        </div>
      )}
      {share !== undefined && (
        <div>
          <b>{share} %</b>
          <span>Contexte utilisé</span>
        </div>
      )}
      {cost && (
        <div>
          <b>
            {cost.amount.toLocaleString("fr-FR", {
              style: "currency",
              currency: cost.currency,
              maximumFractionDigits: 2,
            })}
          </b>
          <span>Coût</span>
        </div>
      )}
    </div>
  );
}

/** Its name, saved when it is left or on Enter; Escape puts the saved one back. */
function TitleField(props: { thread: Thread; loose: boolean }) {
  const { thread } = props;
  const [title, setTitle] = useState(thread.title);
  useEffect(() => setTitle(thread.title), [thread.title]);
  const save = () => {
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) return setTitle(thread.title);
    if (clean !== thread.title) sendRename(connection, thread.id, clean, props.loose);
  };
  return (
    <label className="ppnm wide">
      <input
        aria-label={props.loose ? "Nom de la discussion" : "Nom du fil"}
        value={title}
        maxLength={200}
        autoComplete="off"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          // Not while a word is being composed (Japanese, Chinese…): that Enter ends the word.
          const does = renameKey({ key: e.key, isComposing: e.nativeEvent.isComposing });
          if (does === "save") e.currentTarget.blur();
          if (does === "cancel") {
            e.preventDefault();
            e.stopPropagation();
            setTitle(thread.title);
          }
        }}
      />
    </label>
  );
}

/** A chip that drops a short list of choices. */
function ChipMenu(props: {
  label: string;
  shown: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const drop = useExit(open);
  return (
    <>
      <button
        ref={chip}
        type="button"
        className="ppch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        onClick={() => setOpen((on) => !on)}
      >
        {props.shown}
        <span className="pcv">
          <I n="down" s={13} />
        </span>
      </button>
      {drop.mounted && (
        <Dropdown
          anchor={chip}
          label={props.label}
          className={`mcm${drop.leaving ? " out" : ""}`}
          onClose={() => setOpen(false)}
        >
          {props.children(() => setOpen(false))}
        </Dropdown>
      )}
    </>
  );
}

const tick = (on: boolean) =>
  on && (
    <span className="ddk">
      <I n="check" s={15} />
    </span>
  );

function AccessChip({ thread }: { thread: Thread }) {
  const set = (permissionMode: Thread["permissionMode"]) =>
    permissionMode !== thread.permissionMode &&
    connection.send({ type: "thread.setPermissionMode", threadId: thread.id, permissionMode });
  return (
    <ChipMenu label="Accès" shown={ACCESS[thread.permissionMode]}>
      {(close) =>
        (["supervised", "full"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={thread.permissionMode === mode}
            onClick={() => {
              close();
              set(mode);
            }}
          >
            <span className="ddt">{ACCESS[mode]}</span>
            {tick(thread.permissionMode === mode)}
          </button>
        ))
      }
    </ChipMenu>
  );
}

function MoveChip({ thread, projects }: { thread: Thread; projects: Project[] }) {
  return (
    <ChipMenu label="Déplacer vers un projet" shown="Choisir">
      {(close) =>
        projects.map((p) => (
          <button
            key={p.id}
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              connection.send({ type: "thread.move", threadId: thread.id, projectId: p.id });
            }}
          >
            <span className="ddi">
              <ProjectIcon project={p} size={16} />
            </span>
            <span className="ddt">{p.name}</span>
          </button>
        ))
      }
    </ChipMenu>
  );
}

type Page = "main" | "this" | "new" | "access" | "move";

/** On a phone: a menu dropped from the gear, each choice opening a page of its own. */
function DiscussionMenu(props: Props) {
  const { thread, agents, loose } = props;
  const shown = useExit(props.open);
  const [page, setPage] = useState<Page>("main");
  const [back, setBack] = useState(false);
  const [all, setAll] = useState(false);
  const setModel = useThreadModel(thread);
  const running = thread.status === "running" || thread.status === "waiting";
  // Back to its first page once gone, not while it leaves: it goes as it was.
  if (!shown.mounted && (page !== "main" || back || all)) {
    setPage("main");
    setBack(false);
    setAll(false);
  }
  if (!shown.mounted) return null;
  const go = (next: Page) => {
    setBack(next === "main");
    setPage(next);
  };
  const home = () => go("main");
  const share = contextShare(thread);
  const messages = messageCount(props.items);
  const loosePick = looseRoute(agents, props.settings);

  const line = (o: {
    label: string;
    icon: IconName;
    sub?: string;
    value?: string;
    more?: boolean;
    disabled?: boolean;
    danger?: boolean;
    run?: () => void;
    right?: ReactNode;
  }) => (
    <button
      key={o.label}
      type="button"
      role="menuitem"
      className={o.danger ? "dng" : undefined}
      disabled={o.disabled}
      onClick={o.run}
      aria-haspopup={o.more ? "menu" : undefined}
    >
      <span className="ddi">
        <I n={o.icon} s={20} />
      </span>
      <span className="ddt">
        {o.label}
        {o.sub && <small>{o.sub}</small>}
      </span>
      {o.value && <span className="pjv">{o.value}</span>}
      {o.right}
      {o.more && (
        <span className="ddi">
          <I n="right" s={14} />
        </span>
      )}
    </button>
  );
  const head = (label: string) => (
    <>
      <div className="pjhd">
        <button type="button" role="menuitem" className="pjb" onClick={home}>
          <span className="ddi">
            <I n="back" s={18} />
          </span>
          <span className="ddt">{label}</span>
        </button>
        {(page === "this" || page === "new") && (
          <button
            type="button"
            className="ddmore"
            aria-pressed={all}
            onClick={() => setAll((on) => !on)}
          >
            {all ? "Favoris" : "Tous"}
          </button>
        )}
      </div>
      <hr />
    </>
  );

  let body: ReactNode;
  if (page === "this") {
    body = (
      <>
        {head(loose ? "Cette discussion" : "Ce fil")}
        <ModelLines
          agents={agents}
          favorites={props.favorites}
          value={routeOf(thread, agents)}
          all={all}
          onPick={(route) => {
            home();
            if (route) setModel(route);
          }}
        />
      </>
    );
  } else if (page === "new") {
    body = (
      <>
        {head("Nouvelles discussions")}
        <ModelLines
          agents={agents}
          favorites={props.favorites}
          value={loosePick}
          all={all}
          onPick={(route) => {
            home();
            if (route !== loosePick) setLooseModel(route);
          }}
        />
      </>
    );
  } else if (page === "access") {
    body = (
      <>
        {head("Accès")}
        {(["supervised", "full"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={thread.permissionMode === mode}
            onClick={() => {
              home();
              if (mode !== thread.permissionMode)
                connection.send({
                  type: "thread.setPermissionMode",
                  threadId: thread.id,
                  permissionMode: mode,
                });
            }}
          >
            <span className="ddt">{ACCESS[mode]}</span>
            {tick(thread.permissionMode === mode)}
          </button>
        ))}
      </>
    );
  } else if (page === "move") {
    body = (
      <>
        {head("Déplacer vers")}
        {props.projects.map((p) => (
          <button
            key={p.id}
            type="button"
            role="menuitem"
            onClick={() => {
              props.onClose();
              connection.send({ type: "thread.move", threadId: thread.id, projectId: p.id });
            }}
          >
            <span className="ddi">
              <ProjectIcon project={p} size={18} />
            </span>
            <span className="ddt">{p.name}</span>
          </button>
        ))}
      </>
    );
  } else {
    body = (
      <>
        {line({
          label: loose ? "Cette discussion" : "Ce fil",
          icon: "bubble",
          sub: routeText(agents, routeOf(thread, agents)),
          more: true,
          disabled: running,
          run: () => go("this"),
        })}
        {loose &&
          line({
            label: "Nouvelles discussions",
            icon: "plus",
            sub: routeText(agents, loosePick) ?? "Par défaut",
            more: true,
            run: () => go("new"),
          })}
        {line({
          label: "Accès",
          icon: "hand",
          sub: ACCESS[thread.permissionMode],
          more: true,
          run: () => go("access"),
        })}
        <hr />
        {line({
          label: "Épinglée",
          icon: "star",
          right: (
            <span className="tog pjtg" role="switch" aria-checked={!!thread.pinned} aria-hidden />
          ),
          run: () =>
            connection.send({
              type: "thread.setPinned",
              threadId: thread.id,
              pinned: !thread.pinned,
            }),
        })}
        {loose &&
          props.projects.length > 0 &&
          line({
            label: "Déplacer vers un projet",
            icon: "folder",
            more: true,
            run: () => go("move"),
          })}
        {(share !== undefined || messages !== undefined) && <hr />}
        {share !== undefined && (
          <div className="pjro">
            <span className="ddi">
              <I n="gauge" s={20} />
            </span>
            <span className="ddt">Contexte utilisé</span>
            <span className="pjv">{share} %</span>
          </div>
        )}
        {messages !== undefined && (
          <div className="pjro">
            <span className="ddi">
              <I n="bubble" s={20} />
            </span>
            <span className="ddt">Messages</span>
            <span className="pjv">{messages}</span>
          </div>
        )}
        <hr />
        {line({
          label: loose ? "Supprimer la discussion" : "Supprimer le fil",
          icon: "x",
          danger: true,
          run: () => {
            props.onClose();
            props.onDelete();
          },
        })}
      </>
    );
  }

  return (
    <Dropdown
      anchor={props.anchor}
      label={loose ? "Paramètres de la discussion" : "Paramètres du fil"}
      className={`pjm big dsm${shown.leaving ? " out" : ""}`}
      onClose={props.onClose}
    >
      <div key={page} className={`pjp${page !== "main" ? " fwd" : back ? " bwd" : ""}`}>
        {body}
      </div>
    </Dropdown>
  );
}
