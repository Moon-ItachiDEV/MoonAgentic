import type {
  AgentInfo,
  Favorites,
  PermissionMode,
  ProjectCommand,
  Project,
  Skill,
  Thread,
} from "@moonagentic/protocol";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type AppAction,
  composerCommands,
  fillTemplate,
  matchCommands,
  mention,
  planModes,
  replaceTrigger,
  resolveSubmission,
  triggerAt,
} from "../commands.ts";
import { onFillComposer } from "../composer-fill.ts";
import { connection, newId } from "../connection.ts";
import { readPref, writePref } from "../prefs.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { ContextGauge } from "./ContextGauge.tsx";
import { IconArrowUp, IconBranch, IconShield, IconStop } from "./icons.tsx";
import { Picker } from "./Picker.tsx";
import { type Suggestion, Suggestions } from "./Suggestions.tsx";

const NARROW = "(max-width: 860px)";
const narrowQuery = typeof matchMedia === "function" ? matchMedia(NARROW) : undefined;
/** True on a phone-sized screen, where the composer's hints would not fit. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (listener) => {
      narrowQuery?.addEventListener("change", listener);
      return () => narrowQuery?.removeEventListener("change", listener);
    },
    () => narrowQuery?.matches ?? false,
  );
}

/** How long to wait after a key before asking the server for files. */
const FILE_SEARCH_DELAY_MS = 60;

export function Composer(props: {
  agents: AgentInfo[];
  favorites: Favorites;
  thread: Thread | undefined;
  project: Project | undefined;
  onNewProject: () => void;
  onCreated: (threadId: string) => void;
  /** Saves the thread as a Markdown file. */
  onExport: () => void;
  /** Opens the quick search. */
  onSearch: () => void;
}) {
  const { agents, thread, project } = props;
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickedAgentId, setPickedAgentId] = useState(() => readPref("agent"));
  const [newMode, setNewMode] = useState<PermissionMode>(() =>
    readPref("permissionMode") === "full" ? "full" : "supervised",
  );
  const [isolated, setIsolated] = useState(() => readPref("isolated") !== "false");
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [modelPicks, setModelPicks] = useState<Record<string, string>>({});
  /** Settings picked for a new thread, by `<agent>.<setting>`. */
  const [settingPicks, setSettingPicks] = useState<Record<string, string>>({});
  const [caret, setCaret] = useState(0);
  /** Where the `/`, `@` or `$` word starts that the user closed the list for with Escape. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  /** Files found for a `@` word, with the folder and the word they were searched for. */
  const [found, setFound] = useState<{ folder: string; query: string; files: string[] } | null>(
    null,
  );
  const [catalog, setCatalog] = useState<{
    folder: string;
    skills: Skill[];
    commands: ProjectCommand[];
  } | null>(null);
  /** The caret to restore once a picked suggestion is in the text. */
  const nextCaret = useRef<number | null>(null);
  const narrow = useNarrow();

  const agentId =
    thread?.agentId ??
    (agents.find((a) => a.id === pickedAgentId && a.available) ?? agents.find((a) => a.available))
      ?.id;
  const agent = agents.find((a) => a.id === agentId);
  const mode = thread?.permissionMode ?? newMode;
  const pickedModel = agent && (modelPicks[agent.id] ?? readPref(`model.${agent.id}`));
  // A thread handed to another agent has no model until that agent starts: its default.
  const model = thread
    ? (thread.model ?? agent?.defaultModel)
    : ((agent?.models?.some((m) => m.id === pickedModel) ? pickedModel : agent?.defaultModel) ??
      undefined);
  const modelName = agent?.models?.find((m) => m.id === model)?.name ?? model;
  const settings = Object.fromEntries(
    (agent?.settings ?? []).map((s) => {
      const key = `${agent?.id}.${s.id}`;
      const picked = thread
        ? thread.settings?.[s.id]
        : (settingPicks[key] ?? readPref(`setting.${key}`));
      return [s.id, picked && s.choices.some((c) => c.id === picked) ? picked : s.current];
    }),
  );
  // The mode shows on the chip only when it is not the agent's usual one.
  const modeSetting = agent?.settings?.find((s) => s.kind === "mode");
  const modeName =
    modeSetting && settings[modeSetting.id] !== modeSetting.current
      ? modeSetting.choices.find((c) => c.id === settings[modeSetting.id])?.name
      : undefined;
  const running = thread?.status === "running" || thread?.status === "waiting";
  // The model is switched between turns only, so a turn starting (here or on another
  // device) closes the picker for good rather than hiding it until the turn ends.
  if (menu && thread && running) setMenu(false);
  const pickerOpen = menu && !(thread && running);

  // Close the picker on Escape or on any press outside the composer.
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(false);
      input.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [pickerOpen]);
  useEffect(
    () =>
      onFillComposer((threadId, value) => {
        if (threadId !== thread?.id) return;
        setText(value);
        input.current?.focus();
      }),
    [thread?.id],
  );

  const canSend = text.trim().length > 0 && !busy && !running && !!agent?.available && !!project;

  // The skills and project commands of the folder the thread works in.
  const projectId = project?.id;
  const threadId = thread?.id;
  // Answers about another folder, such as the project picked before, are dropped.
  const folder = `${projectId ?? ""}/${threadId ?? ""}`;
  const currentFolder = useRef(folder);
  currentFolder.current = folder;
  const loadCatalog = () => {
    if (!projectId) return;
    const asked = folder;
    connection
      .ask({
        type: "composer.catalog",
        requestId: newId(),
        projectId,
        ...(threadId ? { threadId } : {}),
      })
      .then((reply) => {
        if (currentFolder.current !== asked) return;
        setCatalog({ folder: asked, skills: reply.skills, commands: reply.commands });
      })
      .catch(() => undefined);
  };
  const known = catalog?.folder === folder ? catalog : { skills: [], commands: [] };
  useEffect(loadCatalog, [projectId, threadId]);

  const commands = composerCommands({
    agent,
    agentCommands: thread?.commands,
    projectCommands: known.commands,
    inThread: !!thread,
  });
  const rawTrigger = project ? triggerAt(text, caret) : null;
  const trigger = rawTrigger && rawTrigger.start !== dismissed ? rawTrigger : null;
  const fileQuery = trigger?.kind === "@" ? trigger.query : null;

  // Files come from the server, which searches the thread's folder.
  useEffect(() => {
    if (fileQuery === null || !projectId) return;
    const asked = `${projectId}/${threadId ?? ""}`;
    let current = true;
    const timer = setTimeout(() => {
      connection
        .ask({
          type: "files.search",
          requestId: newId(),
          projectId,
          ...(threadId ? { threadId } : {}),
          query: fileQuery,
        })
        .then(
          (reply) =>
            current &&
            currentFolder.current === asked &&
            setFound({ folder: asked, query: fileQuery, files: reply.files }),
        )
        .catch(() => undefined);
    }, FILE_SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [fileQuery, projectId, threadId]);

  // Only the answer to what is typed now, so Enter never picks a file from an earlier word.
  const files = found?.folder === folder && found.query === fileQuery ? found.files : null;
  const suggestions: Suggestion[] = !trigger
    ? []
    : trigger.kind === "/"
      ? matchCommands(commands, trigger.query).map((command) => ({ type: "command", command }))
      : trigger.kind === "@"
        ? (files ?? []).map((path) => ({ type: "file", path }))
        : known.skills
            .filter((s) => s.name.toLowerCase().includes(trigger.query.toLowerCase()))
            .sort(
              (a, b) =>
                Number(!a.name.toLowerCase().startsWith(trigger.query.toLowerCase())) -
                Number(!b.name.toLowerCase().startsWith(trigger.query.toLowerCase())),
            )
            .map((skill) => ({ type: "skill", skill }));
  const empty =
    trigger?.kind === "@"
      ? files
        ? "Aucun fichier ne correspond."
        : "Je cherche dans le projet…"
      : trigger?.kind === "$"
        ? known.skills.length
          ? "Aucun skill ne correspond."
          : "Aucun skill trouvé. Ils se rangent dans .claude/skills ou .agents/skills, dans le projet ou chez toi."
        : null;
  // A `/` word that matches no command is just text.
  const suggesting = !!trigger && !pickerOpen && (suggestions.length > 0 || !!empty);
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1));

  const putText = (value: string, at: number) => {
    nextCaret.current = at;
    setText(value);
    setCaret(at);
    setActive(0);
  };

  /** Runs one of MoonAgentic's own commands. */
  const runAction = (action: AppAction) => {
    switch (action) {
      case "plan":
      case "agent": {
        const modes = planModes(agent?.settings);
        if (!modes || !agent) {
          connection.notify("Cet agent n'a pas de mode plan.");
          return;
        }
        const value = action === "plan" ? modes.plan : modes.normal;
        pickSetting(modes.setting.id, value);
        return;
      }
      case "models":
        setMenu(true);
        return;
      case "pin":
        if (thread)
          connection.send({
            type: "thread.setPinned",
            threadId: thread.id,
            pinned: !thread.pinned,
          });
        return;
      case "export":
        props.onExport();
        return;
      case "search":
        props.onSearch();
        return;
    }
  };

  const pick = (item: Suggestion) => {
    if (!trigger) return;
    if (item.type === "file" || item.type === "skill") {
      const word = item.type === "file" ? mention(item.path) : `$${item.skill.name}`;
      const next = replaceTrigger(text, trigger, word);
      putText(next.text, next.caret);
      return;
    }
    const command = item.command;
    const rest = text.slice(trigger.end).trim();
    if (command.action) {
      putText(rest, rest.length);
      runAction(command.action);
    } else if (command.template && !(command.template.includes("$ARGUMENTS") && !rest)) {
      const filled = fillTemplate(command.template, rest);
      putText(filled, filled.length);
    } else {
      // A command that takes arguments waits for them; sending it fills its message.
      const next = replaceTrigger(text, trigger, `/${command.name}`);
      putText(next.text, next.caret);
    }
  };

  useLayoutEffect(() => {
    const at = nextCaret.current;
    const el = input.current;
    if (at === null || !el) return;
    nextCaret.current = null;
    el.focus();
    el.setSelectionRange(at, at);
  }, [text]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = async () => {
    const typed = text.trim();
    if (!typed || busy) return;
    // MoonAgentic's own commands run here; the rest of the line stays in the composer.
    const submission = resolveSubmission(typed, commands);
    if (submission.kind === "action") {
      putText(submission.rest, submission.rest.length);
      runAction(submission.action);
      return;
    }
    if (!canSend || !agentId || !project) return;
    const value = submission.text;
    if (thread) {
      if (connection.send({ type: "thread.send", threadId: thread.id, text: value })) setText("");
      return;
    }
    setBusy(true);
    const changed = Object.entries(settings).filter(
      ([id, value]) => agent?.settings?.find((s) => s.id === id)?.current !== value,
    );
    try {
      const id = await connection.request({
        type: "thread.create",
        requestId: newId(),
        projectId: project.id,
        agentId,
        permissionMode: newMode,
        ...(model ? { model } : {}),
        ...(changed.length ? { settings: Object.fromEntries(changed) } : {}),
        ...(project.git ? { isolated } : {}),
        text: value,
      });
      setText("");
      props.onCreated(id);
    } catch (e) {
      // The message stays in the composer, with the reason shown as a notice.
      connection.notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleMode = () => {
    const next: PermissionMode = mode === "full" ? "supervised" : "full";
    if (thread)
      connection.send({
        type: "thread.setPermissionMode",
        threadId: thread.id,
        permissionMode: next,
      });
    else {
      setNewMode(next);
      writePref("permissionMode", next);
    }
  };

  function pickSetting(settingId: string, value: string) {
    if (thread)
      connection.send({ type: "thread.setSetting", threadId: thread.id, settingId, value });
    else if (agent) {
      const key = `${agent.id}.${settingId}`;
      setSettingPicks((p) => ({ ...p, [key]: value }));
      writePref(`setting.${key}`, value);
    }
  }

  const hints = narrow ? "" : " @ fichiers, $ skills, / commandes";
  const placeholder = !project
    ? "Crée d'abord un projet pour parler à un agent"
    : thread
      ? `Répondre à ${agent?.name ?? "l'agent"}…${hints}`
      : `Demande n'importe quoi à tes agents…${hints}`;

  return (
    <div className="composer" ref={root}>
      <textarea
        ref={input}
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={!project}
        aria-label="Message"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggesting}
        aria-controls={suggesting ? "composer-suggest" : undefined}
        aria-activedescendant={suggesting && suggestions.length ? `sg-${highlighted}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          // Erasing back to the `/`, `@` or `$` opens the list again.
          if (dismissed !== null && e.target.value.length <= dismissed + 1) setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={() => {
          // Skills or commands added to the folder since show up without a reload.
          loadCatalog();
        }}
        onKeyDown={(e) => {
          if (suggesting && !e.nativeEvent.isComposing) {
            const count = suggestions.length;
            if (e.key === "ArrowDown" && count) {
              e.preventDefault();
              setActive((highlighted + 1) % count);
              return;
            }
            if (e.key === "ArrowUp" && count) {
              e.preventDefault();
              setActive((highlighted - 1 + count) % count);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && count) {
              e.preventDefault();
              const item = suggestions[highlighted];
              if (item) pick(item);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(trigger.start);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="cbar">
        <button
          className="agentchip"
          disabled={!agent?.available || (!!thread && running)}
          title={
            thread && running
              ? "L'agent et ses réglages se changent entre deux réponses"
              : undefined
          }
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          onClick={() => setMenu((m) => !m)}
        >
          <AgentBadge agent={agent} />
          <span className="lbl">
            {agent?.name ?? "Aucun agent installé"}
            {modeName && <span className="sep"> · </span>}
            {modeName && <span className="mode">{modeName}</span>}
            {modelName && <span className="sep"> · </span>}
            {modelName}
          </span>
        </button>
        <span className="grow" />
        {!thread && project?.git && (
          <button
            className={`perm branch${isolated ? " on" : ""}`}
            aria-pressed={isolated}
            aria-label={isolated ? "Branche à part" : "Dans le dossier du projet"}
            title={
              isolated
                ? "L'agent travaille sur sa propre branche, dans une copie à part du projet"
                : "L'agent travaille directement dans le dossier du projet"
            }
            onClick={() => {
              setIsolated(!isolated);
              writePref("isolated", String(!isolated));
            }}
          >
            <IconBranch />
            <span className="lbl">{isolated ? "Branche à part" : "Dans le dossier"}</span>
          </button>
        )}
        <button
          className={`perm${mode === "full" ? " full" : ""}`}
          onClick={toggleMode}
          title={
            mode === "full"
              ? "L'agent agit sans demander"
              : "L'agent demande avant de modifier ou lancer quoi que ce soit"
          }
        >
          <IconShield />
          {mode === "full" ? "Accès complet" : "Supervisé"}
        </button>
        {thread?.usage && (
          <ContextGauge
            usage={thread.usage}
            action={
              thread.canCompact
                ? {
                    label: "Compacter la conversation",
                    disabled: running,
                    run: () =>
                      connection.send({
                        type: "thread.send",
                        threadId: thread.id,
                        text: "/compact",
                      }),
                  }
                : undefined
            }
          />
        )}
        {running ? (
          <button
            className="send stop"
            aria-label="Arrêter"
            onClick={() =>
              thread && connection.send({ type: "thread.cancel", threadId: thread.id })
            }
          >
            <IconStop />
          </button>
        ) : (
          <button
            className="send"
            aria-label="Envoyer"
            disabled={!canSend}
            onClick={() => void submit()}
          >
            <IconArrowUp />
          </button>
        )}
      </div>
      {suggesting && trigger && (
        <Suggestions
          kind={trigger.kind}
          items={suggestions}
          active={highlighted}
          empty={empty}
          onPick={pick}
          onHover={setActive}
        />
      )}
      {pickerOpen && (
        <Picker
          agents={agents}
          agent={agent}
          model={model}
          favorites={props.favorites}
          projectId={project?.id}
          agentsTitle={thread ? "Passer à un autre agent" : "Agent"}
          settings={settings}
          onPickSetting={pickSetting}
          onPickAgent={(id) => {
            if (thread) {
              if (id !== thread.agentId)
                connection.send({ type: "thread.switchAgent", threadId: thread.id, agentId: id });
              return;
            }
            setPickedAgentId(id);
            writePref("agent", id);
          }}
          onPickModel={(id) => {
            if (thread)
              connection.send({ type: "thread.setModel", threadId: thread.id, model: id });
            else if (agent) {
              setModelPicks((p) => ({ ...p, [agent.id]: id }));
              writePref(`model.${agent.id}`, id);
            }
            setMenu(false);
            input.current?.focus();
          }}
          onClose={() => setMenu(false)}
        />
      )}
    </div>
  );
}
