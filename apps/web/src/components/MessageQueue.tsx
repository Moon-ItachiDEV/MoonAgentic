import type { QueuedMessage, Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { queueState } from "../queue.ts";
import { I } from "../v2/I.tsx";

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
    <section className="cq" aria-label="Messages en file">
      <div className="cqh">
        <span className="ppill" role="status">
          <I n="clock" s={13} />
          {state.label}
        </span>
      </div>
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
  const send = () =>
    void call({ type: "thread.queueSend", requestId: newId(), threadId, id: message.id });
  const remove = () => {
    setDraft(null);
    void call({
      type: "thread.queueEdit",
      requestId: newId(),
      threadId,
      id: message.id,
      text: "",
    });
  };
  if (draft !== null) {
    return (
      <div className="cqm ed">
        <textarea
          ref={field}
          className="cqe"
          autoFocus
          rows={2}
          aria-label={`Message ${place} en file`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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
        <div className="cqa">
          <button className="cqx press" onClick={() => setDraft(null)}>
            Annuler
          </button>
          <button className="cqx ink press" onClick={save}>
            Enregistrer
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="cqm">
      <span className="cqn">{place}</span>
      <button
        className="cqt"
        title="Modifier ce message"
        aria-label={`Modifier le message ${place}${
          message.from === "coordinator"
            ? " du coordinateur"
            : message.from === "hermes"
              ? " venu de Discord"
              : ""
        } : ${message.text}`}
        onClick={() => setDraft(message.text)}
      >
        {message.from === "coordinator" && <small>Coordinateur</small>}
        {message.from === "hermes" && <small>Hermes · Discord</small>}
        {message.text}
      </button>
      <button className="cqb press" aria-label="Modifier" onClick={() => setDraft(message.text)}>
        <I n="edit" s={16} />
      </button>
      <button
        className="cqb press"
        aria-label={`Retirer le message ${place} de la file`}
        title="Retirer de la file"
        onClick={remove}
      >
        <I n="x" s={15} />
      </button>
      {place === 1 && (
        // While the agent works, sending now stops its turn first; after a stop or an error
        // nothing goes by itself, and this is how the messages go on.
        <button
          className="cqb ink press"
          aria-label={paused ? "Envoyer" : "Envoyer maintenant"}
          title={paused ? "Envoie ce message à l'agent" : "Arrête l'agent et envoie ce message"}
          onClick={send}
        >
          <I n="up" s={15} />
        </button>
      )}
    </div>
  );
}
