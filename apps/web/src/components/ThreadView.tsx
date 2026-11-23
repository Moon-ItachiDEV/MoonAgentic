import {
  AGENT_SILENCE_STOP_MS,
  threadGroup,
  type AgentInfo,
  type Item,
  type Mascot as MascotChoice,
  type Thread,
  type ToolContent,
} from "@moonagentic/protocol";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { messageTokens } from "../commands.ts";
import { imageBlob } from "../attachments.ts";
import { fillComposer } from "../composer-fill.ts";
import { connection, newId } from "../connection.ts";
import { openQuestion as askedQuestion } from "../decision.ts";
import { hasFocus, onFocusRequest, takeFocus } from "../focus.ts";
import { useLiveText } from "../live-text.ts";
import type { Held } from "../state.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { AgentPlan } from "./AgentPlan.tsx";
import { IconAlert, IconBranch, IconCheck, IconChevron, IconUndo, IconX } from "./icons.tsx";
import { GROUP_LABEL, threadLine } from "../project-threads.ts";
import { Clamp } from "./Clamp.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageImages } from "./MessageImages.tsx";
import { TeamCard } from "./TeamCard.tsx";
import { TeamStrip } from "./TeamStrip.tsx";
import { withoutTeamJson } from "../team-json.ts";
import { isTeamThread, teamFeed } from "../team-feed.ts";
import {
  activityFeed,
  activityGlyph,
  activityLabel,
  activitySteps,
  isPlanModeSwitch,
} from "../activity.ts";
import { StateGlyph } from "./StateGlyph.tsx";
import { Mascot } from "./Mascot.tsx";
import { mascotExpression } from "../mascot.ts";
import type { GlyphKind } from "../glyphs.ts";

/** The working line's verb, when the agent's name stands before it. */
const WORKING_VERB: Partial<Record<GlyphKind, string>> = {
  demarre: "démarre…",
  ecrit: "écrit…",
};

/** How far above what is shown the earlier messages start to be fetched, in pixels. */
const EARLIER_MARGIN = 600;

interface ThreadViewProps {
  /** Shown above the conversation, such as a coordinator's ways to start. */
  intro?: ReactNode;
  thread: Thread;
  /** The end of the thread's timeline, and the pages before it already fetched. */
  items: Item[] | undefined;
  /** Where those items start in the timeline, and how many are before them. */
  held: Held | undefined;
  agents: AgentInfo[];
  /** Every thread, for a team's progress and a coder's lead. */
  threads: Thread[];
  onOpenThread: (id: string) => void;
}

/**
 * A thread's conversation. One that cannot be drawn says so in its own place: the side bar
 * and the other threads stay, and opening another thread starts afresh.
 */
export function ThreadView(props: ThreadViewProps) {
  return (
    <ErrorBoundary resetKey={props.thread.id}>
      <Conversation {...props} />
    </ErrorBoundary>
  );
}

function Conversation({
  thread,
  items,
  held,
  agents,
  threads,
  onOpenThread: openThread,
  intro,
}: ThreadViewProps) {
  const lead = thread.parentId ? threads.find((t) => t.id === thread.parentId) : undefined;
  // The team's timeline, on the lead's thread and on each of its team's threads.
  const strip = thread.team
    ? { lead: thread, team: thread.team }
    : lead?.team
      ? { lead, team: lead.team }
      : undefined;
  const view = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Where the view was scrolled to when last looked at: going up from there is the reader's doing. */
  const scrolledTo = useRef(0);
  // The same function from one pass to the next, so a message already drawn is left alone
  // while another one is being written.
  const opener = useRef(openThread);
  useLayoutEffect(() => {
    opener.current = openThread;
  });
  const onOpenThread = useCallback((id: string) => opener.current(id), []);
  const agent = agents.find((a) => a.id === thread.agentId);
  // Who wrote each item: the thread's agent, or the one it was handed over from.
  const authors: string[] = [];
  let author = thread.agentId;
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const item = items?.[i];
    if (item?.kind === "handoff") author = item.from;
    authors[i] = author;
  }

  // Subscribes this client to the thread's timeline on the server.
  useEffect(() => {
    connection.send({ type: "thread.open", threadId: thread.id });
    return () => void connection.send({ type: "thread.leave", threadId: thread.id });
  }, [thread.id]);
  // A thread opens at its end, unless it opens on a message picked in the quick search.
  // Set before the effects below, so the timeline sent back on opening keeps that message.
  useLayoutEffect(() => {
    pinned.current = !hasFocus(thread.id);
    scrolledTo.current = 0;
    anchor.current = undefined;
    seeking.current = undefined;
  }, [thread.id]);

  // A long thread comes by its end: the messages before it are fetched a page at a time,
  // when the reader goes up to them or asks for one of them.
  const first = held?.first;
  const earlier = (items && held?.earlier) || 0;
  const [paging, setPaging] = useState<{ threadId: string; state: "busy" | "failed" }>();
  const pagingState = paging?.threadId === thread.id ? paging.state : undefined;
  /** The thread a page is being asked for: one at a time. */
  const asking = useRef<string>(undefined);
  /** Asks for the page before what is held, back to the item `reach` if given. */
  const loadEarlier = (reach?: string) => {
    const threadId = thread.id;
    if (asking.current === threadId || first === undefined || !earlier) return undefined;
    asking.current = threadId;
    setPaging({ threadId, state: "busy" });
    return connection
      .ask({
        type: "thread.page",
        requestId: newId(),
        threadId,
        before: first,
        ...(reach ? { reach } : {}),
      })
      .then(
        (page) => {
          setPaging((now) => (now?.threadId === threadId ? undefined : now));
          return page;
        },
        () => {
          setPaging({ threadId, state: "failed" });
          return undefined;
        },
      )
      .finally(() => {
        if (asking.current === threadId) asking.current = undefined;
      });
  };
  const loader = useRef(loadEarlier);
  useLayoutEffect(() => {
    loader.current = loadEarlier;
  });
  // The first message shown and where it was on screen: it stays put when a page comes in
  // above it.
  const top = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ el: Element; top: number; fromEnd: number }>(undefined);
  const markAnchor = () => {
    const el = top.current?.nextElementSibling;
    const scroller = view.current;
    anchor.current =
      el && scroller
        ? {
            el,
            top: el.getBoundingClientRect().top,
            fromEnd: scroller.scrollHeight - scroller.scrollTop,
          }
        : undefined;
  };
  const firstShown = useRef(first);
  useLayoutEffect(() => {
    const grewUp = first !== undefined && firstShown.current !== undefined;
    const before = grewUp && first < firstShown.current!;
    firstShown.current = first;
    const scroller = view.current;
    const was = anchor.current;
    if (before && scroller && was) {
      // The block it was may have joined the page's last turn: then by the distance to the end.
      if (was.el.isConnected) scroller.scrollTop += was.el.getBoundingClientRect().top - was.top;
      else scroller.scrollTop = scroller.scrollHeight - was.fromEnd;
    }
    if (earlier) markAnchor();
    else anchor.current = undefined;
  }, [first, earlier, thread.id]);
  // Going up near the first message shown fetches the page before it.
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!earlier || typeof IntersectionObserver === "undefined" || !more.current) return;
    const near = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loader.current();
      },
      { root: view.current, rootMargin: `${EARLIER_MARGIN}px 0px 0px 0px` },
    );
    near.observe(more.current);
    return () => near.disconnect();
  }, [first, earlier > 0, thread.id]);

  // A message picked in the quick search is shown once the timeline is here.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => onFocusRequest(() => setFocusTick((n) => n + 1)), []);
  // A message folded in a team's detail opens it first, then is shown on the next pass.
  const [reveal, setReveal] = useState<string>();
  const revealing = useRef<string>(undefined);
  // A message from before what is held is fetched first, with all that follows it.
  const seeking = useRef<{ id: string; asked: boolean }>(undefined);
  useLayoutEffect(() => {
    if (!items) return;
    const taken = takeFocus(thread.id);
    if (taken) seeking.current = undefined;
    const itemId = taken ?? revealing.current ?? seeking.current?.id;
    revealing.current = undefined;
    const el =
      itemId && view.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
    if (!el) {
      if (!itemId) return;
      if (items.some((i) => i.id === itemId)) {
        seeking.current = undefined;
        if (itemId !== reveal) {
          revealing.current = itemId;
          setReveal(itemId);
        }
      } else if (earlier && !seeking.current?.asked) {
        // Not at the end while it is on its way: the page must not follow what is written.
        pinned.current = false;
        const asked = loader.current(itemId);
        seeking.current = { id: itemId, asked: !!asked };
        void asked?.then((page) => {
          if (seeking.current?.id !== itemId) return;
          // Reached but not taken in, when the timeline was sent again meanwhile: once more.
          const reached = page?.items.some((i) => i.id === itemId);
          const here = connection.getState().items[thread.id]?.some((i) => i.id === itemId);
          seeking.current = reached && !here ? { id: itemId, asked: false } : undefined;
          if (seeking.current) setFocusTick((n) => n + 1);
        });
      } else if (!earlier) seeking.current = undefined;
      return;
    }
    seeking.current = undefined;
    pinned.current = false;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    // Restarts the highlight when the same message is picked twice.
    void el.offsetWidth;
    el.classList.add("flash");
  }, [items, earlier, thread.id, focusTick, reveal]);

  // Keep following new output while the reader is at the bottom: at once for a new message
  // or another thread...
  const count = items?.length;
  useLayoutEffect(() => {
    const el = view.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count, thread.id, thread.status]);
  // ...and whenever what is shown grows: a text being written is drawn a little after it
  // arrives, and measuring the page at each piece of it would cost a layout each time.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !feed.current) return;
    const grown = new ResizeObserver(() => {
      const el = view.current;
      if (el && pinned.current) el.scrollTop = el.scrollHeight;
      if (anchor.current) markAnchor();
    });
    grown.observe(feed.current);
    return () => grown.disconnect();
  }, []);

  // A question the agent asked with a tool can be answered until the user writes again.
  const openQuestion = askedQuestion(items, thread)?.id;

  // Only the current turn's tools are at work: one left unfinished earlier stays still.
  const lastUser = items?.findLastIndex((i) => i.kind === "user") ?? -1;
  const working = thread.status === "running" || thread.status === "waiting";
  // What the threads brought back since the user last wrote: the first of it is marked.
  const lastOwn = items?.findLastIndex((i) => i.kind === "user" && i.from !== "coordinator") ?? -1;
  const firstNew = items?.findIndex((i, n) => n > lastOwn && i.kind === "result") ?? -1;

  const team = isTeamThread(thread);
  const blocks = items ? (team ? teamFeed(thread, items, earlier > 0) : activityFeed(items)) : [];
  // What the agent does now, from the last item shown (plan mode switches are not shown).
  const lastItem = items?.findLast((i) => !isPlanModeSwitch(i));
  const lastGlyph = activityGlyph(lastItem);
  const mascot = agent?.mascot;

  const renderItem = (i: number, clamp?: boolean, showBy?: boolean) => {
    const item = items![i]!;
    return (
      <div key={item.id} className="item" data-item={item.id}>
        {i === firstNew && (
          <div className="new-sep" role="separator">
            <span>Nouveau</span>
          </div>
        )}
        <FeedItem
          item={item}
          thread={thread}
          agents={agents}
          agent={agents.find((a) => a.id === authors[i])}
          // A coordinator speaks alone in its conversation: no name above each answer.
          showBy={thread.kind !== "coordinator" && (showBy ?? startsAgentBlock(items!, i))}
          openQuestion={openQuestion}
          live={working && i > lastUser}
          ask={
            item.kind === "plan"
              ? items!
                  .slice(0, i)
                  .findLast((it): it is Extract<Item, { kind: "user" }> => it.kind === "user")?.text
              : undefined
          }
          clamp={clamp}
          threads={threads}
          onOpenThread={onOpenThread}
        />
      </div>
    );
  };

  return (
    <div
      className="view"
      ref={view}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Back near the end, the reader follows again. Only going up leaves it: an answer
        // that grew a lot since the last look makes the page longer, not the reader gone.
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) pinned.current = true;
        else if (el.scrollTop < scrolledTo.current) pinned.current = false;
        scrolledTo.current = el.scrollTop;
        if (anchor.current) markAnchor();
      }}
    >
      <div className="feed" ref={feed}>
        {intro}
        {/* A team started before the timeline was recorded has nothing to draw. */}
        {!!strip?.team.timeline?.length && (
          <TeamStrip
            key={strip.lead.id}
            lead={strip.lead}
            team={strip.team}
            threads={threads}
            agents={agents}
            onOpenThread={onOpenThread}
            defaultOpen={strip.lead.id === thread.id}
          />
        )}
        {thread.team && (
          <TeamCard
            thread={thread}
            team={thread.team}
            threads={threads}
            onOpenThread={onOpenThread}
          />
        )}
        {lead && (
          <button className="team-parent" onClick={() => onOpenThread(lead.id)}>
            Sous-tâche de l'équipe « {lead.title.replace(/^Équipe : /, "")} »
          </button>
        )}
        {earlier > 0 && (
          <button
            ref={more}
            className="earlier"
            disabled={pagingState === "busy"}
            onClick={() => void loadEarlier()}
          >
            {pagingState === "busy"
              ? "Chargement des messages précédents…"
              : pagingState === "failed"
                ? "Les messages précédents ne sont pas arrivés. Réessayer"
                : "Afficher les messages précédents"}
          </button>
        )}
        <div ref={top} className="feed-top" />
        {blocks.map((block, b) => {
          if (block.kind === "detail") {
            return (
              <ActivityDetail
                key={block.key}
                items={items!}
                indices={block.indices}
                live={working && b === blocks.length - 1 && block.indices.some((i) => i > lastUser)}
                revealed={!!reveal && block.indices.some((i) => items![i]?.id === reveal)}
                onFold={() => setReveal(undefined)}
                render={renderItem}
                mascot={mascot && agent ? { mascot, name: agent.name } : undefined}
              />
            );
          }
          if (!team) return renderItem(block.index);
          // An answer gets its agent's name unless the block just above is one too:
          // what is folded away does not count.
          const above = blocks[b - 1];
          const showBy =
            items![block.index]?.kind === "agent" &&
            !(above?.kind === "item" && items![above.index]?.kind === "agent");
          return renderItem(block.index, block.clamp, showBy);
        })}
        {/* The live line of the stretch at work says what the agent does: no second line. */}
        {thread.status === "running" && thread.inLine && (
          <div className="working">
            <StateGlyph kind="file" size={18} />
            En file : démarre dès qu'une place se libère sur le serveur.
          </div>
        )}
        {thread.status === "running" && !thread.inLine && blocks.at(-1)?.kind !== "detail" && (
          <div className="working">
            {mascot ? (
              <Mascot mascot={mascot} expression={mascotExpression(lastItem)} name={agent.name} />
            ) : (
              <StateGlyph kind={lastGlyph} size={18} />
            )}
            <span className="shimmer">
              {agent?.name ?? "L'agent"} {WORKING_VERB[lastGlyph] ?? "travaille…"}
            </span>
          </div>
        )}
        {working && thread.quietSince && (
          <QuietNotice
            since={thread.quietSince}
            name={agent?.name ?? "L'agent"}
            threadId={thread.id}
          />
        )}
        {thread.status === "error" && thread.error && (
          <div className={mascot ? "failed with-mascot" : "failed"} role="alert">
            {mascot && agent && (
              <Mascot mascot={mascot} expression="error" name={agent.name} still />
            )}
            <span>
              <b>Le tour s'est arrêté</b>
              {thread.error}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Says an agent at work has given no sign of progress for a while, as the server saw it,
 * and when it will be stopped; « Arrêter » is at hand.
 */
function QuietNotice({ since, name, threadId }: { since: number; name: string; threadId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  const minutes = Math.max(1, Math.floor((now - since) / 60_000));
  const left = Math.max(1, Math.ceil((since + AGENT_SILENCE_STOP_MS - now) / 60_000));
  return (
    <div className="quiet" role="status">
      <span>
        <b>
          {name} ne donne plus signe de vie depuis {minutes} min.
        </b>
        Sans nouvelles, il sera arrêté dans {left} min.
      </span>
      <button onClick={() => connection.send({ type: "thread.cancel", threadId })}>Arrêter</button>
    </div>
  );
}

const startsAgentBlock = (items: Item[], index: number) =>
  items[index]?.kind === "agent" &&
  !items
    .slice(0, index)
    .reverse()
    .find((i) => i.kind === "agent" || i.kind === "user" || i.kind === "handoff")
    ?.kind.startsWith("agent");

const FeedItem = memo(function FeedItem({
  item,
  thread,
  agents,
  agent,
  showBy,
  openQuestion,
  live,
  ask,
  clamp,
  threads,
  onOpenThread,
}: {
  threads: Thread[];
  onOpenThread: (id: string) => void;
  item: Item;
  thread: Thread;
  agents: AgentInfo[];
  agent: AgentInfo | undefined;
  showBy: boolean;
  /** The question still waiting for an answer, if any. */
  openQuestion: string | undefined;
  /** Part of the turn the agent is working on now. */
  live: boolean;
  /** For a plan, what the user asked in its turn. */
  ask?: string | undefined;
  /** A long answer shows its start, with a way to read the rest. */
  clamp?: boolean | undefined;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} thread={thread} />;
    case "opened": {
      // The thread as it is now, not as it was when it was opened.
      const opened = threads.find((t) => t.id === item.threadId);
      if (!opened) {
        return (
          <div className="opened-line gone">
            <IconBranch size={13} />
            <span className="oc-t">{item.title}</span>
            <span className="oc-state">Ce fil a été supprimé.</span>
          </div>
        );
      }
      const members = threads.filter((t) => t.parentId === item.threadId);
      const group = threadGroup(opened, members);
      // What it waits for, in its own words: a state alone would not say what to do.
      const why = group === "waiting" ? threadLine(opened, members) : "";
      return (
        <button
          className="opened-line"
          data-group={group}
          aria-label={`Ouvrir le fil ${opened.title}`}
          onClick={() => onOpenThread(opened.id)}
        >
          <IconBranch size={13} />
          <span className="oc-t">{opened.title}</span>
          <span className="oc-state">
            {opened.held || opened.inLine ? "En file" : why || GROUP_LABEL[group]}
          </span>
        </button>
      );
    }
    case "result": {
      const done = threads.find((t) => t.id === item.threadId);
      return (
        <div className={`result${item.failed ? " failed-result" : ""}`}>
          <button
            className="result-t"
            disabled={!done}
            onClick={() => done && onOpenThread(done.id)}
          >
            {item.failed ? <IconAlert size={13} /> : <IconCheck size={12} />}
            {done?.title ?? item.title}
          </button>
          <p className="result-s">{item.summary}</p>
          {item.files.length > 0 && (
            <div className="result-files">
              {item.files.map((file) => (
                <span key={file} className="result-file" title={file}>
                  {file.split("/").pop()}
                </span>
              ))}
              {!!item.moreFiles && <span className="result-more">+{item.moreFiles}</span>}
            </div>
          )}
        </div>
      );
    }
    case "handoff": {
      const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent retiré";
      return (
        <div className="handoff">
          <AgentBadge agent={agents.find((a) => a.id === item.to)} small />
          {name(item.from)} passe le relais à {name(item.to)}
        </div>
      );
    }
    case "agent":
      return (
        <div className="a">
          {showBy && (
            <div className="by">
              <AgentBadge agent={agent} small />
              {agent?.name ?? "Agent retiré"}
            </div>
          )}
          {/* The team card shows the plan; its raw JSON is for the server only. */}
          {clamp ? (
            <Clamp>
              <Answer text={item.text} live={live} />
            </Clamp>
          ) : (
            <Answer
              text={thread.role === "lead" ? withoutTeamJson(item.text) : item.text}
              live={live}
            />
          )}
        </div>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>
            <IconChevron />
            Réflexion
          </summary>
          <div className="md">{item.text}</div>
        </details>
      );
    case "tool":
      if (item.questions) {
        return <QuestionCard item={item} open={item.form === "open" || item.id === openQuestion} />;
      }
      return <ToolRow item={item} live={live} threadId={thread.id} />;
    case "plan":
      return <AgentPlan entries={item.entries} live={live} ask={ask} threadId={thread.id} />;
    case "permission":
      return <PermissionCard item={item} />;
  }
});

/** An answer: while it is being written, its Markdown is worked out a few times a second. */
function Answer({ text, live }: { text: string; live: boolean }) {
  return <Markdown text={useLiveText(text, live)} />;
}

/**
 * What an agent did on the way, folded into one line: while it works, the line says what
 * it does now. Opened, it is the thread as it ran, the engine's own messages included.
 */
function ActivityDetail({
  items,
  indices,
  live,
  revealed,
  onFold,
  render,
  mascot,
}: {
  items: Item[];
  indices: number[];
  live: boolean;
  /** Holds a message picked in the quick search: it stays open to show it. */
  revealed: boolean;
  onFold: () => void;
  render: (index: number) => ReactNode;
  /** The agent's moon, which stands in for the picture while the stretch is at work. */
  mascot?: { mascot: MascotChoice; name: string };
}) {
  const [opened, setOpened] = useState(false);
  const open = opened || revealed;
  const { steps, failed } = activitySteps(items, indices);
  const last = items[indices.at(-1)!];
  const label = live ? activityLabel(last) : "Voir le détail";
  return (
    <div className={`team-detail${open ? " open" : ""}`}>
      <button
        className="team-detail-h"
        aria-expanded={open}
        onClick={() => {
          if (open) onFold();
          setOpened(!open);
        }}
      >
        {live && mascot ? (
          <Mascot mascot={mascot.mascot} expression={mascotExpression(last)} name={mascot.name} />
        ) : live ? (
          <StateGlyph kind={activityGlyph(last)} size={18} />
        ) : (
          <IconChevron />
        )}
        <span className={live ? "nm shimmer" : "nm"}>{label}</span>
        {steps > 0 && (
          <span className="meta">
            {steps} {steps > 1 ? "étapes" : "étape"}
            {failed > 0 && ` · ${failed} ${failed > 1 ? "échecs" : "échec"}`}
          </span>
        )}
      </button>
      {open && <div className="team-detail-b">{indices.map((i) => render(i))}</div>}
    </div>
  );
}

/** The user's message, with a way back to the files as they were just before it. */
function UserMessage({ item, thread }: { item: Extract<Item, { kind: "user" }>; thread: Thread }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idle = thread.status === "idle" || thread.status === "error";
  const canRestore = !!item.checkpoint && !!thread.workspace && !thread.archived && idle;
  // A turn started meanwhile closes the confirmation for good.
  if (confirming && !canRestore) setConfirming(false);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      // Its images are read before the message goes, to come back in the composer with it.
      const files = await Promise.all(
        (item.images ?? []).map(async (image) => {
          const blob = await imageBlob(thread.id, image.id).catch(() => undefined);
          return blob && new File([blob], image.name, { type: image.mime });
        }),
      ).then((read) => read.filter((file): file is File => !!file));
      await connection.request({
        type: "thread.restore",
        requestId: newId(),
        threadId: thread.id,
        itemId: item.id,
      });
      fillComposer(thread.id, item.text, files);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="u-wrap">
      {item.from === "coordinator" && <div className="u-from">Coordinateur</div>}
      {item.from === "goal" && <div className="u-from">Objectif · relance automatique</div>}
      {item.from === "pr" && <div className="u-from">Pull request · correction automatique</div>}
      {!!item.images?.length && <MessageImages threadId={thread.id} images={item.images} />}
      {item.text && (
        <div className="u">
          {messageTokens(item.text).map((part, i) =>
            part.kind ? (
              <span key={i} className={`tok ${part.kind}`}>
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )}
        </div>
      )}
      {canRestore &&
        (confirming ? (
          <div className="u-confirm" role="group" aria-label="Revenir à ce message">
            <span>Les fichiers reviennent à avant ce message, et la suite du fil est effacée.</span>
            <button className="btn sm quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Annuler
            </button>
            <button className="btn sm danger" disabled={busy} onClick={() => void restore()}>
              Revenir ici
            </button>
          </div>
        ) : (
          <button
            className="u-act"
            title="Remettre les fichiers comme avant ce message et reprendre d'ici"
            onClick={() => setConfirming(true)}
          >
            <IconUndo />
            Revenir ici
          </button>
        ))}
      {error && (
        <p className="u-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const TOOL_KIND: Record<string, string> = {
  read: "lecture",
  edit: "modification",
  delete: "suppression",
  move: "déplacement",
  search: "recherche",
  execute: "commande",
  fetch: "web",
  think: "réflexion",
};

/** What waits for the user is answered on the card above the composer: here, a reminder. */
const WAITING = (
  <span className="ask-wait">
    <i aria-hidden />
    Attend ta réponse, au-dessus du champ de saisie
  </span>
);

/**
 * A question the agent asks with a tool of its own (Antigravity's `ask_question`, Claude
 * Code's AskUserQuestion). The feed keeps what was asked and answered; the answer itself
 * is given on the decision card, above the composer.
 */
function QuestionCard({ item, open }: { item: Extract<Item, { kind: "tool" }>; open: boolean }) {
  const questions = item.questions ?? [];
  return (
    <div className={`approve ask${open ? "" : " done"}`}>
      {questions.map((q, i) => (
        <div key={i} className="ask-q">
          <div className="q">
            <span>
              <b>{q.question}</b>
              {item.form === "answered" && item.answers?.[i] && ` · ${item.answers[i]}`}
            </span>
          </div>
        </div>
      ))}
      {open && <div className="ask-hint">{WAITING}</div>}
      {item.form === "cancelled" && <div className="ask-hint">Sans réponse.</div>}
    </div>
  );
}

/** How much of a tool's result is drawn at first: the rest waits for « Afficher tout ». */
const TOOL_SHOWN_LINES = 400;

function ToolRow({
  item,
  live,
  threadId,
}: {
  item: Extract<Item, { kind: "tool" }>;
  live: boolean;
  threadId: string;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = item.content.length > 0 || !!item.omitted;
  // A large result is not in the timeline: it is asked for when the line is opened, and
  // again if the tool went on since.
  const [whole, setWhole] = useState<{ of: string; content: ToolContent[] }>();
  const [failed, setFailed] = useState<string>();
  const [tries, setTries] = useState(0);
  const version = `${item.status}/${item.omitted ?? 0}`;
  const missing = open && !!item.omitted && whole?.of !== version;
  useEffect(() => {
    if (!missing) return;
    let current = true;
    setFailed(undefined);
    connection
      .ask({ type: "item.get", requestId: newId(), threadId, itemId: item.id })
      .then((reply) => {
        if (!current) return;
        setWhole({
          of: version,
          content: reply.item.kind === "tool" ? reply.item.content : [],
        });
      })
      .catch((error: unknown) => {
        if (current) setFailed(error instanceof Error ? error.message : String(error));
      });
    return () => {
      current = false;
    };
  }, [missing, version, threadId, item.id, tries]);
  // What was read stays on screen while a newer version is on its way.
  const content = item.omitted ? whole?.content : item.content;
  return (
    <div className={`tool${open ? " open" : ""}`}>
      <button
        className="tool-h"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
      >
        <ToolStatusIcon
          status={item.status === "in_progress" && !live ? "pending" : item.status}
          glyph={activityGlyph(item)}
        />
        <span className="nm">{item.title}</span>
        <span className="meta">{TOOL_KIND[item.toolKind] ?? ""}</span>
        {hasBody && <IconChevron />}
      </button>
      {open && (
        <div className="tool-body">
          {/* Said even above an older result: it is then known not to be the latest. */}
          {missing && failed && (
            <p className="tool-wait" role="alert">
              {failed}
              {content ? " Ce résultat n'est pas le dernier. " : " "}
              <button className="tool-more" onClick={() => setTries((n) => n + 1)}>
                Réessayer
              </button>
            </p>
          )}
          {content?.map((c, i) => (
            <ToolBody key={i} content={c} />
          ))}
          {!content && !failed && (
            <p className="tool-wait" role="status">
              Chargement du résultat…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Lines beyond the first ones, behind a button: a file of thousands is not drawn at once. */
function useShownLines<T>(lines: T[]): { shown: T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, lines.length - TOOL_SHOWN_LINES);
  return {
    shown: hidden ? lines.slice(0, TOOL_SHOWN_LINES) : lines,
    more: hidden > 0 && (
      <button className="tool-more" onClick={() => setAll(true)}>
        Afficher tout ({hidden} {hidden > 1 ? "lignes de plus" : "ligne de plus"})
      </button>
    ),
  };
}

function ToolStatusIcon({ status, glyph }: { status: string; glyph: GlyphKind }) {
  if (status === "completed")
    return (
      <span className="ok-ic">
        <IconCheck />
      </span>
    );
  if (status === "failed")
    return (
      <span className="err-ic">
        <IconX />
      </span>
    );
  if (status === "in_progress") return <StateGlyph kind={glyph} size={14} label="En cours" />;
  return <span className="pend-ic" />;
}

function ToolBody({ content }: { content: ToolContent }) {
  return content.type === "text" ? (
    <ToolText text={content.text} />
  ) : (
    <ToolDiff content={content} />
  );
}

function ToolText({ text }: { text: string }) {
  const { shown, more } = useShownLines(text.split("\n"));
  return (
    <>
      <pre>{shown.join("\n")}</pre>
      {more}
    </>
  );
}

function ToolDiff({ content }: { content: Extract<ToolContent, { type: "diff" }> }) {
  const lines = [
    ...(content.oldText ?? "")
      .split("\n")
      .filter((l, i, all) => l || i < all.length - 1)
      .map((l) => ({ t: "del", l })),
    ...content.newText.split("\n").map((l) => ({ t: "add", l })),
  ];
  const { shown, more } = useShownLines(lines);
  return (
    <div className="diff">
      <div className="diff-h">{content.path}</div>
      <div className="diff-b">
        {shown.map((line, i) => (
          <div key={i} className={line.t}>
            {line.t === "add" ? "+ " : "- "}
            {line.l}
          </div>
        ))}
      </div>
      {more}
    </div>
  );
}

function PermissionCard({ item }: { item: Extract<Item, { kind: "permission" }> }) {
  if (item.outcome !== null) {
    const chosen = item.options.find((o) => o.optionId === item.outcome);
    return (
      <div className="approve done">
        {item.title} · {chosen ? chosen.name : "Annulé"}
      </div>
    );
  }
  return (
    <div className="approve">
      <div className="q">
        <IconAlert />
        <span>
          L'agent demande ton accord : <b>{item.title}</b>
        </span>
      </div>
      <div className="ask-hint">{WAITING}</div>
    </div>
  );
}
