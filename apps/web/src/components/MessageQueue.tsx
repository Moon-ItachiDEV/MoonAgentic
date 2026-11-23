import type { QueuedMessage, Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { queueState } from "../queue.ts";
import { IconClose } from "./icons.tsx";

/** Sends a change to the server; a refusal is shown rather than lost. */
const call = (message: Parameters<typeof connection.request>[0]) =>
  connection
    .request(message)
    .catch((error: unknown) =>
      connection.notify(error instanceof Error ? error.message : String(error)),
    );

/**
 * The messages the user wrote for after the turn under way, above the composer. Each can
 * be changed or taken out while it waits. What is shown is what the server holds.
 */
export function MessageQueue({ thread }: { thread: Thread }) {
  const state = queueState(thread);
  if (state.count === 0) return null;
  return (
    <section className="mq" aria-label="Messages en file">
      <div className="mq-h">
        <span role="status">{state.label}</span>
        {state.paused && (
          <button
            className="mq-go"
            onClick={() =>
              void call({ type: "thread.queueSend", requestId: newId(), threadId: thread.id })
            }
          >
            Envoyer
          </button>
        )}
      </div>
      <ol className="mq-list">
        {(thread.queue ?? []).map((message, index) => (
          <Queued key={message.id} threadId={thread.id} message={message} place={index + 1} />
        ))}
      </ol>
    </section>
  );
}

function Queued({
  threadId,
  message,
  place,
}: {
  threadId: string;
  message: QueuedMessage;
  place: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (draft === null) return;
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const save = () => {
    if (draft === null) return;
    // Emptied, it is taken out: the server reads an empty text that way.
    if (draft.trim() !== message.text) {
      void call({
        type: "thread.queueEdit",
        requestId: newId(),
        threadId,
        id: message.id,
        text: draft,
      });
    }
    setDraft(null);
  };
  return (
    <li className="mq-row">
      <span className="mq-n" aria-hidden>
        {place}
      </span>
      {draft === null ? (
        <button
          className="mq-tx"
          title="Modifier ce message"
          aria-label={`Modifier le message ${place}${
            message.from === "coordinator" ? " du coordinateur" : ""
          } : ${message.text}`}
          onClick={() => setDraft(message.text)}
        >
          {message.from === "coordinator" && <span className="mq-from">Coordinateur</span>}
          {message.text}
        </button>
      ) : (
        <textarea
          ref={field}
          className="mq-edit"
          autoFocus
          rows={1}
          aria-label={`Message ${place} en file`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      )}
      <button
        className="mq-x"
        aria-label={`Retirer le message ${place} de la file`}
        title="Retirer de la file"
        // Before the field's blur, which would save what is being typed.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setDraft(null);
          void call({
            type: "thread.queueEdit",
            requestId: newId(),
            threadId,
            id: message.id,
            text: "",
          });
        }}
      >
        <IconClose />
      </button>
    </li>
  );
}
