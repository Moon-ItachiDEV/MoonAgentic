import {
  agentSettingsFor,
  type AgentInfo,
  type Favorites,
  type McpServerInfo,
  type PermissionMode,
  type ProjectCommand,
  type Project,
  type Skill,
  type Thread,
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
import { onFillComposer, onOpenComposerPicker } from "../composer-fill.ts";
import {
  type Dictation,
  type Heard,
  dictationSupported,
  joinDictation,
  startDictation,
} from "../dictation.ts";
import { connection, newId } from "../connection.ts";
import { carriesFiles, IMAGE_ACCEPT, pastedImages } from "../images.ts";
import { readDraft, writeDraft } from "../drafts.ts";
import { useImageDrafts } from "../use-image-drafts.ts";
import { type PrLink, prKey, takePrLinks, withPrLinks } from "../pr-links.ts";
import { PrChip } from "./PrChip.tsx";
import { readPref, writePref } from "../prefs.ts";
import { isDiscussionsProject, looseDefault } from "../default-models.ts";
import { modelNameOf } from "../model-label.ts";
import type { ModelPick } from "../model-pick.ts";
import { setDefault, useDefaults } from "../defaults.ts";
import { speakerName } from "../speaker.ts";
import { quotaWarning, roomiest, tightest } from "../quotas.ts";
import { dismissQuotaWarning, useQuotas, useQuotaSeen } from "../use-quotas.ts";
import { ComposerImages } from "./ComposerImages.tsx";
import { type ComposerContext, PlusPop, PlusSheet, WhereSheet } from "./ComposerMenus.tsx";
import type { TrayQuota } from "../composer-tray.ts";
import { GoalBar } from "./GoalBar.tsx";
import { MessageQueue } from "./MessageQueue.tsx";
import { QuotaBar } from "./QuotaBar.tsx";
import { Picker } from "./Picker.tsx";
import { type Suggestion, Suggestions } from "./Suggestions.tsx";
import { I } from "../v2/I.tsx";
import { useComposerMorph } from "../v2/composer-morph.ts";
import { useScrFlag } from "../v2/scr.ts";
import { useScreen } from "../v2/use-screen.ts";
import { touchScreen } from "../touch.ts";

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

/**
 * Whether Enter sends. On a touch screen it goes to a new line, since the keyboard there has
 * no other way to make one, and the send button sends (audit N32).
 */
export function enterSends(): boolean {
  return !touchScreen();
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
  /** Its name for a screen reader, when another composer is on screen beside it. */
  label?: string;
  onNewProject: () => void;
  /**
   * With no project yet: makes the project « Discussions » and picks it, so what is written
   * on the home page goes somewhere. Answers its id.
   */
  onNeedProject?: () => Promise<string>;
  /**
   * A new conversation outside any project: a question or a web search. It starts on the
   * model made for that (Gemini 4 Hydrogen) and a pick made here is not kept for the next one.
   */
  loose?: boolean;
  /** The projects a new conversation can start in, picked from the tray under the box. */
  projects?: Project[];
  onPickProject?: (id: string) => void;
  /** Starts a conversation outside any project (in « Discussions »). */
  onPickLoose?: () => void;
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
  /** « /revue » : the pull request typed after it, if any. */
  onReview: (pr: string) => void;
  /** /lock: locks the project with the code. */
  onLock: (project: Project) => void;
  /** Opens the planning of a task for later, with what was typed so far. */
  onSchedule: (task: string) => void;
}) {
  const { roomy } = useScreen();
  const { agents, thread, project } = props;
  // What was typed in this thread and not sent comes back with it, PR chips included.
  const [initialDraft] = useState(() =>
    thread ? takePrLinks(readDraft(thread.id)) : { text: "", links: [] },
  );
  const [text, setText] = useState(initialDraft.text);
  /** Pull request links pasted: shown as chips, sent in full. */
  const [prs, setPrs] = useState<PrLink[]>(initialDraft.links);
  const draftOf = thread?.id;
  useEffect(() => {
    if (draftOf) writeDraft(draftOf, withPrLinks(text, prs));
  }, [draftOf, text, prs]);
  const [menu, setMenu] = useState(false);
  const [plusOpen, setPlusOpenNow] = useState(false);
  /** The sheet open from the « + » menu: the rest of what it offers, or where to work. */
  const [sheet, setSheet] = useState<"plus" | "where" | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  /** Messages typed while the agent works: sent one by one once it is done. */
  // A favorite of another agent picked in a thread: its model, once that agent has the thread.
  const [handoffModel, setHandoffModel] = useState<{
    threadId: string;
    agentId: string;
    model: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [pickedAgentId, setPickedAgentId] = useState(() => readPref("agent"));
  /** The agent and model picked in a conversation outside any project, for it only. */
  const [loosePick, setLoosePick] = useState<ModelPick>();
  // Back in a project or a thread, the pick made outside one is forgotten.
  if (loosePick && (!props.loose || thread)) setLoosePick(undefined);
  // A new thread starts as the defaults say, the same on every device.
  const { permissionMode: newMode, isolated } = useDefaults();
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
  /** Dictation under way: what was typed before it, and what was heard since. */
  const [voice, setVoice] = useState<{ typed: string; heard: Heard; started: number } | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const dictation = useRef<Dictation | undefined>(undefined);
  const [, tick] = useState(0);
  const [focused, setFocused] = useState(false);
  /** A press that started inside the composer, so a blur it causes does not fold it. */
  const pressedInside = useRef(false);
  const pressOver = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A press is over once its click has landed. A focus lost later (the keyboard put away) is
  // not its doing: the composer then folds at once, together with the keyboard.
  const released = () => {
    clearTimeout(pressOver.current);
    pressOver.current = setTimeout(() => {
      pressedInside.current = false;
    }, 350);
  };
  const images = useImageDrafts();
  const filePicker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  /** Files are being dragged over the page: the composer shows it takes them. */
  const [dropping, setDropping] = useState(false);

  // What new conversations outside any project start with, as set in their settings.
  const looseSaved = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().coordinator.loose,
  );
  const looseOn =
    !thread && props.loose ? (loosePick ?? looseSaved ?? looseDefault(agents)) : undefined;
  const looseAgent = looseOn && agents.find((a) => a.id === looseOn.agentId && a.available);
  const agentId =
    thread?.agentId ??
    looseAgent?.id ??
    (agents.find((a) => a.id === pickedAgentId && a.available) ?? agents.find((a) => a.available))
      ?.id;
  const agent = agents.find((a) => a.id === agentId);
  const mode = thread?.permissionMode ?? newMode;
  const pickedModel = agent && (modelPicks[agent.id] ?? readPref(`model.${agent.id}`));
  // A thread handed to another agent has no model until that agent starts: its default.
  const model = thread
    ? (thread.model ?? agent?.defaultModel)
    : looseAgent
      ? looseAgent.models?.some((m) => m.id === looseOn?.model)
        ? looseOn?.model
        : looseAgent.defaultModel
      : ((agent?.models?.some((m) => m.id === pickedModel) ? pickedModel : agent?.defaultModel) ??
        undefined);
  const modelName = modelNameOf(agent?.models, model);
  const agentSettings = agentSettingsFor(agent, model);
  const settings = Object.fromEntries(
    agentSettings.map((s) => {
      const key = `${agent?.id}.${s.id}`;
      const picked = thread
        ? thread.settings?.[s.id]
        : (settingPicks[key] ??
          // A new conversation outside any project starts on the reflection set for them.
          (looseOn && !loosePick && looseOn === looseSaved
            ? looseSaved.settings?.[s.id]
            : undefined) ??
          readPref(`setting.${key}`));
      return [s.id, picked && s.choices.some((c) => c.id === picked) ? picked : s.current];
    }),
  );
  // The mode shows on the chip only when it is not the agent's usual one.
  const modeSetting = agentSettings.find((s) => s.kind === "mode");
  const modeName =
    modeSetting && settings[modeSetting.id] !== modeSetting.current
      ? modeSetting.choices.find((c) => c.id === settings[modeSetting.id])?.name
      : undefined;
  const running = thread?.status === "running" || thread?.status === "waiting";
  // On a team's own thread, what is written while it works is a mission for its lead.
  const missions =
    thread?.role === "lead" &&
    (thread.team?.phase === "planning" || thread.team?.phase === "coding");
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
    if (props.loose) {
      setLoosePick({ agentId: id });
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

  // The « + » menu and the context's figures close the same way; the menu shrinks back first.
  const [plusOut, setPlusOut] = useState(false);
  const setPlusOpen = (on: boolean) => {
    if (!on && plusOpen) setPlusOut(true);
    setPlusOpenNow(on);
  };
  useScrFlag("pm", plusOpen);
  useEffect(() => {
    if (!plusOpen && !ctxOpen) return;
    const close = (event: PointerEvent) => {
      const at = event.target as Element;
      if (at.closest?.(".pmenu, .ddm, .ctxp, [data-a='pmenu'], .gz")) return;
      setPlusOpen(false);
      setCtxOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPlusOpen(false);
      setCtxOpen(false);
      input.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [plusOpen, ctxOpen]);
  useEffect(() => {
    if (plusOpen) return setPlusOut(false);
    const timer = setTimeout(() => setPlusOut(false), 230);
    return () => clearTimeout(timer);
  }, [plusOpen]);
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
  // « Changer de modèle » on a stopped agent's card: the same picker, opened from there.
  useEffect(
    () =>
      onOpenComposerPicker((threadId) => {
        if (threadId !== thread?.id) return;
        closeMenus("picker");
        setMenu(true);
      }),
    [thread?.id],
  );

  const canSend =
    (text.trim().length > 0 || prs.length > 0 || images.ready.length > 0) &&
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
  // Outside a project, the models are asked in another project's folder: « Discussions »
  // is only made for « + » or the first message.
  const looseFolder = props.loose ? props.projects?.[0] : undefined;
  // Outside a project, Hydrogen is only found once Antigravity has given its models.
  const looseAsked = useRef(false);
  useEffect(() => {
    // Before « Discussions » is made, any project's folder will do to ask for the list.
    const folder = project ?? looseFolder;
    if (!props.loose || thread || !folder || looseAsked.current) return;
    const agy = agents.find((a) => a.id === "antigravity");
    if (!agy?.available || agy.models || agy.modelsError) return;
    looseAsked.current = true;
    connection.send({ type: "agent.discover", agentId: agy.id, projectId: folder.id });
  }, [props.loose, thread, project, looseFolder, agents]);
  // Opening the agent's menu or « + » also needs a folder: models and files are asked there.
  useEffect(() => {
    if (!project && (plusOpen || (pickerOpen && !looseFolder))) void needProject();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project, pickerOpen, plusOpen, looseFolder]);

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
    model,
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
        const modes = planModes(agentSettings);
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
      case "review":
        if (!project) {
          connection.notify("Choisis d'abord un projet.");
          return;
        }
        props.onReview(rest);
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
    const typed = goal ?? withPrLinks(text.trim(), prs);
    if ((!typed && !images.drafts.length) || busy) return;
    // MoonAgentic's own commands run here, even while the agent works; the rest of the line
    // stays in the composer.
    const submission =
      goal === undefined
        ? resolveSubmission(typed, commands)
        : { kind: "send" as const, text: goal };
    if (submission.kind === "action") {
      putText(submission.rest, submission.rest.length);
      setPrs([]);
      runAction(submission.action, submission.rest);
      return;
    }
    if (thread && missions) {
      if (images.drafts.length) {
        connection.notify("Une mission part sans image : décris-la en mots.");
        return;
      }
      setBusy(true);
      try {
        await connection.request({
          type: "team.addMission",
          requestId: newId(),
          threadId: thread.id,
          text: submission.text,
        });
        setText("");
        setPrs([]);
      } catch (e) {
        connection.notify(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    // While the agent works, what is written waits for the end of its turn.
    if (thread && running) {
      if (images.drafts.length) {
        connection.notify("Une image part avec un message envoyé entre deux réponses.");
        return;
      }
      enqueue(submission.text);
      setPrs([]);
      return;
    }
    const sendTo = to ?? agentId;
    if (!canSend || !sendTo) return;
    const value = submission.text;
    const attachments = images.ready.length ? { attachments: images.ready.map((i) => i.id) } : {};
    if (thread) {
      // Writing in a resolved thread opens it again.
      if (thread.archived)
        connection.send({ type: "thread.setArchived", threadId: thread.id, archived: false });
      if (
        connection.send({ type: "thread.send", threadId: thread.id, text: value, ...attachments })
      ) {
        setText("");
        setPrs([]);
        images.sent();
      }
      return;
    }
    setBusy(true);
    // Handed to another agent at its limit: that agent starts with its own model and settings.
    const own = sendTo === agentId;
    const changed = Object.entries(own ? settings : {}).filter(
      ([id, value]) => agentSettings.find((s) => s.id === id)?.current !== value,
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
      setPrs([]);
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
      setDefault({ permissionMode: next });
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

  // The model that answers, as above its answers, rather than the program that runs it.
  const speaker = agent && thread ? speakerName(agent, thread) : "l'agent";
  const placeholder = voice
    ? "Je t'écoute…"
    : props.placeholder
      ? props.placeholder
      : thread?.archived
        ? "Écrire pour rouvrir le fil"
        : missions
          ? "Ajouter une mission"
          : thread && running
            ? "Ajouter une consigne"
            : thread
              ? `Répondre à ${speaker}`
              : `Demander à ${(modelName ?? agent?.name ?? "tes agents")
                  .replace(/^Gemini \d+(\.\d+)? /, "")
                  .replace(/\s*\([^)]*\)$/, "")}`;

  // On a phone the composer is one line until it is used, as in the mockup.
  const hasImages = images.drafts.length > 0;
  const open = focused || !!text || hasImages || !!voice || pickerOpen || ctxOpen || suggesting;
  // The line grows into the card, and back, instead of jumping from one to the other.
  const card = useRef<HTMLDivElement>(null);
  useComposerMorph(card, input, open);
  const seconds = voice ? Math.floor((Date.now() - voice.started) / 1000) : 0;
  const heardText = voice ? `${voice.heard.final} ` : "";
  const full = mode === "full";

  // The top level of the model's effort is « Galaxie »: a star says so on the agent's chip.
  const effort = agent?.available ? agentSettings.find((s) => s.kind === "effort") : undefined;
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
          brief: warning.brief,
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

  const closeMenus = (keep?: "plus" | "picker" | "ctx") => {
    if (keep !== "plus") setPlusOpen(false);
    if (keep !== "picker") setMenu(false);
    if (keep !== "ctx") setCtxOpen(false);
  };
  const hasText = text.trim().length > 0 || prs.length > 0;
  const hasDraft = hasText || hasImages;
  const agentLabel = agent?.name ?? (thread ? "Agent retiré" : "Aucun agent installé");
  const effortName = effort?.choices.find((c) => c.id === settings[effort.id])?.name;
  const noProject = !project && !props.onNeedProject;
  const context: ComposerContext = {
    project,
    ...(!thread && props.projects && props.onPickProject ? { projects: props.projects } : {}),
    ...(thread?.workspace ? { branch: thread.workspace.branch } : {}),
    // Only those the agent that answers gets.
    mcpServers: (props.mcpServers ?? []).filter(
      (s) => !s.agentIds || (!!agentId && s.agentIds.includes(agentId)),
    ),
  };
  const openImages = (from: "files" | "camera") => {
    setPlusOpen(false);
    (from === "camera" ? camera : filePicker).current?.click();
  };
  /** Starts the word the composer already completes: @ files, $ skills, / commands. */
  const insertWord = (word: "@" | "$" | "/") => {
    setPlusOpen(false);
    input.current?.focus();
    if (word === "/") {
      // A command is the message's first word.
      const rest = text.trimStart();
      putText(rest ? `/ ${rest}` : "/", 1);
      return;
    }
    const before = text.slice(0, caret);
    const space = before && !/\s$/.test(before) ? " " : "";
    putText(before + space + word + text.slice(caret), before.length + space.length + word.length);
  };
  const openMcp = () => {
    setPlusOpen(false);
    (props.onMcp ?? props.onConnections)();
  };
  const usage = thread?.usage;
  const usedShare = usage && usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : 0;
  // A chat outside any project (« Discussions ») shows no context gauge: short questions.
  const outside = isDiscussionsProject(project);

  const plusButton = (size: number) => (
    <button
      className={size === 20 ? "cb soft" : "cb"}
      data-a="pmenu"
      aria-label="Ajouter"
      aria-haspopup="menu"
      aria-expanded={plusOpen}
      disabled={noProject}
      title={noProject ? "Crée d'abord un projet" : undefined}
      onClick={() => {
        if (!plusOpen) closeMenus("plus");
        setPlusOpen(!plusOpen);
      }}
    >
      <I n="plus" s={size} />
    </button>
  );
  const micButton = (size: number, soft: boolean) =>
    canDictate &&
    !voice &&
    !hasDraft && (
      <button
        className={`cb${soft ? " soft" : ""} mic`}
        aria-label="Dicter"
        title="Dicter"
        onClick={() => startVoice()}
      >
        <I n="mic" s={size} />
      </button>
    );
  let sendButtons: React.ReactNode;
  if (voice)
    sendButtons = (
      <button className="cb stop vox" aria-label="Terminer la dictée" onClick={stopVoice}>
        <I n="stop" s={13} />
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
          className={`cb stop${hasText ? " soft" : ""}`}
          aria-label="Arrêter"
          title="Arrêter"
          onClick={() => thread && connection.send({ type: "thread.cancel", threadId: thread.id })}
        >
          <I n="stop" s={13} />
        </button>
        {hasText && (
          <button
            className="cb go"
            // On a team's lead, what is written is a mission, as with Entrée.
            aria-label={missions ? "Ajouter la mission" : "Mettre en file"}
            title={
              missions
                ? "Ajouter la mission (Entrée)"
                : "Mettre en file : part dès que l'agent a fini (Entrée)"
            }
            disabled={busy}
            onClick={() => (missions ? void submit() : enqueue())}
          >
            <I n="up" s={19} />
          </button>
        )}
      </>
    );
  else if (atLimit && roomier && !thread && hasDraft)
    sendButtons = (
      <button
        className="cb go alt"
        aria-label={`Envoyer à ${roomier.name}`}
        disabled={!canSend}
        onClick={() => void submit(roomier.id)}
      >
        <I n="up" s={19} />
        {roomier.name}
      </button>
    );
  else
    sendButtons = hasDraft && (
      <button
        className="cb go"
        aria-label="Envoyer"
        title={images.sending ? "L'image finit d'arriver sur le serveur" : undefined}
        disabled={!canSend}
        onClick={() => void submit()}
      >
        <I n="up" s={19} />
      </button>
    );

  return (
    <div
      className="cw"
      ref={root}
      // Only the text opens the composer: its « + » works from the folded line too.
      onFocus={(e) => (e.target as Element) === input.current && setFocused(true)}
      onPointerDownCapture={() => {
        clearTimeout(pressOver.current);
        pressedInside.current = true;
      }}
      onPointerUpCapture={released}
      onPointerCancelCapture={released}
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
      {!suggesting && (
        <div className="dcw">
          {thread?.quota && <QuotaBar thread={thread} quota={thread.quota} />}
          {trayQuota && !voice && !thread?.quota && (
            <div className={`updb glass qw ${trayQuota.level}`} role="status">
              <span className="tx" title={roomy ? undefined : trayQuota.text}>
                {roomy ? trayQuota.text : trayQuota.brief}
                {trayQuota.when && <small>{trayQuota.when}</small>}
              </span>
              {trayQuota.roomier && trayQuota.onSwitch ? (
                <button
                  className="b2 soft press"
                  aria-label={`Passer à ${trayQuota.roomier.name}`}
                  onClick={trayQuota.onSwitch}
                >
                  <span className="wo">Passer à </span>
                  <span className="nm">{trayQuota.roomier.name}</span>
                </button>
              ) : (
                trayQuota.onLimits && (
                  <button className="b2 soft press" onClick={trayQuota.onLimits}>
                    Voir les limites
                  </button>
                )
              )}
              <button
                className="gbt press"
                aria-label="Masquer cet avertissement"
                onClick={trayQuota.onDismiss}
              >
                <I n="x" s={14} />
              </button>
            </div>
          )}
          {thread?.goal && <GoalBar thread={thread} goal={thread.goal} />}
          {thread && <MessageQueue thread={thread} />}
        </div>
      )}
      <div
        className={`cmp${open ? " open" : ""}${focused && !full ? " focus" : ""}${full ? " full" : ""}${hasImages ? " hasatt" : ""}${voice ? " voice" : ""}${dropping ? " drop" : ""}`}
        id="cmp"
        ref={card}
      >
        {/* Its margin makes the composer look taller or shorter while it changes shape. */}
        <span className="cgrow" aria-hidden />
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
        {prs.length > 0 && (
          <div className="cprs">
            {prs.map((l) => (
              <PrChip
                key={prKey(l)}
                link={l}
                onRemove={() => setPrs((had) => had.filter((h) => prKey(h) !== prKey(l)))}
              />
            ))}
          </div>
        )}
        <div className="line">
          {plusButton(20)}
          {voice && (
            <div className="vxp" aria-live="polite">
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
          )}
          <textarea
            ref={input}
            hidden={!!voice}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={props.label ?? "Message"}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggesting}
            aria-controls={suggesting ? "composer-suggest" : undefined}
            aria-activedescendant={
              suggesting && suggestions.length ? `sg-${highlighted}` : undefined
            }
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
              if (files.length) {
                e.preventDefault();
                images.add(files);
                return;
              }
              const pasted = e.clipboardData.getData("text/plain");
              if (!pasted) return;
              const taken = takePrLinks(pasted);
              if (!taken.links.length) return;
              e.preventDefault();
              setPrs((had) => [
                ...had,
                ...taken.links.filter((l) => !had.some((h) => prKey(h) === prKey(l))),
              ]);
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = text.slice(0, start) + taken.text + text.slice(end);
              const nextCaret = start + taken.text.length;
              setText(next);
              setCaret(nextCaret);
              setActive(0);
              requestAnimationFrame(() => el.setSelectionRange(nextCaret, nextCaret));
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
              // Shift+Tab in the text switches the access mode.
              if (e.key === "Tab" && e.shiftKey) {
                e.preventDefault();
                setMode(full ? "supervised" : "full");
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && enterSends()) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {micButton(19, true)}
          {sendButtons}
        </div>
        <div className="bar">
          {plusButton(22)}
          <span className="acs">
            {full && (
              <button
                className="accp"
                aria-label="Accès complet : l'agent agit sans demander"
                onClick={() => {
                  closeMenus();
                  setSheet("plus");
                }}
              >
                <I n="bolt" s={13} />
                Accès complet
              </button>
            )}
          </span>
          <span className="sp" />
          {usage && !outside && (
            <button
              className={`gz${usedShare >= 90 ? " full" : ""}${ctxOpen ? " on" : ""}`}
              aria-label={`Contexte utilisé : ${usedShare} %`}
              aria-haspopup="dialog"
              aria-expanded={ctxOpen}
              onClick={() => {
                if (!ctxOpen) closeMenus("ctx");
                setCtxOpen(!ctxOpen);
              }}
            >
              <ContextRing share={usedShare} />
            </button>
          )}
          <button
            className="mdl"
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
            <span className="mn">{modelName ?? agentLabel}</span>
            {modeName && <span className="ef">{modeName}</span>}
            {effortName && <span className={`ef${galaxy ? " gx" : ""}`}>{effortName}</span>}
            <span className="cv">
              <I n="down" s={13} />
            </span>
          </button>
          {micButton(20, false)}
          {sendButtons}
        </div>
        <div className="vlevel" aria-hidden>
          <i />
        </div>
      </div>
      {voice && (
        <div className="vxh">
          <button onClick={stopVoice}>
            <kbd>Entrée</kbd> terminer
          </button>
          <button onClick={cancelVoice}>
            <kbd>Échap</kbd> annuler
          </button>
        </div>
      )}
      {(plusOpen || plusOut) && (
        <PlusPop
          {...context}
          out={!plusOpen}
          onImage={openImages}
          onInsert={insertWord}
          onWhere={() => {
            setPlusOpen(false);
            setSheet("where");
          }}
          {...(!thread && props.projects && props.onPickProject
            ? {
                where: {
                  projects: props.projects,
                  onPickProject: (id: string) => {
                    setPlusOpen(false);
                    props.onPickProject?.(id);
                  },
                  ...(props.onPickLoose
                    ? {
                        onPickLoose: () => {
                          setPlusOpen(false);
                          props.onPickLoose?.();
                        },
                      }
                    : {}),
                  onNewProject: () => {
                    setPlusOpen(false);
                    props.onNewProject();
                  },
                },
              }
            : {})}
          onMcp={openMcp}
          onMore={() => {
            setPlusOpen(false);
            setSheet("plus");
          }}
        />
      )}
      {ctxOpen && usage && !outside && (
        <div className="ctxp" role="dialog" aria-label="Contexte de l'agent">
          <div className="cxh">
            <b>{usedShare} %</b>
            <span>
              {Math.round(usage.used / 1000)} k sur {Math.round(usage.size / 1000)} k jetons
            </span>
          </div>
          <div className="cxb">
            <i
              style={{
                width: `${Math.min(100, usedShare)}%`,
                ...(usedShare >= 90 ? { background: "var(--err)" } : {}),
              }}
            />
          </div>
          {thread?.canCompact && !running && (
            <button
              className={`b2 ${usedShare >= 90 ? "ink" : "soft"} press`}
              onClick={() => {
                setCtxOpen(false);
                connection.send({ type: "thread.send", threadId: thread.id, text: "/compact" });
              }}
            >
              Compacter
            </button>
          )}
        </div>
      )}
      <Picker
        open={pickerOpen}
        agents={agents}
        agent={agent}
        model={model}
        favorites={props.favorites}
        projectId={(project ?? looseFolder)?.id}
        inThread={!!thread}
        agentsTitle={thread ? "Passer à un autre agent" : "Agent"}
        settings={settings}
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
          } else if (props.loose) {
            setLoosePick({ agentId: id, ...(model ? { model } : {}) });
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
          if (thread) connection.send({ type: "thread.setModel", threadId: thread.id, model: id });
          else if (agent && props.loose) setLoosePick({ agentId: agent.id, model: id });
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
      <PlusSheet
        {...context}
        open={sheet === "plus"}
        onClose={() => setSheet(null)}
        mode={mode}
        onMode={setMode}
        {...(!thread && project?.git
          ? {
              isolated: {
                on: isolated,
                onPick: (on: boolean) => {
                  setDefault({ isolated: on });
                },
              },
            }
          : {})}
        onImage={openImages}
        onInsert={insertWord}
        onWhere={() => setSheet("where")}
        onMcp={openMcp}
      />
      {!thread && props.projects && props.onPickProject && (
        <WhereSheet
          open={sheet === "where"}
          onClose={() => setSheet(null)}
          project={project}
          projects={props.projects}
          onPickProject={props.onPickProject}
          {...(props.onPickLoose ? { onPickLoose: props.onPickLoose } : {})}
          onNewProject={props.onNewProject}
        />
      )}
    </div>
  );
}

/** How full the agent's context is, as a small ring. */
function ContextRing({ share }: { share: number }) {
  const r = 7.2;
  const around = 2 * Math.PI * r;
  return (
    <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--track)" strokeWidth="2.2" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={`${((around * Math.min(100, share)) / 100).toFixed(1)} ${around.toFixed(1)}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}
