import type { AgentInfo, PermissionMode, Project, Thread } from "@moonagentic/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { readPref, writePref } from "../prefs.ts";
import { IconArrowUp, IconCheck, IconShield, IconStop } from "./icons.tsx";

export function AgentBadge({
  agent,
  small,
}: {
  agent: Pick<AgentInfo, "id" | "short"> | undefined;
  small?: boolean;
}) {
  return (
    <span className={`ag${small ? " sm" : ""}`} data-agent={agent?.id}>
      {agent?.short ?? "?"}
    </span>
  );
}

export function Composer(props: {
  agents: AgentInfo[];
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
  const input = useRef<HTMLTextAreaElement>(null);

  const agentId =
    thread?.agentId ??
    (agents.find((a) => a.id === pickedAgentId && a.available) ?? agents.find((a) => a.available))
      ?.id;
  const agent = agents.find((a) => a.id === agentId);
  const mode = thread?.permissionMode ?? newMode;
  const running = thread?.status === "running" || thread?.status === "waiting";
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
    try {
      const id = await connection.request({
        type: "thread.create",
        requestId: crypto.randomUUID(),
        projectId: project.id,
        agentId,
        permissionMode: newMode,
        text: value,
      });
      setText("");
      props.onCreated(id);
    } catch {
      // the server's message is shown as a notice
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
    <div className="composer">
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
          disabled={!!thread}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <AgentBadge agent={agent} />
          <span className="lbl">{agent?.name ?? "Aucun agent installé"}</span>
        </button>
        <span className="grow" />
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
      {menu && !thread && (
        <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
          <div className="menu-h">Agent</div>
          {agents.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              disabled={!a.available}
              onClick={() => {
                setPickedAgentId(a.id);
                writePref("agent", a.id);
                setMenu(false);
                input.current?.focus();
              }}
            >
              <AgentBadge agent={a} />
              <span className="tx">
                {a.name}
                {!a.available && a.hint && <small>{a.hint}</small>}
              </span>
              {a.id === agentId && (
                <span className="on-mark">
                  <IconCheck />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
