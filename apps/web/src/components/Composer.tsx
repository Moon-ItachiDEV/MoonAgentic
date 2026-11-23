import type {
  AgentInfo,
  Favorites,
  McpServerInfo,
  PermissionMode,
  ProjectCommand,
  Project,
  Skill,
  Thread,
} from "@moonagentic/protocol";
import {
  type ChangeEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AppAction,
  atMessageStart,
  composerCommands,
  fillTemplate,
  matchCommands,
  mention,
  planModes,
  removeTrigger,
  replaceTrigger,
  resolveSubmission,
  triggerAt,
} from "../commands.ts";
import { onFillComposer } from "../composer-fill.ts";
import {
  type Dictation,
  type Heard,
  dictationSupported,
  joinDictation,
  startDictation,
} from "../dictation.ts";
import { connection, newId } from "../connection.ts";
import { carriesFiles, IMAGE_ACCEPT, pastedImages } from "../images.ts";
import { useImageDrafts } from "../use-image-drafts.ts";
import { readPref, writePref } from "../prefs.ts";
import { quotaWarning, roomiest, tightest } from "../quotas.ts";
import { dismissQuotaWarning, useQuotas, useQuotaSeen } from "../use-quotas.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { ComposerImages } from "./ComposerImages.tsx";
import { AccessChip, Tray, type TrayQuota } from "./ComposerTray.tsx";
import { GoalBar } from "./GoalBar.tsx";
import { MessageQueue } from "./MessageQueue.tsx";
import {
  IconArrowUp,
  IconBolt,
  IconCaret,
  IconMic,
  IconQueue,
  IconSparkle,
  IconStop,
} from "./icons.tsx";
import { Presence } from "./Presence.tsx";
import { Picker } from "./Picker.tsx";
import { PlusMenu } from "./PlusMenu.tsx";
import { type Suggestion, Suggestions } from "./Suggestions.tsx";

const NARROW = "(max-width: 860px)";
const narrowQuery = typeof matchMedia === "function" ? matchMedia(NARROW) : undefined;
/** True on a phone-sized screen, where the composer's hints would not fit. */
export function useNarrow(): boolean {
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
  /** What the empty field says, when it is not the usual invitation. */
  placeholder?: string;
  onNewProject: () => void;
  /**
   * With no project yet: makes the project « Discussions » and picks it, so what is written
   * on the home page goes somewhere. Answers its id.
   */
  onNeedProject?: () => Promise<string>;
  /** The projects a new conversation can start in, picked from the tray under the box. */
  projects?: Project[];
  onPickProject?: (id: string) => void;
  /** The MCP servers handed to every agent, listed in the tray. */
  mcpServers?: McpServerInfo[];
  /** Opens the MCP servers' settings. */
  onMcp?: () => void;
  onCreated: (threadId: string) => void;
  /** Saves the thread as a Markdown file. */
  onExport: () => void;
  /** Opens the quick search. */
  onSearch: () => void;
  /** Opens what the agents wait for. */
  onRequests: () => void;
  /** Opens the agents' connections. */
  onConnections: () => void;
  /** Opens the settings. */
  onSettings: () => void;
  /** Opens Réglages › Abonnements. */
  onSubscriptions?: () => void;
  /** Archives the thread. */
  onArchive: () => void;
  /** Asks before deleting the thread. */
  onDelete: () => void;
  /** Opens the team launcher on the project, with the task typed so far. */
  onTeam: (task: string) => void;
  /** /lock: locks the project with the code. */
  onLock: (project: Project) => void;
  /** Opens the planning of a task for later, with what was typed so far. */
  onSchedule: (task: string) => void;
}) {
  const { agents, thread, project } = props;
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [trayMenu, setTrayMenu] = useState<"project" | "branch" | "mcp" | null>(null);
  /** Messages typed while the agent works: sent one by one once it is done. */
  // A favorite of another agent picked in a thread: its model, once that agent has the thread.
  const [handoffModel, setHandoffModel] = useState<{
    threadId: string;
    agentId: string;
    model: string;
  }>();
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
  /** Dictation under way: what was typed before it, and what was heard since. */
  const [voice, setVoice] = useState<{ typed: string; heard: Heard; started: number } | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const dictation = useRef<Dictation | undefined>(undefined);
  const [, tick] = useState(0);
  const [focused, setFocused] = useState(false);
  /** A press that started inside the composer, so a blur it causes does not fold it. */
  const pressedInside = useRef(false);
  const images = useImageDrafts();
  const filePicker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  /** Files are being dragged over the page: the composer shows it takes them. */
  const [dropping, setDropping] = useState(false);

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
  // Nearly out on its subscription: said over the composer, with an agent that has room.
  const quotas = useQuotas();
  const quotaSeen = useQuotaSeen();
  const warning = agent
    ? quotaWarning(
        quotas.find((q) => q.agentId === agent.id),
        agent.name,
        undefined,
        [model, modelName],
      )
    : undefined;
  const roomier = warning && agent ? roomiest(quotas, agents, agent.id) : undefined;
  const pickAgent = (id: string) => {
    if (thread) {
      if (id !== thread.agentId)
        connection.send({ type: "thread.switchAgent", threadId: thread.id, agentId: id });
      return;
    }
    setPickedAgentId(id);
    writePref("agent", id);
  };
  // The model is switched between turns only, so a turn starting (here or on another
  // device) closes the picker for good rather than hiding it until the turn ends.
  if (menu && thread && running) setMenu(false);
  const pickerOpen = menu && !(thread && running);

  useEffect(() => {
    if (!handoffModel) return;
    if (thread?.id !== handoffModel.threadId) return setHandoffModel(undefined);
    if (thread.agentId !== handoffModel.agentId || running) return;
    setHandoffModel(undefined);
    if (thread.model !== handoffModel.model)
      connection.send({ type: "thread.setModel", threadId: thread.id, model: handoffModel.model });
  }, [handoffModel, thread?.id, thread?.agentId, running]);

  // What is written while the agent works waits on the server, which sends it when the turn
  // ends: every window sees the same messages, and they outlive this page.
  const enqueue = (written = text) => {
    const queued = written.trim();
    if (!thread || !queued) return;
    // Taken at once, so the next one can be written straight away: it comes back if the
    // server refuses it and nothing was typed meanwhile.
    putText("", 0);
    connection
      .request({ type: "thread.queue", requestId: newId(), threadId: thread.id, text: queued })
      .catch((e: unknown) => {
        connection.notify(e instanceof Error ? e.message : String(e));
        setText((now) => now || queued);
      });
  };

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
      onFillComposer((threadId, value, files) => {
        if (threadId !== thread?.id) return;
        setText(value);
        if (files.length) images.add(files);
        input.current?.focus();
      }),
    [thread?.id],
  );

  const canSend =
    (text.trim().length > 0 || images.ready.length > 0) &&
    !images.sending &&
    !busy &&
    !running &&
    !!agent?.available &&
    (!!project || !!props.onNeedProject);
  const canDictate = !!project && dictationSupported();

  // One request for « Discussions » at a time, however often the field is focused.
  const needing = useRef<Promise<string | undefined> | null>(null);
  const needProject = (): Promise<string | undefined> => {
    if (!props.onNeedProject) return Promise.resolve(undefined);
    needing.current ??= props
      .onNeedProject()
      .catch((e: unknown) => {
        connection.notify(e instanceof Error ? e.message : String(e));
        return undefined;
      })
      .finally(() => {
        needing.current = null;
      });
    return needing.current;
  };
  // Opening the agent's menu or « + » also needs a folder: models and files are asked there.
  useEffect(() => {
    if (!project && (pickerOpen || plusOpen)) void needProject();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project, pickerOpen, plusOpen]);

  const startVoice = () => {
    if (!canDictate || voiceRef.current) return;
    setPlusOpen(false);
    setMenu(false);
    const typed = text;
    const started = startDictation({
      onHeard: (heard) => setVoice((v) => v && { ...v, heard }),
      onLevel: (level) => root.current?.style.setProperty("--lv", level.toFixed(2)),
      onEnd: (kept, heard, error) => {
        dictation.current = undefined;
        root.current?.style.removeProperty("--lv");
        setVoice(null);
        if (error) connection.notify(error);
        if (kept) {
          const value = joinDictation(typed, heard);
          putText(value, value.length);
        } else input.current?.focus();
      },
    });
    if (!started) return;
    dictation.current = started;
    setVoice({ typed, heard: { final: "", interim: "" }, started: Date.now() });
  };
  const stopVoice = () => dictation.current?.stop();
  const cancelVoice = () => dictation.current?.cancel();

  // The timer on the button, and Escape to drop what was said.
  useEffect(() => {
    if (!voice) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    // Escape drops what was said; Enter keeps it, as the tray says.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") stopVoice();
      else cancelVoice();
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      clearInterval(timer);
      document.removeEventListener("keydown", escape, true);
    };
  }, [!!voice]);
  // Leaving the thread or the page stops listening.
  useEffect(() => () => dictation.current?.cancel(), [thread?.id]);

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
  const runAction = (action: AppAction, rest = "") => {
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
      case "requests":
        props.onRequests();
        return;
      case "connections":
        props.onConnections();
        return;
      case "settings":
        props.onSettings();
        return;
      case "archive":
        props.onArchive();
        return;
      case "delete":
        props.onDelete();
        return;
      case "team":
        if (!project) {
          connection.notify("Choisis d'abord un projet.");
          return;
        }
        props.onTeam(rest);
        putText("", 0);
        return;
      case "schedule":
        if (!project) {
          connection.notify("Choisis d'abord un projet.");
          return;
        }
        props.onSchedule(rest);
        putText("", 0);
        return;
      case "lock":
        if (!project) {
          connection.notify("Choisis d'abord un projet.");
          return;
        }
        putText("", 0);
        props.onLock(project);
        return;
      case "goal": {
        const goal = rest.trim();
        // Picked from the list: the goal is written after it.
        if (!goal) {
          putText("/goal ", 6);
          return;
        }
        if (!thread) {
          void submit(undefined, goal);
          return;
        }
        putText("", 0);
        connection
          .request({ type: "thread.goal", requestId: newId(), threadId: thread.id, text: goal })
          .catch((e: unknown) => {
            connection.notify(e instanceof Error ? e.message : String(e));
            setText((now) => now || `/goal ${goal}`);
          });
        return;
      }
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
    if (!atMessageStart(text, trigger)) {
      // In the middle of a message the command goes in place, and the rest of the text stays.
      if (command.action) {
        const left = removeTrigger(text, trigger);
        putText(left.text, left.caret);
        runAction(command.action, left.text.trim());
        return;
      }
      const word =
        command.template && !command.template.includes("$ARGUMENTS")
          ? command.template
          : `/${command.name}`;
      const next = replaceTrigger(text, trigger, word);
      putText(next.text, next.caret);
      return;
    }
    const rest = text.slice(trigger.end).trim();
    if (command.action) {
      putText(rest, rest.length);
      runAction(command.action, rest);
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

  /** Sends what is written; `goal`: a new thread starts with that goal instead. */
  const submit = async (to?: string, goal?: string) => {
    const typed = goal ?? text.trim();
    if ((!typed && !images.drafts.length) || busy) return;
    // MoonAgentic's own commands run here, even while the agent works; the rest of the line
    // stays in the composer.
    const submission =
      goal === undefined
        ? resolveSubmission(typed, commands)
        : { kind: "send" as const, text: goal };
    if (submission.kind === "action") {
      putText(submission.rest, submission.rest.length);
      runAction(submission.action, submission.rest);
      return;
    }
    // While the agent works, what is written waits for the end of its turn.
    if (thread && running) {
      if (images.drafts.length) {
        connection.notify("Une image part avec un message envoyé entre deux réponses.");
        return;
      }
      enqueue(submission.text);
      return;
    }
    const sendTo = to ?? agentId;
    if (!canSend || !sendTo) return;
    const value = submission.text;
    const attachments = images.ready.length ? { attachments: images.ready.map((i) => i.id) } : {};
    if (thread) {
      if (
        connection.send({ type: "thread.send", threadId: thread.id, text: value, ...attachments })
      ) {
        setText("");
        images.sent();
      }
      return;
    }
    setBusy(true);
    // Handed to another agent at its limit: that agent starts with its own model and settings.
    const own = sendTo === agentId;
    const changed = Object.entries(own ? settings : {}).filter(
      ([id, value]) => agent?.settings?.find((s) => s.id === id)?.current !== value,
    );
    // Where the user was when they sent it: the new thread opens only if they stayed.
    const from = location.pathname;
    try {
      // No project yet: the conversation goes to « Discussions », made now if need be.
      const projectId = project?.id ?? (await needProject());
      if (!projectId) return;
      const id = await connection.request({
        type: "thread.create",
        requestId: newId(),
        projectId,
        agentId: sendTo,
        permissionMode: newMode,
        ...(model && own ? { model } : {}),
        ...(changed.length ? { settings: Object.fromEntries(changed) } : {}),
        ...(project?.git ? { isolated } : {}),
        text: value,
        ...attachments,
        ...(goal === undefined ? {} : { goal: {} }),
      });
      setText("");
      images.sent();
      // Gone to another page while the thread was being made: it is not pulled back from
      // there. The thread is in the lists, at work.
      if (location.pathname === from) props.onCreated(id);
    } catch (e) {
      // The message stays in the composer, with the reason shown as a notice.
      connection.notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setMode = (next: PermissionMode) => {
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

  const takePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    // Emptied, so picking the same file again is seen.
    event.target.value = "";
    if (files.length) images.add(files);
    input.current?.focus();
  };

  // Files dropped anywhere on the page go to the message; without this the browser would
  // leave the app to show the file instead.
  const canTake = !!project;
  const addImages = useRef(images.add);
  addImages.current = images.add;
  useEffect(() => {
    let over = 0;
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      over += 1;
      if (canTake) setDropping(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      over = Math.max(0, over - 1);
      if (!over) setDropping(false);
    };
    const hover = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = canTake ? "copy" : "none";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      over = 0;
      setDropping(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (canTake && files.length) {
        addImages.current(files);
        input.current?.focus();
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", hover);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", hover);
      window.removeEventListener("drop", drop);
    };
  }, [canTake]);

  const placeholder = voice
    ? "Je t'écoute…"
    : props.placeholder
      ? props.placeholder
      : thread && running
        ? narrow
          ? "Ajouter une consigne…"
          : `Ajouter une consigne pendant que ${agent?.name ?? "l'agent"} travaille…`
        : thread
          ? `Répondre à ${agent?.name ?? "l'agent"}…`
          : narrow
            ? "Demande à tes agents…"
            : "Demande n'importe quoi à tes agents…";

  // On a phone the composer is one line until it is used, as in the mockup.
  const hasImages = images.drafts.length > 0;
  const open =
    focused ||
    !!text ||
    hasImages ||
    !!voice ||
    plusOpen ||
    pickerOpen ||
    accessOpen ||
    !!trayMenu ||
    suggesting;
  const seconds = voice ? Math.floor((Date.now() - voice.started) / 1000) : 0;
  const heardText = voice ? `${voice.heard.final} ` : "";
  const full = mode === "full";

  // The top level of the model's effort is « Galaxie »: a star says so on the agent's chip.
  const effort = agent?.available ? agent.settings?.find((s) => s.kind === "effort") : undefined;
  const galaxy =
    !!effort &&
    effort.choices.length > 1 &&
    settings[effort.id] === effort.choices[effort.choices.length - 1]!.id;

  // Nearly out on its subscription: a row on top of the tray, with an agent that has room.
  const worst = agent
    ? tightest(
        quotas.find((q) => q.agentId === agent.id),
        [model, modelName],
      )
    : undefined;
  const atLimit = warning?.level === "full";
  const trayQuota: TrayQuota | undefined =
    warning && agent && worst && quotaSeen[agent.id] !== warning.key
      ? {
          level: warning.level,
          usedPercent: worst.usedPercent,
          text: warning.text,
          ...(warning.when ? { when: warning.when } : {}),
          ...(roomier && !running
            ? {
                roomier: { id: roomier.id, name: roomier.name },
                onSwitch: () => pickAgent(roomier.id),
              }
            : {}),
          ...(props.onSubscriptions ? { onLimits: props.onSubscriptions } : {}),
          onDismiss: () => dismissQuotaWarning(agent.id, warning.key),
        }
      : undefined;

  const closeMenus = (keep?: "plus" | "access" | "picker" | "tray") => {
    if (keep !== "plus") setPlusOpen(false);
    if (keep !== "access") setAccessOpen(false);
    if (keep !== "picker") setMenu(false);
    if (keep !== "tray") setTrayMenu(null);
  };
  const hasText = text.trim().length > 0;
  const agentLabel = agent?.name ?? (thread ? "Agent retiré" : "Aucun agent installé");

  let sendButtons: React.ReactNode;
  if (voice)
    sendButtons = (
      <button className="send vox" aria-label="Terminer la dictée" onClick={stopVoice}>
        <span className="vx-sq" />
        <span className="vx-t">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      </button>
    );
  else if (running)
    // While the agent works, Stop never leaves; what is typed goes in line beside it.
    sendButtons = (
      <>
        <button
          className={`send stop${hasText ? " soft" : ""}`}
          aria-label="Arrêter"
          title="Arrêter"
          onClick={() => thread && connection.send({ type: "thread.cancel", threadId: thread.id })}
        >
          <IconStop size={10} />
        </button>
        {hasText && (
          <button
            className="send"
            aria-label="Mettre en file"
            title="Mettre en file : part dès que l'agent a fini (Entrée)"
            onClick={() => enqueue()}
          >
            <IconQueue />
          </button>
        )}
      </>
    );
  else if (atLimit && roomier && !thread && (hasText || hasImages))
    sendButtons = (
      <button
        className="send alt"
        aria-label={`Envoyer à ${roomier.name}`}
        disabled={!canSend}
        onClick={() => void submit(roomier.id)}
      >
        <IconArrowUp />
        {narrow ? roomier.name : `Envoyer à ${roomier.name}`}
      </button>
    );
  else
    sendButtons = (
      <button
        className="send"
        aria-label="Envoyer"
        title={images.sending ? "L'image finit d'arriver sur le serveur" : undefined}
        disabled={!canSend}
        onClick={() => void submit()}
      >
        <IconArrowUp />
      </button>
    );

  return (
    <div
      className={`cmp${open ? " open" : ""}${voice ? " voice" : ""}${full ? " fullacc" : ""}`}
      ref={root}
      onFocus={() => setFocused(true)}
      onPointerDownCapture={() => {
        pressedInside.current = true;
      }}
      onBlur={(e) => {
        const box = e.currentTarget;
        if (box.contains(e.relatedTarget as Node | null)) return;
        // Safari gives no `relatedTarget` when a button is touched: wait for the click to
        // land before folding the composer, then fold only if the focus really left it.
        if (pressedInside.current) {
          setTimeout(() => {
            pressedInside.current = false;
            if (!box.contains(document.activeElement)) setFocused(false);
          }, 300);
          return;
        }
        setFocused(false);
      }}
    >
      {thread?.goal && <GoalBar thread={thread} goal={thread.goal} />}
      {thread && <MessageQueue thread={thread} />}
      <div
        className={`composer${focused ? " focus" : ""}${full ? " full" : ""}${voice ? " vx-on" : ""}${dropping ? " drop" : ""}`}
      >
        <div className="cmp-lead">
          <button
            aria-label={`Agent : ${agentLabel}${modelName ? `, ${modelName}` : ""}`}
            disabled={thread ? running : !agent?.available}
            onClick={() => {
              closeMenus("picker");
              setMenu(true);
            }}
          >
            <AgentBadge agent={agent} />
          </button>
          {full && (
            <button
              aria-label="Accès complet : l'agent agit sans demander"
              onClick={() => {
                closeMenus("access");
                setAccessOpen(true);
              }}
            >
              <IconBolt />
            </button>
          )}
        </div>
        {voice && (
          <div className="vxp">
            <div className="vxp-t" aria-live="polite">
              {voice.heard.final || voice.heard.interim ? (
                <>
                  {voice.typed && <span className="vxp-typed">{voice.typed} </span>}
                  {voice.heard.final && heardText}
                  <span className="vxp-cur">{voice.heard.interim}</span>
                </>
              ) : (
                <span className="vxp-ph">{placeholder}</span>
              )}
            </div>
          </div>
        )}
        <ComposerImages drafts={images.drafts} onRemove={images.remove} />
        {dropping && (
          <div className="cdrop" aria-hidden>
            Dépose l'image pour la joindre
          </div>
        )}
        <input
          ref={filePicker}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          aria-label="Choisir des images"
          onChange={takePicked}
        />
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          aria-label="Prendre une photo"
          onChange={takePicked}
        />
        <textarea
          ref={input}
          hidden={!!voice}
          rows={1}
          value={text}
          placeholder={placeholder}
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
          onPaste={(e) => {
            const files = pastedImages(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            images.add(files);
          }}
          onFocus={() => {
            // With no project yet, « Discussions » is made as soon as the user comes to write,
            // so the agent's models, files and commands are there by the time they send.
            if (!project) void needProject();
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
            // Shift+Tab in the text switches the access mode, as the menu's foot says.
            if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              setMode(full ? "supervised" : "full");
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="cbar">
          <PlusMenu
            open={plusOpen}
            disabled={!project && !props.onNeedProject}
            inThread={!!thread}
            onToggle={(open) => {
              setPlusOpen(open);
              if (open) closeMenus("plus");
            }}
            onImage={(from) => {
              setPlusOpen(false);
              (from === "camera" ? camera : filePicker).current?.click();
            }}
            onPick={(insert) => {
              setPlusOpen(false);
              input.current?.focus();
              // Starts the word the composer already completes: @ files, $ skills, / commands.
              if (insert === "/") {
                // A command is the message's first word.
                const rest = text.trimStart();
                putText(rest ? `/ ${rest}` : "/", 1);
                return;
              }
              const before = text.slice(0, caret);
              const space = before && !/\s$/.test(before) ? " " : "";
              putText(
                before + space + insert + text.slice(caret),
                before.length + space.length + insert.length,
              );
            }}
          />
          <AccessChip
            mode={mode}
            open={accessOpen}
            narrow={narrow}
            disabled={!project && !props.onNeedProject}
            onToggle={(open) => {
              setAccessOpen(open);
              if (open) closeMenus("access");
            }}
            onPick={(next) => {
              setMode(next);
              setAccessOpen(false);
              input.current?.focus();
            }}
          />
          <span className="grow" />
          <div className="ag-wrap">
            <button
              className="agentchip chip"
              // In a thread whose agent is gone, the picker is how it goes to another one.
              disabled={thread ? running : !agent?.available}
              title={
                thread && running
                  ? "L'agent et ses réglages se changent entre deux réponses"
                  : thread && !agent?.available
                    ? "Cet agent n'est plus disponible : choisis-en un autre pour continuer"
                    : undefined
              }
              aria-label={`Agent : ${agentLabel}${modelName ? `, ${modelName}` : ""}`}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              onClick={() => {
                if (!menu) closeMenus("picker");
                setMenu((m) => !m);
              }}
            >
              <AgentBadge agent={agent} />
              <span className="lbl">
                {!narrow && <span className="nm">{agentLabel}</span>}
                {modeName && <span className="mode">{modeName}</span>}
                {modelName && <span className="mdl">{modelName}</span>}
                {narrow && !modelName && <span className="nm">{agentLabel}</span>}
              </span>
              {galaxy && (
                <span className="gxs" title="Effort Galaxie">
                  <IconSparkle />
                </span>
              )}
              <IconCaret />
            </button>
            <Presence show={pickerOpen}>
              <Picker
                agents={agents}
                agent={agent}
                model={model}
                favorites={props.favorites}
                projectId={project?.id}
                inThread={!!thread}
                agentsTitle={thread ? "Passer à un autre agent" : "Agent"}
                settings={settings}
                {...(thread?.usage
                  ? {
                      context: {
                        used: thread.usage.used,
                        size: thread.usage.size,
                        ...(thread.canCompact && !running
                          ? {
                              onCompact: () => {
                                setMenu(false);
                                connection.send({
                                  type: "thread.send",
                                  threadId: thread.id,
                                  text: "/compact",
                                });
                              },
                            }
                          : {}),
                      },
                    }
                  : {})}
                onPickSetting={pickSetting}
                onPickAgent={pickAgent}
                onPickAgentModel={(id, model, stay) => {
                  if (thread) {
                    // The model is set once the new agent has the thread: the server takes one change at a time.
                    if (model) setHandoffModel({ threadId: thread.id, agentId: id, model });
                    connection.send({
                      type: "thread.switchAgent",
                      threadId: thread.id,
                      agentId: id,
                    });
                  } else {
                    setPickedAgentId(id);
                    writePref("agent", id);
                    if (model) {
                      setModelPicks((p) => ({ ...p, [id]: model }));
                      writePref(`model.${id}`, model);
                    }
                  }
                  if (stay) return;
                  setMenu(false);
                  input.current?.focus();
                }}
                onPickModel={(id, stay) => {
                  if (thread)
                    connection.send({ type: "thread.setModel", threadId: thread.id, model: id });
                  else if (agent) {
                    setModelPicks((p) => ({ ...p, [agent.id]: id }));
                    writePref(`model.${agent.id}`, id);
                  }
                  if (stay) return;
                  setMenu(false);
                  input.current?.focus();
                }}
                onClose={() => setMenu(false)}
              />
            </Presence>
          </div>
          {canDictate && (
            <button
              className={`mic-btn${voice ? " rec" : ""}`}
              aria-label={voice ? "Arrêter la dictée" : "Dicter"}
              title={voice ? "Arrêter la dictée" : "Dicter"}
              aria-pressed={!!voice}
              onClick={() => (voice ? stopVoice() : startVoice())}
            >
              <IconMic />
            </button>
          )}
          {sendButtons}
        </div>
        <div className="vlevel" aria-hidden>
          <i />
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
      </div>
      <Tray
        menu={trayMenu}
        onMenu={(m) => {
          setTrayMenu(m);
          if (m) closeMenus("tray");
        }}
        narrow={narrow}
        project={project}
        {...(!thread && props.projects && props.onPickProject
          ? { projects: props.projects, onPickProject: props.onPickProject }
          : {})}
        onNewProject={props.onNewProject}
        {...(!thread && project?.git
          ? {
              isolated: {
                on: isolated,
                onPick: (on: boolean) => {
                  setIsolated(on);
                  writePref("isolated", String(on));
                },
              },
            }
          : {})}
        {...(thread?.workspace ? { branch: thread.workspace.branch } : {})}
        mcpServers={props.mcpServers ?? []}
        onMcp={props.onMcp ?? props.onConnections}
        {...(trayQuota && !voice ? { quota: trayQuota } : {})}
        {...(voice ? { voice: { onStop: stopVoice, onCancel: cancelVoice } } : {})}
      />
    </div>
  );
}
