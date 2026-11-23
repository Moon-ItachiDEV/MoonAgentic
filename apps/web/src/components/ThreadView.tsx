import {
  threadGroup,
  type AgentInfo,
  type Item,
  type Thread,
  type ToolContent,
} from "@moonagentic/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { messageTokens } from "../commands.ts";
import { fillComposer } from "../composer-fill.ts";
import { connection, newId } from "../connection.ts";
import { hasFocus, onFocusRequest, takeFocus } from "../focus.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconAlert, IconBranch, IconCheck, IconChevron, IconUndo, IconX } from "./icons.tsx";
import { GROUP_LABEL } from "../project-threads.ts";
import { Clamp } from "./Clamp.tsx";
import { Markdown } from "./Markdown.tsx";
import { TeamCard } from "./TeamCard.tsx";
import { TeamStrip } from "./TeamStrip.tsx";
import { withoutTeamJson } from "../team-json.ts";
import { isTeamThread, teamFeed } from "../team-feed.ts";
import { activityFeed, activityLabel, activitySteps } from "../activity.ts";

export function ThreadView({
  thread,
  items,
  agents,
  threads,
  onOpenThread,
  intro,
}: {
  /** Shown above the conversation, such as a coordinator's ways to start. */
  intro?: ReactNode;
  thread: Thread;
  items: Item[] | undefined;
  agents: AgentInfo[];
  /** Every thread, for a team's progress and a coder's lead. */
  threads: Thread[];
  onOpenThread: (id: string) => void;
}) {
  const lead = thread.parentId ? threads.find((t) => t.id === thread.parentId) : undefined;
  // The team's timeline, on the lead's thread and on each of its team's threads.
  const strip = thread.team
    ? { lead: thread, team: thread.team }
    : lead?.team
      ? { lead, team: lead.team }
      : undefined;
  const view = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
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
  }, [thread.id]);

  // A message picked in the quick search is shown once the timeline is here.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => onFocusRequest(() => setFocusTick((n) => n + 1)), []);
  // A message folded in a team's detail opens it first, then is shown on the next pass.
  const [reveal, setReveal] = useState<string>();
  const revealing = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (!items) return;
    const itemId = takeFocus(thread.id) ?? revealing.current;
    revealing.current = undefined;
    const el =
      itemId && view.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
    if (!el) {
      if (itemId && itemId !== reveal && items.some((i) => i.id === itemId)) {
        revealing.current = itemId;
        setReveal(itemId);
      }
      return;
    }
    pinned.current = false;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    // Restarts the highlight when the same message is picked twice.
    void el.offsetWidth;
    el.classList.add("flash");
  }, [items, thread.id, focusTick, reveal]);

  // Keep following new output while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = view.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, thread.status]);

  // A question the agent asked with a tool can be answered until the user writes again.
  const lastQuestion = items?.findLast(
    (i) => i.kind === "user" || (i.kind === "tool" && i.questions),
  );
  const openQuestion =
    lastQuestion?.kind === "tool" && thread.status === "idle" && !thread.archived
      ? lastQuestion.id
      : undefined;

  // Only the current turn's tools are at work: one left unfinished earlier stays still.
  const lastUser = items?.findLastIndex((i) => i.kind === "user") ?? -1;
  const working = thread.status === "running" || thread.status === "waiting";
  // What the threads brought back since the user last wrote: the first of it is marked.
  const lastOwn = items?.findLastIndex((i) => i.kind === "user" && i.from !== "coordinator") ?? -1;
  const firstNew = items?.findIndex((i, n) => n > lastOwn && i.kind === "result") ?? -1;

  const team = isTeamThread(thread);
  const blocks = items ? (team ? teamFeed(thread, items) : activityFeed(items)) : [];

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
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="feed">
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
        {thread.status === "running" && blocks.at(-1)?.kind !== "detail" && (
          <div className="working">
            <span className="spin" />
            {agent?.name ?? "L'agent"} travaille…
          </div>
        )}
        {thread.status === "error" && thread.error && (
          <div className="failed" role="alert">
            <b>Le tour s'est arrêté</b>
            {thread.error}
          </div>
        )}
      </div>
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

function FeedItem({
  item,
  thread,
  agents,
  agent,
  showBy,
  openQuestion,
  live,
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
      const group = threadGroup(
        opened,
        threads.filter((t) => t.parentId === item.threadId),
      );
      return (
        <button
          className="opened-line"
          data-group={group}
          aria-label={`Ouvrir le fil ${opened.title}`}
          onClick={() => onOpenThread(opened.id)}
        >
          <IconBranch size={13} />
          <span className="oc-t">{opened.title}</span>
          <span className="oc-state">{opened.held ? "En file" : GROUP_LABEL[group]}</span>
        </button>
      );
    }
    case "result": {
      const done = threads.find((t) => t.id === item.threadId);
      return (
        <div className="result">
          <button
            className="result-t"
            disabled={!done}
            onClick={() => done && onOpenThread(done.id)}
          >
            <IconCheck size={12} />
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
              <Markdown text={item.text} />
            </Clamp>
          ) : (
            <Markdown text={thread.role === "lead" ? withoutTeamJson(item.text) : item.text} />
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
        return <QuestionCard item={item} threadId={thread.id} open={item.id === openQuestion} />;
      }
      return <ToolRow item={item} live={live} />;
    case "plan":
      return (
        <div className="card">
          <div className="card-h">Plan</div>
          <ul className="plan">
            {item.entries.map((entry, i) => (
              <li
                key={i}
                className={
                  entry.status === "completed"
                    ? "done"
                    : entry.status === "in_progress"
                      ? "now"
                      : ""
                }
              >
                <span className="cir">
                  {entry.status === "completed" && <IconCheck size={9} />}
                </span>
                {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "permission":
      return <PermissionCard item={item} threadId={thread.id} />;
  }
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
}: {
  items: Item[];
  indices: number[];
  live: boolean;
  /** Holds a message picked in the quick search: it stays open to show it. */
  revealed: boolean;
  onFold: () => void;
  render: (index: number) => ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const open = opened || revealed;
  const { steps, failed } = activitySteps(items, indices);
  const label = live ? activityLabel(items[indices.at(-1)!]) : "Voir le détail";
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
        {live ? <span className="spin" /> : <IconChevron />}
        <span className="nm">{label}</span>
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
      await connection.request({
        type: "thread.restore",
        requestId: newId(),
        threadId: thread.id,
        itemId: item.id,
      });
      fillComposer(thread.id, item.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="u-wrap">
      {item.from === "coordinator" && <div className="u-from">Coordinateur</div>}
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

/**
 * A question the agent asks with a tool of its own, such as Antigravity's `ask_question`.
 * The turn has ended on it: the answer goes out as the user's next message.
 */
function QuestionCard({
  item,
  threadId,
  open,
}: {
  item: Extract<Item, { kind: "tool" }>;
  threadId: string;
  open: boolean;
}) {
  const questions = item.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  // One question with one answer goes out on the click; anything more is sent together.
  const direct = questions.length === 1 && !questions[0]?.multi;
  // Sent once: a second click before the thread shows as running would send it twice.
  const [sent, setSent] = useState(false);
  if (sent && !open) setSent(false);
  const send = (text: string) => {
    if (!sent && connection.send({ type: "thread.send", threadId, text })) setSent(true);
  };
  const complete = questions.every((_, i) => picked[i]?.length);
  return (
    <div className={`approve ask${open ? "" : " done"}`}>
      {questions.map((q, i) => (
        <div key={i} className="ask-q" role="group" aria-label={q.question}>
          <div className="q">
            <span>
              {i === 0 && open && "L'agent te pose une question : "}
              <b>{q.question}</b>
            </span>
          </div>
          {open && (
            <div className="row">
              {q.options.map((option) => {
                const on = picked[i]?.includes(option) ?? false;
                return (
                  <button
                    key={option}
                    className={`btn sm${on ? " pri" : ""}`}
                    aria-pressed={direct ? undefined : on}
                    disabled={sent}
                    onClick={() => {
                      if (direct) return send(option);
                      setPicked((p) => {
                        const mine = p[i] ?? [];
                        const next = !q.multi
                          ? [option]
                          : on
                            ? mine.filter((o) => o !== option)
                            : [...mine, option];
                        return { ...p, [i]: next };
                      });
                    }}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {open && !direct && (
        <div className="row">
          <button
            className="btn sm pri"
            disabled={!complete || sent}
            onClick={() =>
              send(
                questions
                  .map((q, i) =>
                    questions.length > 1
                      ? `${q.question} ${picked[i]?.join(", ")}`
                      : (picked[i]?.join(", ") ?? ""),
                  )
                  .join("\n"),
              )
            }
          >
            Répondre
          </button>
        </div>
      )}
      {open && <div className="ask-hint">Tu peux aussi répondre en écrivant un message.</div>}
    </div>
  );
}

function ToolRow({ item, live }: { item: Extract<Item, { kind: "tool" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const hasBody = item.content.length > 0;
  return (
    <div className={`tool${open ? " open" : ""}`}>
      <button
        className="tool-h"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
      >
        <ToolStatusIcon status={item.status === "in_progress" && !live ? "pending" : item.status} />
        <span className="nm">{item.title}</span>
        <span className="meta">{TOOL_KIND[item.toolKind] ?? ""}</span>
        {hasBody && <IconChevron />}
      </button>
      {open && (
        <div className="tool-body">
          {item.content.map((c, i) => (
            <ToolBody key={i} content={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolStatusIcon({ status }: { status: string }) {
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
  if (status === "in_progress") return <span className="spin" />;
  return <span className="pend-ic" />;
}

function ToolBody({ content }: { content: ToolContent }) {
  if (content.type === "text") return <pre>{content.text}</pre>;
  const lines = [
    ...(content.oldText ?? "")
      .split("\n")
      .filter((l, i, all) => l || i < all.length - 1)
      .map((l) => ({ t: "del", l })),
    ...content.newText.split("\n").map((l) => ({ t: "add", l })),
  ];
  return (
    <div className="diff">
      <div className="diff-h">{content.path}</div>
      <div className="diff-b">
        {lines.map((line, i) => (
          <div key={i} className={line.t}>
            {line.t === "add" ? "+ " : "- "}
            {line.l}
          </div>
        ))}
      </div>
    </div>
  );
}

function PermissionCard({
  item,
  threadId,
}: {
  item: Extract<Item, { kind: "permission" }>;
  threadId: string;
}) {
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
      <div className="row">
        {item.options.map((o) => (
          <button
            key={o.optionId}
            className={`btn sm${o.kind.startsWith("allow") ? (o.kind === "allow_once" ? " pri" : "") : " quiet"}`}
            onClick={() =>
              connection.send({
                type: "permission.respond",
                threadId,
                itemId: item.id,
                optionId: o.optionId,
              })
            }
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}
