import type { AgentInfo, Item, Thread, ToolContent } from "@moonagentic/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconAlert, IconCheck, IconChevron, IconX } from "./icons.tsx";
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

  // Subscribes this client to the thread's timeline on the server.
  useEffect(() => {
    connection.send({ type: "thread.open", threadId: thread.id });
    pinned.current = true;
  }, [thread.id]);

  // Keep following new output while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = view.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, thread.status]);

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
          <FeedItem
            key={item.id}
            item={item}
            thread={thread}
            agent={agent}
            showBy={startsAgentBlock(items, i)}
          />
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
    .find((i) => i.kind === "agent" || i.kind === "user")
    ?.kind.startsWith("agent");

function FeedItem({
  item,
  thread,
  agent,
  showBy,
}: {
  item: Item;
  thread: Thread;
  agent: AgentInfo | undefined;
  showBy: boolean;
}) {
  switch (item.kind) {
    case "user":
      return <div className="u">{item.text}</div>;
    case "agent":
      return (
        <div className="a">
          {showBy && (
            <div className="by">
              <AgentBadge agent={agent} small />
              {agent?.name ?? thread.agentId}
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
      return <ToolRow item={item} />;
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

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const hasBody = item.content.length > 0;
  return (
    <div className={`tool${open ? " open" : ""}`}>
      <button
        className="tool-h"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
      >
        <ToolStatusIcon status={item.status} />
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
