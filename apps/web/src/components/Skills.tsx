import {
  type FoundSkill,
  type InstalledSkill,
  type Project,
  SKILL_AGENTS,
  type SkillAgent,
  type SkillCommandPlan,
} from "@moonagentic/protocol";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { HERMES_AVATAR } from "../hermes.ts";
import { I } from "../v2/I.tsx";
import { stillToInstall } from "../skill-pick.ts";
import { DropMenu, type DropItem, Pop } from "../v2/Pop.tsx";

export const AGENT_NAME: Record<SkillAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  hermes: "Hermes Agent",
};
/** Ticked for a new skill: every agent reading a project's folders. */
const FIRST_AGENTS: SkillAgent[] = ["claude", "codex", "antigravity"];
/** « Every project » in the choice of where a skill goes. */
const ALL = "*";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a skill comes from, on its line and in its window. */
export function sourceLabel(skill: InstalledSkill): string {
  const s = skill.source;
  if (!s) return "Trouvée sur le PC";
  if (s.kind === "github") return s.repo;
  if (s.kind === "command") return "Commande";
  return "Créée dans l'app";
}

/** The agents a skill is given to, by name; « 4 agents » when it is all of them. */
export function agentsLabel(agents: SkillAgent[]): string {
  if (agents.length === SKILL_AGENTS.length) return `${agents.length} agents`;
  return SKILL_AGENTS.filter((a) => agents.includes(a))
    .map((a) => AGENT_NAME[a])
    .join(", ");
}

/** The projects a skill can go to: open, and not the out-of-project chats. */
const placesOf = (projects: Project[]) =>
  projects.filter((p) => !p.locked && !isDiscussionsProject(p));

function whereItems(projects: Project[]): DropItem[] {
  const open = placesOf(projects);
  return [
    { value: ALL, label: "Tous les projets", icon: "grid" },
    ...(open.length
      ? ([{ sep: true }, { heading: "Projets" }] as DropItem[]).concat(
          open.map((p) => ({
            value: p.id,
            label: p.name,
            icon: "folder" as const,
            ...(p.color ? { color: `var(--pc-${p.color})` } : {}),
          })),
        )
      : []),
  ];
}
const whereLabel = (where: string, projects: Project[]) =>
  where === ALL ? "Tous les projets" : (projects.find((p) => p.id === where)?.name ?? "");
const projectOf = (where: string) => (where === ALL ? {} : { projectId: where });

/** The installed skills, read once the connection is open and after each change. */
let cached: InstalledSkill[] | null = null;
const listeners = new Set<() => void>();
const setCached = (skills: InstalledSkill[]) => {
  cached = skills;
  for (const l of listeners) l();
};
export async function changeSkills(
  ask: () => Promise<{ skills: InstalledSkill[] }>,
): Promise<InstalledSkill[]> {
  const { skills } = await ask();
  setCached(skills);
  return skills;
}
const refresh = () =>
  changeSkills(() => connection.ask({ type: "skills.list", requestId: newId() }));

export function useInstalledSkills(): { skills: InstalledSkill[] | null; error: string } {
  const skills = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cached,
  );
  const status = useSyncExternalStore(connection.subscribe, () => connection.getState().status);
  const [error, setError] = useState("");
  useEffect(() => {
    if (status !== "open") return;
    refresh().then(
      () => setError(""),
      (e: unknown) => setError(errorText(e)),
    );
  }, [status]);
  return { skills, error };
}

function AgentName(props: { agent: SkillAgent }) {
  if (props.agent !== "hermes") return <>{AGENT_NAME[props.agent]}</>;
  return (
    <span className="skag">
      <img className="hav" src={HERMES_AVATAR} alt="" width={22} height={22} />
      {AGENT_NAME.hermes}
    </span>
  );
}

function AgentToggles(props: {
  agents: SkillAgent[];
  /** Hermes reads only the home folder's skills. */
  project: boolean;
  disabled?: boolean;
  onChange: (agents: SkillAgent[]) => void;
}) {
  const shown = SKILL_AGENTS.filter((a) => !props.project || a !== "hermes");
  return (
    <>
      <div className="gl2">Agents</div>
      <div className="ins">
        {shown.map((a) => {
          const on = props.agents.includes(a);
          return (
            <div key={a} className="it ro">
              <span className="tx">
                <AgentName agent={a} />
              </span>
              <button
                className="tog"
                role="switch"
                aria-checked={on}
                aria-label={AGENT_NAME[a]}
                disabled={props.disabled || (on && props.agents.length === 1)}
                onClick={() =>
                  props.onChange(on ? props.agents.filter((x) => x !== a) : [...props.agents, a])
                }
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The « Projets » line of a window: where the skill is or goes, chosen in a menu. */
function WhereRow(props: {
  where: string;
  projects: Project[];
  disabled?: boolean;
  onPick: (where: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        className="it"
        aria-haspopup="menu"
        disabled={props.disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <span className="tx">Projets</span>
        <span className="rt">
          {whereLabel(props.where, props.projects)}
          <I n="down" s={13} />
        </span>
      </button>
      <DropMenu
        open={!!anchor}
        anchor={anchor}
        label="Projets"
        items={whereItems(props.projects)}
        value={props.where}
        onPick={props.onPick}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}

function Problem(props: { text: string }) {
  if (!props.text) return null;
  return (
    <div className="ins">
      <div className="it ro">
        <span className="tx">
          <small className="erx">{props.text}</small>
        </span>
      </div>
    </div>
  );
}

const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

/** An installed skill: where it is, its agents, and the way to update or remove it. */
function SkillDetail(props: {
  skill: InstalledSkill;
  projects: Project[];
  onEdit?: () => void;
  onClose: () => void;
}) {
  const { skill } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const scope = skill.projectId ? { projectId: skill.projectId } : {};
  const run = async (ask: () => Promise<{ skills: InstalledSkill[] }>, close = false) => {
    setBusy(true);
    setError("");
    try {
      await changeSkills(ask);
      if (close) props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (asking) {
    return (
      <>
        <Problem text={error} />
        <div className="cfa">
          <button
            className="b2 ink dng press"
            disabled={busy}
            autoFocus
            onClick={() =>
              run(
                () =>
                  connection.ask({
                    type: "skills.remove",
                    requestId: newId(),
                    name: skill.name,
                    ...scope,
                  }),
                true,
              )
            }
          >
            Retirer {skill.name}
          </button>
          <button className="b2 soft press" onClick={() => setAsking(false)}>
            Annuler
          </button>
        </div>
      </>
    );
  }
  const source = skill.source;
  return (
    <>
      <div className="ins">
        <div className="it ro">
          <span className="tx">Source</span>
          <span className="rt mcv">
            {source?.kind === "github" || source?.kind === "command" ? (
              <span className="mono">
                {source.kind === "github"
                  ? `${source.repo}${source.path ? `/${source.path}` : ""}`
                  : source.command}
              </span>
            ) : (
              sourceLabel(skill)
            )}
          </span>
        </div>
        <WhereRow
          where={skill.projectId ?? ALL}
          projects={props.projects}
          disabled={busy}
          onPick={(to) =>
            run(() =>
              connection.ask({
                type: "skills.move",
                requestId: newId(),
                name: skill.name,
                ...scope,
                ...(to === ALL ? {} : { to }),
              }),
            )
          }
        />
        <div className="it ro">
          <span className="tx">Fichiers</span>
          <span className="rt">{skill.files}</span>
        </div>
        {skill.installedAt && (
          <div className="it ro">
            <span className="tx">Installée</span>
            <span className="rt">{day.format(skill.installedAt)}</span>
          </div>
        )}
      </div>
      <AgentToggles
        agents={skill.agents}
        project={!!skill.projectId}
        disabled={busy}
        onChange={(agents) =>
          run(() =>
            connection.ask({
              type: "skills.setAgents",
              requestId: newId(),
              name: skill.name,
              ...scope,
              agents,
            }),
          )
        }
      />
      <Problem text={error} />
      <div className="ins">
        {props.onEdit && (
          <button className="it acc" disabled={busy} onClick={props.onEdit}>
            <span className="tx">Modifier</span>
          </button>
        )}
        {source?.kind === "github" && (
          <button
            className="it acc"
            disabled={busy}
            onClick={() =>
              run(() =>
                connection.ask({
                  type: "skills.update",
                  requestId: newId(),
                  name: skill.name,
                  ...scope,
                }),
              )
            }
          >
            <span className="tx">{busy ? "Mise à jour…" : "Mettre à jour"}</span>
          </button>
        )}
        <button className="it dng" disabled={busy} onClick={() => setAsking(true)}>
          <span className="tx">Retirer cette skill</span>
        </button>
      </div>
    </>
  );
}

type Found = { repo: string; ref?: string; skills: FoundSkill[] };

/** Skills read from a GitHub repository, picked, then installed for the agents chosen. */
function FromGithub(props: {
  where: string;
  setWhere: (where: string) => void;
  projects: Project[];
  installed: InstalledSkill[];
  onClose: () => void;
}) {
  const [source, setSource] = useState("");
  const [found, setFound] = useState<Found | "load" | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [agents, setAgents] = useState<SkillAgent[]>(FIRST_AGENTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = props.where !== ALL;
  const given = project ? agents.filter((a) => a !== "hermes") : agents;
  const here = new Set(
    props.installed
      .filter((s) => (s.projectId ?? ALL) === props.where)
      .map((s) => s.name.toLowerCase()),
  );
  const list = found && found !== "load" ? found.skills : null;
  // Another project chosen after picking: what it already holds is not installed again.
  const chosen = list ? stillToInstall(picked, list, here) : [];

  const find = async () => {
    if (!source.trim() || found === "load") return;
    setFound("load");
    setPicked([]);
    setError("");
    try {
      const reply = await connection.ask({
        type: "skills.find",
        requestId: newId(),
        source: source.trim(),
      });
      setFound({
        repo: reply.repo,
        ...(reply.ref ? { ref: reply.ref } : {}),
        skills: reply.skills,
      });
      const fresh = reply.skills.filter((s) => !here.has(s.name.toLowerCase()));
      if (fresh.length === 1) setPicked([fresh[0]!.path]);
    } catch (e) {
      setFound(null);
      setError(errorText(e));
    }
  };
  const install = async () => {
    if (!found || found === "load" || !chosen.length || !given.length) return;
    setBusy(true);
    setError("");
    try {
      await changeSkills(() =>
        connection.ask({
          type: "skills.install",
          requestId: newId(),
          repo: found.repo,
          ...(found.ref ? { ref: found.ref } : {}),
          paths: chosen,
          ...projectOf(props.where),
          agents: given,
        }),
      );
      props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ins">
        <label className="it ro npf">
          <input
            className="mono"
            value={source}
            placeholder="anthropics/skills · lien skills.sh"
            aria-label="Source"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setSource(e.target.value);
              if (found !== "load") setFound(null);
              setPicked([]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !list) void find();
            }}
          />
        </label>
        <div className="sep" />
        <WhereRow where={props.where} projects={props.projects} onPick={props.setWhere} />
      </div>
      <Problem text={error} />
      {found === "load" ? (
        <div className="pwait">
          <span className="ppill">
            <span className="mst">
              <span className="t2-spin" />
            </span>
            Lecture du dépôt
          </span>
        </div>
      ) : list ? (
        <>
          <div className="gl2">
            Dans {(found as Found).repo}
            <span className="gcn">{list.length}</span>
          </div>
          <div className="ins">
            {list.map((f) =>
              here.has(f.name.toLowerCase()) ? (
                <div key={f.path} className="it ro">
                  <span className="tx">
                    {f.name}
                    {f.description && <small>{f.description}</small>}
                  </span>
                  <span className="okp">Installée</span>
                </div>
              ) : (
                <button
                  key={f.path}
                  className="it fva"
                  aria-pressed={picked.includes(f.path)}
                  onClick={() =>
                    setPicked((p) =>
                      p.includes(f.path) ? p.filter((x) => x !== f.path) : [...p, f.path],
                    )
                  }
                >
                  <span className="tx">
                    {f.name}
                    {f.description && <small>{f.description}</small>}
                  </span>
                  <span className="fvc">
                    <I n="check" s={14} />
                  </span>
                </button>
              ),
            )}
          </div>
          <AgentToggles agents={given} project={project} onChange={setAgents} />
          <div className="mga">
            <button className="b2 soft press" onClick={props.onClose}>
              Annuler
            </button>
            <button
              className="b2 ink press"
              disabled={!chosen.length || busy}
              onClick={() => void install()}
            >
              {busy
                ? "Installation…"
                : chosen.length
                  ? `Installer ${chosen.length} skill${chosen.length > 1 ? "s" : ""}`
                  : "Installer"}
            </button>
          </div>
        </>
      ) : (
        <div className="mga">
          <button className="b2 soft press" onClick={props.onClose}>
            Annuler
          </button>
          <button className="b2 ink press" disabled={!source.trim()} onClick={() => void find()}>
            <I n="search" s={16} />
            Chercher les skills
          </button>
        </div>
      )}
    </>
  );
}

/** A command to type, shown as it will run before anything runs. */
function ByCommand(props: {
  where: string;
  setWhere: (where: string) => void;
  projects: Project[];
  command: string;
  setCommand: (command: string) => void;
  onPlan: (plan: SkillCommandPlan) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preview = async () => {
    const command = props.command.trim();
    if (!command || busy) return;
    setBusy(true);
    setError("");
    try {
      const reply = await connection.ask({
        type: "skills.preview",
        requestId: newId(),
        command,
        ...projectOf(props.where),
      });
      props.onPlan(reply.plan);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="ins">
        <label className="it ro npf">
          <input
            className="mono"
            value={props.command}
            placeholder="npx impeccable install"
            aria-label="Commande"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => props.setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void preview();
            }}
          />
        </label>
        <div className="sep" />
        <WhereRow where={props.where} projects={props.projects} onPick={props.setWhere} />
      </div>
      <Problem text={error} />
      <div className="mga">
        <button className="b2 soft press" onClick={props.onClose}>
          Annuler
        </button>
        <button
          className="b2 ink press"
          disabled={!props.command.trim() || busy}
          onClick={() => void preview()}
        >
          Voir ce qui va tourner
        </button>
      </div>
    </>
  );
}

/** The output of a command, kept scrolled to its last line. */
function RunLog(props: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.text]);
  if (!props.text) return null;
  return (
    <div ref={box} className="sklog" aria-live="polite">
      {props.text}
    </div>
  );
}

/** A command shown, then running with its output and a way to answer it, then what it did. */
function Run(props: {
  plan: SkillCommandPlan;
  where: string;
  runId: string | null;
  onStart: (runId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const run = useSyncExternalStore(connection.subscribe, () =>
    props.runId ? connection.getState().skillRuns[props.runId] : undefined,
  );
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  // Pressed twice, it starts once.
  const [starting, setStarting] = useState(false);
  const startOnce = useRef(false);
  const { skills } = useInstalledSkills();
  const ended = run?.ended;
  useEffect(() => {
    if (ended) void refresh().catch(() => {});
  }, [ended]);

  if (!props.runId) {
    const start = async () => {
      if (startOnce.current) return;
      startOnce.current = true;
      setStarting(true);
      const runId = newId();
      setError("");
      try {
        await connection.ask({
          type: "skills.run",
          requestId: newId(),
          runId,
          command: props.plan.command,
          ...projectOf(props.where),
        });
        props.onStart(runId);
      } catch (e) {
        startOnce.current = false;
        setError(errorText(e));
      } finally {
        setStarting(false);
      }
    };
    return (
      <>
        <div className="gl2">Commande</div>
        <div className="skc">
          <span className="mono">{props.plan.command}</span>
        </div>
        <div className="gl2">Dossier</div>
        <div className="skc">
          <span className="mono">{props.plan.dir}</span>
        </div>
        <div className="skp">
          <span className="wnp">
            <I n="warn" s={14} />
            Script tiers
          </span>
          {props.plan.npm && (
            <span className="ppill mono">
              npm · {props.plan.npm.name}
              {props.plan.npm.version ? ` ${props.plan.npm.version}` : ""}
            </span>
          )}
        </div>
        <Problem text={error} />
        <div className="cfa">
          <button className="b2 ink press" disabled={starting} onClick={() => void start()}>
            Lancer
          </button>
          <button className="b2 soft press" onClick={props.onBack}>
            Annuler
          </button>
        </div>
      </>
    );
  }

  const output = run?.output ?? "";
  if (!ended) {
    // A line left open is the command waiting for an answer.
    const waiting = output.length > 0 && !output.endsWith("\n");
    const send = () => {
      connection.send({ type: "skills.runInput", runId: props.runId!, text: answer });
      setAnswer("");
    };
    return (
      <>
        <div className="skst">
          <span className="ppill">
            <span className="mst">
              <span className="t2-spin" />
            </span>
            <span className="mono">{props.plan.command}</span>
          </span>
        </div>
        <RunLog text={output} />
        {waiting && (
          <div className="skin">
            <input
              value={answer}
              aria-label="Réponse au script"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <button className="b2 ink press" onClick={send}>
              Envoyer
            </button>
          </div>
        )}
        <div className="mga">
          <button
            className="b2 soft press"
            onClick={() => connection.send({ type: "skills.runStop", runId: props.runId! })}
          >
            Arrêter
          </button>
        </div>
      </>
    );
  }

  const scope = props.where === ALL ? undefined : props.where;
  const pathsOf = (name: string) =>
    skills?.find((s) => s.name === name && s.projectId === scope)?.paths ?? [];
  const failed = ended.error || (ended.code !== 0 && !ended.added.length);
  return (
    <>
      {ended.added.length > 0 && (
        <>
          <div className="gl2">
            Skills ajoutées<span className="gcn">{ended.added.length}</span>
          </div>
          <div className="ins">
            {ended.added.map((name) => (
              <div key={name} className="it ro">
                <span className="tx">
                  {name}
                  {pathsOf(name).length > 0 && (
                    <small>{pathsOf(name).map(folderOf).join(" · ")}</small>
                  )}
                </span>
                <span className="okp">Nouvelle</span>
              </div>
            ))}
          </div>
        </>
      )}
      {ended.changed.length > 0 && (
        <>
          <div className="gl2">
            Autres changements<span className="gcn">{ended.changed.length}</span>
          </div>
          <div className="ins">
            {ended.changed.map((file) => (
              <div key={file} className="it ro">
                <span className="tx">
                  <span className="mono">{file}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {failed && (
        <Problem
          text={ended.error ?? (ended.code === null ? "Arrêtée." : `Code de sortie ${ended.code}`)}
        />
      )}
      <RunLog text={output} />
      <div className="mga">
        <button className="b2 ink press" onClick={props.onClose}>
          Terminé
        </button>
      </div>
    </>
  );
}

/** `.claude/skills/pdf` → `.claude/skills`: the agent's folder a copy is in. */
const folderOf = (p: string) => p.replace(/[\\/][^\\/]+$/, "");

type Opened =
  | { kind: "menu" }
  | { kind: "github" }
  | { kind: "command" }
  | { kind: "run"; plan: SkillCommandPlan; runId: string | null };

/**
 * « Installer une skill »: its menu (from GitHub or skills.sh, or by a command), then the
 * window of each way, all hung from the same button.
 */
export function InstallSkill(props: {
  projects: Project[];
  installed: InstalledSkill[];
  /** Where it goes at first: every project, or this project. */
  projectId?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [where, setWhere] = useState(props.projectId ?? ALL);
  const [command, setCommand] = useState("");
  const close = () => {
    setOpened(null);
    setCommand("");
  };
  const begin = (kind: "github" | "command") => {
    setWhere(props.projectId ?? ALL);
    setOpened({ kind });
  };
  const running = opened?.kind === "run" && !!opened.runId;
  const ended = useSyncExternalStore(connection.subscribe, () =>
    opened?.kind === "run" && opened.runId
      ? !!connection.getState().skillRuns[opened.runId]?.ended
      : false,
  );
  let title = "";
  let body: ReactNode = null;
  if (opened?.kind === "github") {
    title = "Depuis GitHub";
    body = (
      <FromGithub
        where={where}
        setWhere={setWhere}
        projects={props.projects}
        installed={props.installed}
        onClose={close}
      />
    );
  } else if (opened?.kind === "command") {
    title = "Par commande";
    body = (
      <ByCommand
        where={where}
        setWhere={setWhere}
        projects={props.projects}
        command={command}
        setCommand={setCommand}
        onPlan={(plan) => setOpened({ kind: "run", plan, runId: null })}
        onClose={close}
      />
    );
  } else if (opened?.kind === "run") {
    title = !opened.runId ? "Lancer la commande ?" : ended ? "Terminée" : "Installation";
    body = (
      <Run
        plan={opened.plan}
        where={where}
        runId={opened.runId}
        onStart={(runId) => setOpened({ ...opened, runId })}
        onBack={() => setOpened({ kind: "command" })}
        onClose={close}
      />
    );
  }
  return (
    <>
      <button
        className="it acc"
        aria-haspopup="menu"
        onClick={(e) => {
          // A command running keeps its window: only « Arrêter » ends it.
          if (running && !ended) return;
          setAnchor(e.currentTarget);
          setOpened(opened ? null : { kind: "menu" });
        }}
      >
        <I n="plus" s={18} />
        <span className="tx">Installer une skill</span>
      </button>
      <DropMenu
        open={opened?.kind === "menu"}
        anchor={anchor}
        label="Installer une skill"
        items={[
          { value: "github", label: "Depuis GitHub ou skills.sh", icon: "gh" },
          { value: "command", label: "Par commande", icon: "code" },
        ]}
        onPick={(v) => begin(v === "command" ? "command" : "github")}
        onClose={() => setOpened((o) => (o?.kind === "menu" ? null : o))}
      />
      <Pop
        open={!!opened && opened.kind !== "menu"}
        anchor={anchor}
        title={title}
        wide={opened?.kind === "run"}
        locked={running && !ended}
        onClose={close}
      >
        {body}
      </Pop>
    </>
  );
}

/** One group of installed skills, each line opening its window. */
function SkillGroup(props: {
  title: string;
  skills: InstalledSkill[];
  onOpen: (skill: InstalledSkill, anchor: HTMLElement) => void;
}) {
  if (!props.skills.length) return null;
  return (
    <>
      <div className="gl2">
        {props.title}
        <span className="gcn">{props.skills.length}</span>
      </div>
      <div className="ins">
        {props.skills.map((s) => (
          <button
            key={`${s.projectId ?? ""}/${s.name}`}
            className="it"
            aria-haspopup="dialog"
            onClick={(e) => props.onOpen(s, e.currentTarget)}
          >
            <span className="tx">
              {s.name}
              <small>
                {sourceLabel(s)} · {agentsLabel(s.agents)}
              </small>
            </span>
            <span className="rt">
              <I n="right" s={15} />
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

const keyOf = (s: InstalledSkill) => `${s.projectId ?? ""}/${s.name}`;

/**
 * The installed skills in groups, every project's first or the project's own first, each
 * opening its window from its line.
 */
export function SkillLists(props: {
  skills: InstalledSkill[];
  projects: Project[];
  /** In a project's settings: its own skills, then every project's. */
  projectId?: string;
  /** A skill of the project's that can be written from the app. */
  editable?: (skill: InstalledSkill) => (() => void) | undefined;
}) {
  const [open, setOpen] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const shown = props.skills.find((s) => keyOf(s) === open?.key);
  // Kept while its window leaves, once moved or removed.
  const last = useRef<InstalledSkill | undefined>(undefined);
  if (shown) last.current = shown;
  const all = props.skills.filter((s) => !s.projectId);
  const groups = props.projectId
    ? [
        {
          title: props.projects.find((p) => p.id === props.projectId)?.name ?? "",
          skills: props.skills.filter((s) => s.projectId === props.projectId),
        },
        { title: "Tous les projets", skills: all },
      ]
    : [
        { title: "Tous les projets", skills: all },
        ...placesOf(props.projects).map((p) => ({
          title: p.name,
          skills: props.skills.filter((s) => s.projectId === p.id),
        })),
      ];
  const detail = shown ?? last.current;
  const close = () => setOpen(null);
  return (
    <>
      {groups.map((g, i) => (
        <SkillGroup
          key={i}
          title={g.title}
          skills={g.skills}
          onOpen={(s, anchor) => setOpen({ key: keyOf(s), anchor })}
        />
      ))}
      <Pop
        open={!!open && !!shown}
        anchor={open?.anchor ?? null}
        title={detail?.name ?? ""}
        onClose={close}
      >
        {detail && (
          <SkillDetail
            key={keyOf(detail)}
            skill={detail}
            projects={props.projects}
            onEdit={
              props.editable?.(detail) &&
              (() => {
                close();
                props.editable?.(detail)?.();
              })
            }
            onClose={close}
          />
        )}
      </Pop>
    </>
  );
}

/** Réglages › Skills: every installed skill, for every project and for each project. */
export function SkillsSettings(props: { projects: Project[] }) {
  const { skills, error } = useInstalledSkills();
  return (
    <>
      <Problem text={error} />
      {skills && <SkillLists skills={skills} projects={props.projects} />}
      <div className="ins">
        <InstallSkill projects={props.projects} installed={skills ?? []} />
      </div>
    </>
  );
}
