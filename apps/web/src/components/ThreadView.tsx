import { splitVerdict } from "../review-verdict.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { HERMES_AVATAR } from "../hermes.ts";
import { VerdictCard } from "./VerdictCard.tsx";
import { NEW_FOR, newMarkLabel } from "../new-mark.ts";
import {
  AGENT_SILENCE_STOP_MS,
  AGENT_STOPPED,
  agentStopped,
  briefOf,
  threadGroup,
  type AgentInfo,
  type Item,
  type Mascot as MascotChoice,
  type Thread,
  type ToolContent,
} from "@moonagentic/protocol";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { messageTokens } from "../commands.ts";
import { imageBlob } from "../attachments.ts";
import { fillComposer, openComposerPicker } from "../composer-fill.ts";
import { connection, newId } from "../connection.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { openQuestion as askedQuestion } from "../decision.ts";
import { answerHead } from "../long-answer.ts";
import { hasFocus, onFocusRequest, takeFocus } from "../focus.ts";
import { useLiveText } from "../live-text.ts";
import type { Held } from "../state.ts";
import { useThreadTimeline } from "../use-store.ts";
import { AgentPlan } from "./AgentPlan.tsx";
import { Glyph, I } from "../v2/I.tsx";
import { useScreen } from "../v2/use-screen.ts";
import { GROUP_LABEL, threadLine } from "../project-threads.ts";
import { prParts } from "../pr-links.ts";
import { PrChip } from "./PrChip.tsx";
import { Clamp } from "./Clamp.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageImages } from "./MessageImages.tsx";
import { PrCard } from "./PrCard.tsx";
import { ReviewCard } from "./ReviewCard.tsx";
import { TeamPanel } from "./TeamPanel.tsx";
import { withoutTeamJson } from "../team-json.ts";
import { isTeamThread, teamFeed } from "../team-feed.ts";
import {
  activityFeed,
  activityGlyph,
  activityLabel,
  activitySteps,
  imageInProgress,
  imagesMarkdown,
  shownElsewhere,
  unshownImages,
} from "../activity.ts";
import { ImageDraft } from "./ImageDraft.tsx";
import { Mascot } from "./Mascot.tsx";
import { mascotExpression } from "../mascot.ts";
import { speakerName } from "../speaker.ts";
import type { GlyphKind } from "../glyphs.ts";

/** The working line's verb, when the agent's name stands before it. */
const WORKING_VERB: Partial<Record<GlyphKind, string>> = {
  demarre: "démarre…",
  ecrit: "écrit…",
};

/** How far above what is shown the earlier messages start to be fetched, in pixels. */
const EARLIER_MARGIN = 600;
/**
 * A long thread is drawn from its end: this many of its blocks at first, then the ones above
 * them a part at a time, so its end shows at once on a phone (audit N35).
 */
const FIRST_DRAWN = 24;
const DRAWN_STEP = 24;

interface ThreadViewProps {
  /** Shown above the conversation, such as a coordinator's ways to start. */
  intro?: ReactNode;
  thread: Thread;
  /** Optional override for tests; otherwise subscribed directly by thread id. */
  items?: Item[] | undefined;
  /** Optional override for tests; otherwise subscribed directly by thread id. */
  held?: Held | undefined;
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
  items: itemsProp,
  held: heldProp,
  agents,
  threads,
  onOpenThread: openThread,
  intro,
}: ThreadViewProps) {
  const timeline = useThreadTimeline(thread.id);
  // On the phone a project thread's plan is its pill at the top: not drawn a second time below.
  const loose = isDiscussionsProject(
    connection.getState().projects.find((p) => p.id === thread.projectId),
  );
  const pillPlan = useScreen().roomy || loose ? undefined : thread.plan?.item;
  const items = itemsProp ?? timeline.items;
  const held = heldProp ?? timeline.held;
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
  const authors = useMemo(() => {
    const out: string[] = [];
    let author = thread.agentId;
    for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
      const item = items?.[i];
      if (item?.kind === "handoff") author = item.from;
      out[i] = author;
    }
    return out;
  }, [items, thread.agentId]);

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
  const team = isTeamThread(thread);
  const hasEarlier = earlier > 0;
  const blocks = useMemo(
    () => (items ? (team ? teamFeed(thread, items, hasEarlier) : activityFeed(items)) : []),
    [items, team, thread, hasEarlier],
  );
  // While the thread is drawn from its end, the first block drawn: those before it are not
  // drawn yet. Named, not counted, so a page that comes above leaves what is drawn as it is.
  const blockKey = (block: (typeof blocks)[number] | undefined) =>
    !block ? "" : block.kind === "detail" ? block.key : (items?.[block.index]?.id ?? "");
  const [drawing, setDrawing] = useState<{ threadId: string; from: string }>();
  let from = drawing?.threadId === thread.id ? drawing.from : undefined;
  if (items && from === undefined) {
    from = blockKey(blocks[Math.max(0, blocks.length - FIRST_DRAWN)]);
    setDrawing({ threadId: thread.id, from });
  }
  const undrawn = Math.max(0, from ? blocks.findIndex((b) => blockKey(b) === from) : 0);
  const drawAbove = (count: number) =>
    setDrawing({ threadId: thread.id, from: blockKey(blocks[Math.max(0, undrawn - count)]) });
  const drawer = useRef(drawAbove);
  useLayoutEffect(() => {
    drawer.current = drawAbove;
  });
  useEffect(() => {
    if (!undrawn) return;
    const more = () => drawer.current(DRAWN_STEP);
    if (typeof requestIdleCallback === "function") {
      const asked = requestIdleCallback(more, { timeout: 200 });
      return () => cancelIdleCallback(asked);
    }
    const timer = setTimeout(more, 30);
    return () => clearTimeout(timer);
  }, [undrawn, thread.id]);
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
  const drawnFrom = useRef({ threadId: thread.id, undrawn });
  useLayoutEffect(() => {
    const grewUp = first !== undefined && firstShown.current !== undefined;
    // What is held grew above, or more of it is drawn above.
    const drewAbove =
      drawnFrom.current.threadId === thread.id && undrawn < drawnFrom.current.undrawn;
    const before = (grewUp && first < firstShown.current!) || drewAbove;
    firstShown.current = first;
    drawnFrom.current = { threadId: thread.id, undrawn };
    const scroller = view.current;
    const was = anchor.current;
    if (before && scroller && was) {
      // The block it was may have joined the page's last turn: then by the distance to the end.
      if (was.el.isConnected) scroller.scrollTop += was.el.getBoundingClientRect().top - was.top;
      else scroller.scrollTop = scroller.scrollHeight - was.fromEnd;
    }
    if (earlier || undrawn) markAnchor();
    else anchor.current = undefined;
  }, [first, earlier, thread.id, undrawn]);
  // Going up near the first message shown fetches the page before it.
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // What is held is all drawn before more is asked for: a page coming in above blocks not
    // drawn yet would have them drawn all at once, out of place.
    if (!earlier || undrawn || typeof IntersectionObserver === "undefined" || !more.current) {
      return;
    }
    const near = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loader.current();
      },
      { root: view.current, rootMargin: `${EARLIER_MARGIN}px 0px 0px 0px` },
    );
    near.observe(more.current);
    return () => near.disconnect();
  }, [first, earlier > 0, thread.id, undrawn > 0]);

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
        // Held but not drawn yet: all of it is drawn, then it is shown.
        if (undrawn) {
          revealing.current = itemId;
          drawAbove(undrawn);
          return;
        }
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
  }, [items, earlier, thread.id, focusTick, reveal, undrawn]);

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
  // ...and so is a message the server wrote on its own, such as pull requests turned green.
  const firstNew =
    items?.findIndex((i, n) => n > lastOwn && (i.kind === "result" || i.id.startsWith("green:"))) ??
    -1;
  // « Nouveau » for an hour, then when it came: redrawn once the hour is over.
  const newAt = firstNew >= 0 ? (items![firstNew] as { at?: number }).at : undefined;
  const [, retell] = useState(0);
  useEffect(() => {
    if (newAt === undefined) return;
    const left = newAt + NEW_FOR - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => retell((n) => n + 1), left + 1000);
    return () => clearTimeout(timer);
  }, [newAt]);
  const newLabel = newAt === undefined ? "Nouveau" : newMarkLabel(newAt);
  const relayed = useMemo(() => (items ? relayedAnswers(items) : new Set<number>()), [items]);

  // What the agent does now, from the last item shown (plan mode switches are not shown).
  const lastItem = items?.findLast((i) => !shownElsewhere(i));
  const lastGlyph = activityGlyph(lastItem);
  const mascot = agent?.mascot;
  const mascotBadge = useMemo(
    () => (mascot && agent ? { mascot, name: agent.name } : undefined),
    [mascot, agent],
  );
  const onFold = useCallback(() => setReveal(undefined), []);

  const renderItem = (i: number, clamp?: boolean, showBy?: boolean) => {
    const item = items![i]!;
    if (item.id === pillPlan && i !== firstNew) return null;
    return (
      <div key={item.id} className="item" data-item={item.id}>
        {i === firstNew && (
          <div className={`nsep${newLabel === "Nouveau" ? "" : " past"}`} role="separator">
            <i />
            <span>{newLabel}</span>
            <i />
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
          ask={item.kind === "plan" ? lastUserTextBefore(items!, i) : undefined}
          clamp={clamp}
          threads={threads}
          onOpenThread={onOpenThread}
        />
        {relayed.has(i) && (
          <div className="hsent">
            <I n="check" s={13} />
            Envoyé sur Discord
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="view"
      id="view"
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
      <div className={`feed${working ? " working" : ""}`} ref={feed}>
        {intro}
        {strip && (
          <TeamPanel
            key={strip.lead.id}
            lead={strip.lead}
            team={strip.team}
            threads={threads}
            agents={agents}
            onOpenThread={onOpenThread}
            own={strip.lead.id === thread.id}
          />
        )}
        {thread.prReview && (
          <ReviewCard
            thread={thread}
            review={thread.prReview}
            threads={threads}
            agents={agents}
            onOpenThread={onOpenThread}
          />
        )}
        {lead && (
          <button className="hook up" onClick={() => onOpenThread(lead.id)}>
            <I n="back" s={16} className="hk" />
            <span className="t">
              {lead.prReview
                ? `Relecteur de la « ${lead.title} »`
                : `Sous-tâche de l'équipe « ${lead.title.replace(/^Équipe : /, "")} »`}
            </span>
          </button>
        )}
        {earlier > 0 && (
          <button
            ref={more}
            className="evt earlier"
            disabled={pagingState === "busy"}
            // What is held is drawn first; then the page before it is asked for.
            onClick={() => (undrawn ? drawAbove(undrawn) : void loadEarlier())}
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
          if (b < undrawn) return null;
          if (block.kind === "detail") {
            const live =
              working && b === blocks.length - 1 && block.indices.some((i) => i > lastUser);
            // The image being generated has its place in the thread, not only in the detail.
            const drafting = live ? imageInProgress(items!, block.indices) : undefined;
            // Once made, the image takes the sketch's place when no answer shows it.
            const made = unshownImages(items!, block.indices);
            return (
              <Fragment key={block.key}>
                <ActivityDetail
                  items={items!}
                  indices={block.indices}
                  live={live}
                  revealed={!!reveal && block.indices.some((i) => items![i]?.id === reveal)}
                  onFold={onFold}
                  render={renderItem}
                  mascot={mascotBadge}
                  quiet={thread.kind === "coordinator"}
                  thread={thread}
                  agents={agents}
                  threads={threads}
                  openQuestion={openQuestion}
                  working={working}
                  lastUser={lastUser}
                  authors={authors}
                  relayed={relayed}
                  firstNew={firstNew}
                  newLabel={newLabel}
                />
                {drafting && <ImageDraft since={drafting.at} />}
                {made.length > 0 && (
                  <div className="made-imgs">
                    <Markdown text={imagesMarkdown(made)} threadId={thread.id} />
                  </div>
                )}
              </Fragment>
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
        {/* Its branch's pull request, as it is now: a team shows its own in its card. */}
        {thread.workspace?.base && !thread.team && <PrCard key={thread.id} thread={thread} />}
        {/* The live line of the stretch at work says what the agent does: no second line. */}
        {thread.status === "running" && thread.inLine && (
          <div className="live" role="status">
            <I n="clock" s={16} className="lq" />
            <span className="lt">En file</span>
          </div>
        )}
        {thread.status === "running" && !thread.inLine && blocks.at(-1)?.kind !== "detail" && (
          <div className="live" role="status">
            {mascot ? (
              <Mascot mascot={mascot} expression={mascotExpression(lastItem)} name={agent.name} />
            ) : (
              <Glyph />
            )}
            <span className="shimmer">
              {agent ? speakerName(agent, thread) : "L'agent"}{" "}
              {WORKING_VERB[lastGlyph] ?? "travaille…"}
            </span>
          </div>
        )}
        {working && thread.quietSince && (
          <QuietNotice
            since={thread.quietSince}
            name={agent ? speakerName(agent, thread) : "L'agent"}
            threadId={thread.id}
          />
        )}
        {thread.status === "error" && thread.error && agentStopped(thread.error) && (
          <StoppedNotice key={thread.id} thread={thread} name={agent?.name ?? "L'agent"} />
        )}
        {thread.status === "error" && thread.error && !agentStopped(thread.error) && (
          <div className="ntc err" role="alert">
            {mascot && agent ? (
              <Mascot mascot={mascot} expression="error" name={agent.name} still />
            ) : (
              <I n="errc" s={20} className="ni" />
            )}
            <span className="tx">
              <b>Le tour s'est arrêté</b>
              <small>{thread.error}</small>
            </span>
          </div>
        )}
      </div>
      <div className="end" />
    </div>
  );
}

/**
 * Its agent went away in the middle of a turn (shut down, crashed, connection lost): said
 * plainly, with what it takes to go on. What it did stays above; « Reprendre » starts a new
 * session with the model the thread has now, which « Changer de modèle » can change first.
 */
function StoppedNotice({ thread, name }: { thread: Thread; name: string }) {
  const [sent, setSent] = useState(false);
  // The detail is what the agent or its connection said, for whoever wants to know.
  const detail = (thread.error ?? "")
    .split("\n")
    .filter((line, i) => !(i === 0 && line.startsWith(AGENT_STOPPED)))
    .join("\n")
    .trim();
  const waiting = thread.queue?.length ?? 0;
  return (
    <div className="ntc col" role="alert">
      <span className="tx">
        <b>{name} s'est arrêté</b>
        {waiting > 0 && (
          <small>{waiting > 1 ? `${waiting} messages en file` : "1 message en file"}</small>
        )}
        {detail && (
          <details>
            <summary>Détail</summary>
            <code>{detail}</code>
          </details>
        )}
      </span>
      <div className="na">
        <button className="b2 soft press" onClick={() => openComposerPicker(thread.id)}>
          Changer de modèle
        </button>
        <button
          className="b2 ink press"
          disabled={sent}
          onClick={() => {
            // Once: the card goes when the turn starts. Refused (busy for a moment), it can
            // be pressed again.
            setSent(true);
            setTimeout(() => setSent(false), 3000);
            connection.send({ type: "thread.resume", threadId: thread.id });
          }}
        >
          Reprendre
        </button>
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
    <div className="ntc" role="status">
      <span className="tx">
        <b>
          {name} ne donne plus signe de vie depuis {minutes} min.
        </b>
        <small>Arrêt automatique dans {left} min</small>
      </span>
      <button
        className="b2 soft press"
        onClick={() => connection.send({ type: "thread.cancel", threadId })}
      >
        Arrêter
      </button>
    </div>
  );
}

/**
 * The answers Hermes took back to Discord: after a message written there, the last answer
 * before the next message, once the agent is done with it.
 */
export function relayedAnswers(items: Item[]): Set<number> {
  const relayed = new Set<number>();
  items.forEach((item, u) => {
    // Only what the server marked as sent back to Discord.
    if (item.kind !== "user" || item.from !== "hermes" || !item.relayed) return;
    const next = items.findIndex((it, n) => n > u && it.kind === "user");
    const end = next < 0 ? items.length : next;
    for (let a = end - 1; a > u; a--) {
      if (items[a]?.kind === "agent") {
        relayed.add(a);
        return;
      }
    }
  });
  return relayed;
}

const startsAgentBlock = (items: Item[], index: number) => {
  if (items[index]?.kind !== "agent") return false;
  for (let j = index - 1; j >= 0; j--) {
    const kind = items[j]?.kind;
    if (kind === "agent") return false;
    if (kind === "user" || kind === "handoff") return true;
  }
  return true;
};

const lastUserTextBefore = (items: Item[], index: number): string | undefined => {
  for (let j = index - 1; j >= 0; j--) {
    const item = items[j];
    if (item?.kind === "user") return item.text;
  }
  return undefined;
};

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
          <div className="hook gone">
            <I n="hook" s={18} className="hk" />
            <span className="t">{item.title}</span>
            <span className="st">supprimé</span>
          </div>
        );
      }
      const members = threads.filter((t) => t.parentId === item.threadId);
      const group = threadGroup(opened, members);
      // What it waits for, in its own words: a state alone would not say what to do.
      const why = group === "waiting" ? threadLine(opened, members) : "";
      return (
        <button
          className="hook"
          data-group={group}
          aria-label={`Ouvrir le fil ${opened.title}`}
          onClick={() => onOpenThread(opened.id)}
        >
          <I n="hook" s={18} className="hk" />
          <span className="t">{opened.title}</span>
          <span
            className={`st${opened.status === "error" ? " er" : group === "waiting" ? " w" : group === "running" ? " ac" : ""}`}
          >
            {group === "running" && !opened.held && !opened.inLine && <Glyph />}
            {opened.held || opened.inLine ? "En file" : why || GROUP_LABEL[group]}
          </span>
        </button>
      );
    }
    case "result": {
      const done = threads.find((t) => t.id === item.threadId);
      return (
        <div className={`rsl${item.failed ? " x" : ""}`}>
          <button className="done" disabled={!done} onClick={() => done && onOpenThread(done.id)}>
            <I n={item.failed ? "errc" : "check"} s={16} />
            {done?.title ?? item.title}
          </button>
          <p>{item.summary}</p>
          {item.files.length > 0 && (
            <div className="chips wrap">
              {item.files.map((file) => (
                <span key={file} className="ppill mono" title={file}>
                  {file.split("/").pop()}
                </span>
              ))}
              {!!item.moreFiles && <span className="ppill">+{item.moreFiles}</span>}
            </div>
          )}
        </div>
      );
    }
    case "artifact":
      return <ArtifactCard item={item} thread={thread} />;
    case "moved":
      return (
        <div className="mvd">
          <I n="folder" s={13} />
          Déplacée dans {item.name}
        </div>
      );
    case "handoff": {
      const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "Agent retiré";
      return (
        <div className="evt">
          {name(item.from)} passe le relais à {name(item.to)}
        </div>
      );
    }
    case "agent":
      return (
        <div className="a">
          {showBy && <Who agent={agent} thread={thread} />}
          {thread.kind === "coordinator" && <ThreadCount text={item.text} />}
          {/* The team card shows the plan; its raw JSON is for the server only. */}
          {clamp ? (
            <Clamp>
              <Answer text={item.text} live={live} threadId={thread.id} />
            </Clamp>
          ) : (
            <Answer
              text={thread.role === "lead" ? withoutTeamJson(item.text) : item.text}
              live={live}
              threadId={thread.id}
            />
          )}
        </div>
      );
    case "thought":
      return (
        <details className="fold thought">
          <summary>
            Réflexion
            <I n="right" s={13} />
          </summary>
          <div className="fb">{item.text}</div>
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

/** Over a coordinator's answer that links threads: how many it speaks of. */
function ThreadCount({ text }: { text: string }) {
  const n = new Set([...text.matchAll(/\]\(fil:([\w-]{1,80})\)/g)].map((m) => m[1])).size;
  if (n < 2) return null;
  return (
    <div className="fcount">
      <I n="hook" s={14} />
      {n} fils de discussion
    </div>
  );
}

/** Who answers: the agent, then the model it runs when that says more. */
function Who({ agent, thread }: { agent: AgentInfo | undefined; thread: Thread }) {
  const speaker = speakerName(agent, thread);
  return (
    <div className="who">
      {agent?.name ?? speaker}
      {agent && speaker !== agent.name && <span className="m">{speaker}</span>}
    </div>
  );
}

/**
 * An answer: while it is being written, its Markdown is worked out a few times a second.
 * A review it ends with is shown as a card under it.
 */
function Answer({ text, live, threadId }: { text: string; live: boolean; threadId: string }) {
  const shown = useLiveText(text, live);
  const { text: body, verdict } = useMemo(() => splitVerdict(shown), [shown]);
  // A very long answer is drawn in part until asked for whole; one seen being written stays
  // whole, so it does not shrink under the reader's eyes when it ends.
  const [whole, setWhole] = useState(live);
  const { head, left } = useMemo(
    () => (whole || live ? { head: body, left: 0 } : answerHead(body)),
    [body, whole, live],
  );
  return (
    <>
      <Markdown text={head} threadId={threadId} />
      {left > 0 && (
        <button className="evt more-text" onClick={() => setWhole(true)}>
          Afficher la suite
        </button>
      )}
      {verdict && <VerdictCard verdict={verdict} />}
    </>
  );
}

/**
 * What an agent did on the way, folded into one line: while it works, the line says what
 * it does now. Opened, it is the thread as it ran, the engine's own messages included.
 */
interface ActivityDetailProps {
  items: Item[];
  indices: number[];
  live: boolean;
  /** Holds a message picked in the quick search: it stays open to show it. */
  revealed: boolean;
  onFold: () => void;
  render: (index: number) => ReactNode;
  /** The agent's moon, which stands in for the picture while the stretch is at work. */
  mascot?: { mascot: MascotChoice; name: string };
  /**
   * The coordinator's conversation: its steps are not shown, only one plain « Réfléchit »
   * line while it works, gone once it answers.
   */
  quiet?: boolean;
  // Passed for memo invalidation when an opened fold renders FeedItem children.
  thread: Thread;
  agents: AgentInfo[];
  threads: Thread[];
  openQuestion: string | undefined;
  working: boolean;
  lastUser: number;
  authors: string[];
  relayed: Set<number>;
  firstNew: number;
  newLabel: string;
}

function sameActivityDetail(prev: ActivityDetailProps, next: ActivityDetailProps): boolean {
  if (
    prev.live !== next.live ||
    prev.revealed !== next.revealed ||
    prev.onFold !== next.onFold ||
    prev.quiet !== next.quiet ||
    prev.mascot !== next.mascot ||
    prev.thread !== next.thread ||
    prev.agents !== next.agents ||
    prev.threads !== next.threads ||
    prev.openQuestion !== next.openQuestion ||
    prev.working !== next.working ||
    prev.lastUser !== next.lastUser ||
    prev.firstNew !== next.firstNew ||
    prev.newLabel !== next.newLabel ||
    prev.indices.length !== next.indices.length
  ) {
    return false;
  }
  for (let k = 0; k < prev.indices.length; k++) {
    const pi = prev.indices[k]!;
    const ni = next.indices[k]!;
    if (
      pi !== ni ||
      prev.items[pi] !== next.items[ni] ||
      prev.authors[pi] !== next.authors[ni] ||
      prev.relayed.has(pi) !== next.relayed.has(ni)
    ) {
      return false;
    }
  }
  return true;
}

const ActivityDetail = memo(function ActivityDetail({
  items,
  indices,
  live,
  revealed,
  onFold,
  render,
  mascot,
  quiet,
}: ActivityDetailProps) {
  const [opened, setOpened] = useState(false);
  if (quiet)
    return live ? (
      <div className="det quiet" role="status">
        <span className="think">
          <Glyph />
          <span className="nm shimmer">Réfléchit</span>
        </span>
      </div>
    ) : null;
  const open = opened || revealed;
  const { steps, failed } = activitySteps(items, indices);
  const last = items[indices.at(-1)!];
  const label = live ? activityLabel(last) : "Voir le détail";
  return (
    <div className={`det${open ? " open" : ""}`}>
      <button
        className={live ? "live" : "fold"}
        aria-expanded={open}
        onClick={() => {
          if (open) onFold();
          setOpened(!open);
        }}
      >
        {live &&
          (mascot ? (
            <Mascot mascot={mascot.mascot} expression={mascotExpression(last)} name={mascot.name} />
          ) : (
            <Glyph />
          ))}
        <span className={live ? "nm shimmer" : "nm"}>{label}</span>
        {steps > 0 && (
          <span className="tm">
            {steps} {steps > 1 ? "étapes" : "étape"}
            {failed > 0 && ` · ${failed} ${failed > 1 ? "échecs" : "échec"}`}
          </span>
        )}
        {!live && <I n="right" s={13} className="cv" />}
      </button>
      {open && <div className="detb">{indices.map((i) => render(i))}</div>}
    </div>
  );
}, sameActivityDetail);

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
    <div className="uw">
      {item.from === "coordinator" && <div className="ufrom">Coordinateur</div>}
      {item.from === "hermes" && (
        <div className="ufrom hermes">
          <img className="hav" src={HERMES_AVATAR} alt="" width={20} height={20} />
          <b>Hermes</b> · Discord
        </div>
      )}
      {item.from === "goal" && <div className="ufrom">Objectif · relance automatique</div>}
      {item.from === "pr" && <div className="ufrom">Pull request · correction automatique</div>}
      {item.from === "remarks" && (
        <div className="ufrom">Pull request · remarques de relecture</div>
      )}
      {!!item.images?.length && <MessageImages threadId={thread.id} images={item.images} />}
      {item.text && (
        <div className={`u${item.from === "coordinator" ? " brief" : ""}`}>
          {messageTokens(item.from === "coordinator" ? briefOf(item.text) : item.text).map(
            (part, i) =>
              part.kind ? (
                <span key={i} className={`tok ${part.kind}`}>
                  {part.text}
                </span>
              ) : (
                prParts(part.text).map((bit, j) =>
                  "link" in bit ? <PrChip key={`${i}-${j}`} link={bit.link} /> : bit.text,
                )
              ),
          )}
        </div>
      )}
      {canRestore &&
        (confirming ? (
          <div className="ucf" role="group" aria-label="Revenir à ce message">
            <span className="ppill">
              {item.beforeMove
                ? "Fichiers du projet remis comme au déplacement, suite du fil effacée"
                : "Fichiers remis comme avant, suite du fil effacée"}
            </span>
            <button className="b2 soft press" disabled={busy} onClick={() => setConfirming(false)}>
              Annuler
            </button>
            <button className="b2 red press" disabled={busy} onClick={() => void restore()}>
              Revenir ici
            </button>
          </div>
        ) : (
          <button
            className="uact"
            title="Remettre les fichiers comme avant ce message et reprendre d'ici"
            onClick={() => setConfirming(true)}
          >
            <I n="back" s={13} />
            Revenir ici
          </button>
        ))}
      {error && (
        <p className="uerr" role="alert">
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

/**
 * A question the agent asks with a tool of its own (Antigravity's `ask_question`, Claude
 * Code's AskUserQuestion). The feed keeps what was asked and answered; the answer itself
 * is given on the decision card, above the composer.
 */
function QuestionCard({ item, open }: { item: Extract<Item, { kind: "tool" }>; open: boolean }) {
  const questions = item.questions ?? [];
  // Still asked, it is on the decision card alone: twice, they took half a phone (audit M2).
  if (open) return null;
  return (
    <div className="ask done">
      {questions.map((q, i) => (
        <div key={i} className="aq">
          <b>{q.question}</b>
          {item.form === "answered" && item.answers?.[i] && <span>{item.answers[i]}</span>}
        </div>
      ))}
      {item.form === "cancelled" && <span className="st">Sans réponse</span>}
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
    <div className={`tl${open ? " open" : ""}`}>
      <button
        className="tlh"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
      >
        <ToolStatusIcon status={item.status === "in_progress" && !live ? "pending" : item.status} />
        <span className="nm">{item.title}</span>
        <span className="tm">{TOOL_KIND[item.toolKind] ?? ""}</span>
        {hasBody && <I n="right" s={13} className="cv" />}
      </button>
      {open && (
        <div className="tlb">
          {/* Said even above an older result: it is then known not to be the latest. */}
          {missing && failed && (
            <p className="tlw" role="alert">
              {failed}
              {content ? " Ce résultat n'est pas le dernier. " : " "}
              <button className="tlm" onClick={() => setTries((n) => n + 1)}>
                Réessayer
              </button>
            </p>
          )}
          {content?.map((c, i) => (
            <ToolBody key={i} content={c} />
          ))}
          {!content && !failed && (
            <p className="tlw" role="status">
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
      <button className="tlm" onClick={() => setAll(true)}>
        Afficher tout ({hidden} {hidden > 1 ? "lignes de plus" : "ligne de plus"})
      </button>
    ),
  };
}

function ToolStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <I n="check" s={15} className="ok" />;
  if (status === "failed") return <I n="x" s={15} className="er" />;
  if (status === "in_progress")
    return (
      <span className="gw" role="img" aria-label="En cours">
        <Glyph />
      </span>
    );
  return <span className="pend" />;
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
    <div className="tdf">
      <div className="tdh mono">{content.path}</div>
      <div className="tdb mono">
        {shown.map((line, i) => (
          <div key={i} className={line.t}>
            {line.t === "add" ? "+ " : "− "}
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
      <div className="ask done">
        <div className="aq">
          <b>{item.title}</b>
          <span>{chosen ? chosen.name : "Annulé"}</span>
        </div>
      </div>
    );
  }
  // Still asked, it is on the decision card alone (audit M2).
  return null;
}
