import type { QueuedMessage, Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { queueState } from "../queue.ts";
import { IconArrowUp, IconClose } from "./icons.tsx";

/** Sends a change to the server; a refusal is shown rather than lost. */
const call = (message: Parameters<typeof connection.request>[0]) =>
  connection
    .request(message)
    .catch((error: unknown) =>
      connection.notify(error instanceof Error ? error.message : String(error)),
    );

/**
 * The messages written for after the turn under way, above the composer's field. Each can be
 * changed, taken out, or sent now while it waits. What is shown is what the server holds.
 */
export function MessageQueue({ thread }: { thread: Thread }) {
  const state = queueState(thread);
  if (state.count === 0) return null;
  return (
    <section className="cqueue" aria-label="Messages en file">
      <p className="cq-h" role="status">
        {state.label}
      </p>
      {(thread.queue ?? []).map((message, index) => (
        <Queued
          key={message.id}
          threadId={thread.id}
          message={message}
          place={index + 1}
          paused={state.paused}
        />
      ))}
    </section>
  );
}

function Queued({
  threadId,
  message,
  place,
  paused,
}: {
  threadId: string;
  message: QueuedMessage;
  place: number;
  paused: boolean;
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
    <div className="qm">
      {message.from === "coordinator" && <span className="l">Coordinateur</span>}
      {draft === null ? (
        <button
          className="t"
          title="Modifier ce message"
          aria-label={`Modifier le message ${place}${
            message.from === "coordinator" ? " du coordinateur" : ""
          } : ${message.text}`}
          onClick={() => setDraft(message.text)}
        >
          {message.text}
        </button>
      ) : (
        <textarea
          ref={field}
          className="cq-edit"
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
      {place === 1 && draft === null && (
        // While the agent works, sending now stops its turn first; after a stop or an error
        // nothing goes by itself, and this is how the messages go on.
        <button
          title={paused ? "Envoie ce message à l'agent" : "Arrête l'agent et envoie ce message"}
          onClick={() =>
            void call({
              type: "thread.queueSend",
              requestId: newId(),
              threadId,
              id: message.id,
            })
          }
        >
          <IconArrowUp size={13} />
          {paused ? "Envoyer" : "Envoyer maintenant"}
        </button>
      )}
      <button
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
    </div>
  );
}
