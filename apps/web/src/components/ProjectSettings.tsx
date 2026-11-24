import {
  PROJECT_COLORS,
  type Project,
  type ProjectColor,
  type ProjectSetup,
  type ProjectSkill,
} from "@moonagentic/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import {
  claudeAction,
  commandProblem,
  fits,
  ICON_PICKS,
  iconProblem,
  oneLine,
  skillProblem,
} from "../project-setup.ts";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { ProjectIcon } from "./ProjectIcon.tsx";

type Tab = "look" | "rules" | "commands" | "skills";
const TABS: [Tab, string][] = [
  ["look", "Apparence"],
  ["rules", "Consignes"],
  ["commands", "Commandes"],
  ["skills", "Skills"],
];

const COLOR_NAME: Record<ProjectColor, string> = {
  moon: "Lune",
  sky: "Ciel",
  mint: "Menthe",
  sun: "Soleil",
  coral: "Corail",
  rose: "Rose",
  violet: "Violet",
  slate: "Ardoise",
};

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A project's settings: its icon and tint, and what it gives its agents, read from and
 * written to its own folder: `AGENTS.md`, its `/` commands and its skills.
 */
export function ProjectSettings(props: { project: Project; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("look");
  const [setup, setSetup] = useState<ProjectSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const projectId = props.project.id;

  useEffect(() => {
    let live = true;
    connection
      .ask({ type: "project.setup", requestId: newId(), projectId })
      .then((reply) => live && setSetup(reply.setup))
      .catch((error: unknown) => live && setLoadError(why(error)));
    return () => {
      live = false;
    };
  }, [projectId]);

  // Escape closes it, unless a confirmation is open above it.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !confirm && props.onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [confirm, props.onClose]);

  /** Sends a change and shows the folder as the server reads it after. */
  const change: Change = async (message) => {
    const reply = await connection.ask(message);
    setSetup(reply.setup);
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog ps" role="dialog" aria-modal aria-labelledby="ps-title">
        <div className="ps-head">
          <ProjectIcon project={props.project} size={20} />
          <h2 id="ps-title">Réglages de {props.project.name}</h2>
        </div>
        <div className="ps-tabs" role="tablist" aria-label="Réglages du projet">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "look" ? (
          <LookTab project={props.project} />
        ) : loadError ? (
          <p className="error">{loadError}</p>
        ) : !setup ? (
          <p className="ps-quiet">Lecture du dossier du projet…</p>
        ) : tab === "rules" ? (
          <RulesTab setup={setup} projectId={projectId} change={change} />
        ) : tab === "commands" ? (
          <CommandsTab setup={setup} projectId={projectId} change={change} onConfirm={setConfirm} />
        ) : (
          <SkillsTab setup={setup} projectId={projectId} change={change} onConfirm={setConfirm} />
        )}
        {tab !== "look" && setup?.uncommitted && (
          <p className="ps-note">
            Pas encore commité : <span className="mono">{setup.uncommitted.join(", ")}</span>. Un
            fil sur sa propre branche part du dernier commit et ne le voit pas encore.
          </p>
        )}
        <div className="row">
          <button className="btn" onClick={props.onClose}>
            Fermer
          </button>
        </div>
      </div>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

type SetupRequest = Extract<
  Parameters<typeof connection.ask>[0],
  {
    type:
      | "project.saveRules"
      | "project.linkClaude"
      | "project.saveCommand"
      | "project.removeCommand"
      | "project.saveSkill"
      | "project.removeSkill";
  }
>;
type Change = (message: SetupRequest) => Promise<void>;

function LookTab({ project }: { project: Project }) {
  const [icon, setIcon] = useState(project.icon ?? "");
  const field = useRef<HTMLInputElement>(null);
  // Changed from another window: shown here too, unless the user is typing in the field,
  // where the echo of what they typed a moment ago would undo what they type now.
  useEffect(() => {
    if (document.activeElement !== field.current) setIcon(project.icon ?? "");
  }, [project.icon]);
  const problem = iconProblem(icon);
  const send = (next: { icon?: string | undefined; color?: ProjectColor | undefined }) =>
    connection.send({
      type: "project.setLook",
      projectId: project.id,
      icon: (next.icon ?? "").trim() || null,
      color: next.color ?? null,
    });
  const keepIcon = (value: string) => {
    setIcon(value);
    if (!iconProblem(value)) send({ icon: value, color: project.color });
  };

  return (
    <div className="ps-body">
      <div className="ps-preview">
        <ProjectIcon project={{ ...project, icon: icon.trim() || undefined }} size={28} />
        <span>{project.name}</span>
      </div>
      <div className="ps-field">
        <label htmlFor="ps-icon">Icône</label>
        <div className="ps-icons">
          <input
            id="ps-icon"
            ref={field}
            value={icon}
            placeholder="🚀 ou AB"
            maxLength={16}
            onChange={(e) => keepIcon(e.target.value)}
          />
          {ICON_PICKS.map((pick) => (
            <button
              key={pick}
              type="button"
              className="ps-pick"
              aria-pressed={icon.trim() === pick}
              aria-label={`Icône ${pick}`}
              onClick={() => keepIcon(pick)}
            >
              {pick}
            </button>
          ))}
        </div>
        {problem && <small className="ps-err">{problem}</small>}
        {project.icon && (
          <button type="button" className="ps-link" onClick={() => keepIcon("")}>
            Remettre le dossier
          </button>
        )}
      </div>
      <div className="ps-field">
        <span id="ps-color">Couleur</span>
        <div className="ps-colors" role="radiogroup" aria-labelledby="ps-color">
          {PROJECT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={project.color === color}
              aria-label={COLOR_NAME[color]}
              title={COLOR_NAME[color]}
              className={`ps-color pc-${color}`}
              onClick={() =>
                send({
                  // An icon being typed that cannot be kept stays as it was.
                  icon: iconProblem(icon) ? project.icon : icon,
                  color: project.color === color ? undefined : color,
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RulesTab(props: { setup: ProjectSetup; projectId: string; change: Change }) {
  const saved = props.setup.rules.text;
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const run = async (message: Parameters<Change>[0]) => {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await props.change(message);
      // « Enregistré » is for AGENTS.md: linking CLAUDE.md shows « Relié » on its own line.
      if (message.type === "project.saveRules") setDone(true);
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };
  if (props.setup.rules.tooBig) {
    return <p className="ps-quiet">AGENTS.md est trop gros pour être modifié ici.</p>;
  }
  const action = claudeAction(props.setup.claude);
  return (
    <div className="ps-body">
      <p className="ps-quiet">
        AGENTS.md, à la racine du projet : les consignes que tes agents lisent à chaque fil.
      </p>
      <textarea
        className="ps-text mono"
        aria-label="Contenu de AGENTS.md"
        value={text}
        placeholder={"## Projet\n- Lance les tests avant de proposer un changement."}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDone(false);
        }}
      />
      {!fits(text) && <small className="ps-err">Texte trop long.</small>}
      <div className="ps-acts">
        {done && text === saved && <span className="ps-ok">Enregistré</span>}
        <button
          className="btn pri sm"
          disabled={busy || text === saved || !fits(text)}
          onClick={() =>
            void run({
              type: "project.saveRules",
              requestId: newId(),
              projectId: props.projectId,
              text,
            })
          }
        >
          Enregistrer
        </button>
      </div>
      <div className="ps-line">
        <div>
          <b>Claude Code</b>
          <p>
            {props.setup.claude === "imports"
              ? "Il lit aussi AGENTS.md, par CLAUDE.md."
              : props.setup.claude === "missing"
                ? "Il lit CLAUDE.md, pas AGENTS.md."
                : "Il lit ton CLAUDE.md, qui n'importe pas AGENTS.md."}
          </p>
        </div>
        {props.setup.claude === "imports" ? (
          <span className="ps-tag">Relié</span>
        ) : (
          // Linking needs AGENTS.md written first.
          props.setup.rules.exists && (
            <button
              className="btn sm"
              title={action}
              disabled={busy}
              onClick={() =>
                void run({
                  type: "project.linkClaude",
                  requestId: newId(),
                  projectId: props.projectId,
                })
              }
            >
              Relier
            </button>
          )
        )}
      </div>
      {action && props.setup.rules.exists && <small className="ps-quiet">{action}</small>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface Draft {
  name: string;
  description: string;
  text: string;
}

/** The form of a command or a skill being written. */
function Editor(props: {
  label: string;
  draft: Draft;
  /** Why the name typed cannot be kept, or nothing. */
  problemFor: (name: string) => string | undefined;
  descriptionNeeded?: boolean;
  textLabel: string;
  textHint: string;
  onSave: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Said once something is typed, not on an empty new form.
  const problem = props.problemFor(draft.name);
  const missing =
    (props.descriptionNeeded && !draft.description.trim()) ||
    !draft.text.trim() ||
    !fits(draft.text);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || missing) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSave(draft);
    } catch (e) {
      setError(why(e));
      setBusy(false);
    }
  };
  return (
    <form className="ps-edit" onSubmit={submit} aria-label={props.label}>
      <label className="field">
        Nom
        <input
          className="mono"
          value={draft.name}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value.trim() })}
        />
        {draft.name && problem && <small className="ps-err">{problem}</small>}
      </label>
      <label className="field">
        Description{props.descriptionNeeded ? "" : " (facultative)"}
        <input
          value={draft.description}
          maxLength={500}
          onChange={(e) => setDraft({ ...draft, description: oneLine(e.target.value) })}
        />
      </label>
      <label className="field">
        {props.textLabel}
        <textarea
          className="ps-text mono"
          value={draft.text}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
        {fits(draft.text) ? (
          <small>{props.textHint}</small>
        ) : (
          <small className="ps-err">Texte trop long.</small>
        )}
      </label>
      {error && <p className="error">{error}</p>}
      <div className="ps-acts">
        <button type="button" className="btn quiet sm" onClick={props.onCancel}>
          Annuler
        </button>
        <button className="btn pri sm" disabled={busy || !!problem || missing}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}

function CommandsTab(props: {
  setup: ProjectSetup;
  projectId: string;
  change: Change;
  onConfirm: (confirm: Confirmation) => void;
}) {
  // The command being written: a new one (no previous name) or one of the project's.
  const [editing, setEditing] = useState<{ previous?: string; draft: Draft } | null>(null);
  const commands = props.setup.commands;
  if (editing) {
    return (
      <Editor
        label={editing.previous ? `Modifier /${editing.previous}` : "Nouvelle commande"}
        draft={editing.draft}
        problemFor={(name) => commandProblem(name, commands, editing.previous)}
        textLabel="Message envoyé à l'agent"
        textHint="$ARGUMENTS reprend ce que tu tapes après la commande."
        onSave={async (draft) => {
          await props.change({
            type: "project.saveCommand",
            requestId: newId(),
            projectId: props.projectId,
            name: draft.name,
            ...(editing.previous ? { previous: editing.previous } : {}),
            description: draft.description.trim(),
            template: draft.text,
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="ps-body">
      <p className="ps-quiet">
        Tape / dans le composer pour les lancer. Chacune est un fichier de .moonagentic/commands.
      </p>
      {commands.length ? (
        <ul className="ps-list">
          {commands.map((c) => (
            <li key={c.name}>
              <div>
                <b className="mono">/{c.name}</b>
                <p>{c.description}</p>
              </div>
              <button
                className="btn quiet sm"
                onClick={() =>
                  setEditing({
                    previous: c.name,
                    draft: { name: c.name, description: c.description, text: c.template },
                  })
                }
              >
                Modifier
              </button>
              <button
                className="btn quiet sm ps-del"
                aria-label={`Supprimer /${c.name}`}
                onClick={() =>
                  props.onConfirm({
                    title: `Supprimer /${c.name} ?`,
                    text: "Son fichier est retiré du dossier du projet.",
                    action: "Supprimer",
                    run: () =>
                      props.change({
                        type: "project.removeCommand",
                        requestId: newId(),
                        projectId: props.projectId,
                        name: c.name,
                      }),
                  })
                }
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ps-quiet">Aucune commande pour ce projet.</p>
      )}
      <div className="ps-acts">
        <button
          className="btn sm"
          onClick={() => setEditing({ draft: { name: "", description: "", text: "" } })}
        >
          Nouvelle commande
        </button>
      </div>
    </div>
  );
}

function SkillsTab(props: {
  setup: ProjectSetup;
  projectId: string;
  change: Change;
  onConfirm: (confirm: Confirmation) => void;
}) {
  const [editing, setEditing] = useState<{ skill?: ProjectSkill; draft: Draft } | null>(null);
  const skills = props.setup.skills;
  if (editing) {
    return (
      <Editor
        label={editing.skill ? `Modifier ${editing.skill.name}` : "Nouvelle skill"}
        draft={editing.draft}
        problemFor={(name) => skillProblem(name, skills, editing.skill)}
        descriptionNeeded
        textLabel="Instructions"
        textHint="Ce que l'agent suit quand tu l'appelles avec $ ou quand elle sert."
        onSave={async (draft) => {
          await props.change({
            type: "project.saveSkill",
            requestId: newId(),
            projectId: props.projectId,
            ...(editing.skill ? { path: editing.skill.path } : {}),
            name: draft.name,
            description: draft.description.trim(),
            body: draft.text,
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="ps-body">
      <p className="ps-quiet">
        Appelle-les avec $ dans le composer. Une nouvelle skill va dans .agents/skills.
      </p>
      {skills.length ? (
        <ul className="ps-list">
          {skills.map((s) => (
            <li key={s.path}>
              <div>
                <b>{s.name}</b>
                <p>{s.description}</p>
                <small className="mono">{s.path}</small>
              </div>
              <button
                className="btn quiet sm"
                onClick={() =>
                  setEditing({
                    skill: s,
                    draft: { name: s.name, description: s.description, text: s.body },
                  })
                }
              >
                Modifier
              </button>
              <button
                className="btn quiet sm ps-del"
                aria-label={`Supprimer ${s.name}`}
                onClick={() =>
                  props.onConfirm({
                    title: `Supprimer ${s.name} ?`,
                    text: "Son SKILL.md est retiré du projet. Les autres fichiers de son dossier restent.",
                    action: "Supprimer",
                    run: () =>
                      props.change({
                        type: "project.removeSkill",
                        requestId: newId(),
                        projectId: props.projectId,
                        path: s.path,
                      }),
                  })
                }
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ps-quiet">Aucune skill dans ce projet.</p>
      )}
      <div className="ps-acts">
        <button
          className="btn sm"
          onClick={() => setEditing({ draft: { name: "", description: "", text: "" } })}
        >
          Nouvelle skill
        </button>
      </div>
    </div>
  );
}
