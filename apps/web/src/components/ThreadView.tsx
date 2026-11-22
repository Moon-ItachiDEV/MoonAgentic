import type { AgentInfo, Item, Thread, ToolContent } from "@moonagentic/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { messageTokens } from "../commands.ts";
import { fillComposer } from "../composer-fill.ts";
import { connection, newId } from "../connection.ts";
import { hasFocus, onFocusRequest, takeFocus } from "../focus.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconAlert, IconCheck, IconChevron, IconUndo, IconX } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";

export function ThreadView({
  thread,
  items,
  agents,
}: {
  thread: Thread;
  items: Item[] | undefined;
  agents: AgentInfo[];
}) {
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
  }, [thread.id]);
  // A thread opens at its end, unless it opens on a message picked in the quick search.
  // Set before the effects below, so the timeline sent back on opening keeps that message.
  useLayoutEffect(() => {
    pinned.current = !hasFocus(thread.id);
  }, [thread.id]);

  // A message picked in the quick search is shown once the timeline is here.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => onFocusRequest(() => setFocusTick((n) => n + 1)), []);
  useLayoutEffect(() => {
    if (!items) return;
    const itemId = takeFocus(thread.id);
    const el =
      itemId && view.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
    if (!el) return;
    pinned.current = false;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    // Restarts the highlight when the same message is picked twice.
    void el.offsetWidth;
    el.classList.add("flash");
  }, [items, thread.id, focusTick]);

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
        {items?.map((item, i) => (
          <div key={item.id} className="item" data-item={item.id}>
            <FeedItem
              item={item}
              thread={thread}
              agents={agents}
              agent={agents.find((a) => a.id === authors[i])}
              showBy={startsAgentBlock(items, i)}
              openQuestion={openQuestion}
            />
          </div>
        ))}
        {thread.status === "running" && (
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
}: {
  item: Item;
  thread: Thread;
  agents: AgentInfo[];
  agent: AgentInfo | undefined;
  showBy: boolean;
  /** The question still waiting for an answer, if any. */
  openQuestion: string | undefined;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} thread={thread} />;
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
          <Markdown text={item.text} />
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
      // Once the turn is over, a tool the agent left unfinished is no longer at work.
      return (
        <ToolRow item={item} live={thread.status === "running" || thread.status === "waiting"} />
      );
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
  const send = (text: string) => connection.send({ type: "thread.send", threadId, text });
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
                    onClick={() => {
                      if (direct) return void send(option);
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
            disabled={!complete}
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
