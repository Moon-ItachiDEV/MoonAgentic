import type { AgentInfo, Favorites, PermissionMode, Project, Thread } from "@moonagentic/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onFillComposer } from "../composer-fill.ts";
import { connection, newId } from "../connection.ts";
import { readPref, writePref } from "../prefs.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { ContextGauge } from "./ContextGauge.tsx";
import { IconArrowUp, IconBranch, IconShield, IconStop } from "./icons.tsx";
import { Picker } from "./Picker.tsx";

export function Composer(props: {
  agents: AgentInfo[];
  favorites: Favorites;
  thread: Thread | undefined;
  project: Project | undefined;
  onNewProject: () => void;
  onCreated: (threadId: string) => void;
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

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = async () => {
    if (!canSend || !agentId || !project) return;
    const value = text.trim();
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

  const placeholder = !project
    ? "Crée d'abord un projet pour parler à un agent"
    : thread
      ? `Répondre à ${agent?.name ?? "l'agent"}…`
      : "Demande n'importe quoi à tes agents…";

  return (
    <div className="composer" ref={root}>
      <textarea
        ref={input}
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={!project}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
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
      {pickerOpen && (
        <Picker
          agents={agents}
          agent={agent}
          model={model}
          favorites={props.favorites}
          projectId={project?.id}
          agentsTitle={thread ? "Passer à un autre agent" : "Agent"}
          settings={settings}
          onPickSetting={(settingId, value) => {
            if (thread)
              connection.send({ type: "thread.setSetting", threadId: thread.id, settingId, value });
            else if (agent) {
              const key = `${agent.id}.${settingId}`;
              setSettingPicks((p) => ({ ...p, [key]: value }));
              writePref(`setting.${key}`, value);
            }
          }}
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
