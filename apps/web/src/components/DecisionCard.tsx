import type { AgentInfo, QuestionAnswer, Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection } from "../connection.ts";
import {
  answerText,
  cardKey,
  type Choice,
  permissionChoices,
  questionChoices,
  refusal,
  type Wait,
} from "../decision.ts";
import { I } from "../v2/I.tsx";

const PREV = <I n="left" s={16} />;
const NEXT = <I n="right" s={16} />;
const ENTER = <I n="up" s={16} />;
const OPEN = <I n="up" s={16} />;
const CHECK = <I n="check" s={14} />;

// Too narrow for preview tiles side by side: one preview, of the row picked.
const NARROW = "(max-width: 640px)";
const narrowQuery = typeof matchMedia === "function" ? matchMedia(NARROW) : undefined;
const useNarrow = () =>
  useSyncExternalStore(
    (changed) => {
      narrowQuery?.addEventListener("change", changed);
      return () => narrowQuery?.removeEventListener("change", changed);
    },
    () => narrowQuery?.matches ?? false,
  );

/** Where the user is in one wait: the row lit, and the answers given so far. */
interface Progress {
  id: string;
  hi: number;
  /** The question being asked, of a wait that asks several. */
  step: number;
  answers: QuestionAnswer[];
  /** A question taking several options: those ticked so far. */
  picked: string[];
  editing: boolean;
  other: string;
}
/** How long a request is too new for a key pressed outside the card to answer it. */
const FRESH = 800;

const fresh = (id: string): Progress => ({
  id,
  hi: 0,
  step: 0,
  answers: [],
  picked: [],
  editing: false,
  other: "",
});

/**
 * What agents wait on the user for, just above the composer: a permission request or a
 * question at a time, with a pager when several wait. Rows are picked with a click, with
 * 1–9, or with the arrows and Enter; « Plus tard » folds the card to one line.
 * It knows nothing of the composer: it only sits above it.
 */
export function DecisionCard(props: {
  waits: Wait[];
  /** The thread on screen: its own waits need no way to open it. */
  threadId: string;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (threadId: string, itemId: string) => void;
}) {
  // Answered here, a wait leaves at once, before the server says so: no second answer.
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const waits = props.waits.filter((w) => !sent.has(w.id));
  const [current, setCurrent] = useState<string>();
  // « Plus tard » folds the requests that wait now: one that comes after opens the card again.
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const folded = waits.length > 0 && waits.every((w) => later.has(w.id));
  const setFolded = (on: boolean) => setLater(new Set(on ? waits.map((w) => w.id) : []));
  const [progress, setProgress] = useState<Progress>(fresh(""));
  const narrow = useNarrow();
  const card = useRef<HTMLElement>(null);
  const own = useRef<HTMLInputElement>(null);
  /** When the request on the card came up: a key already on its way is not an answer to it. */
  const since = useRef({ id: "", at: 0 });

  const page = Math.max(
    0,
    waits.findIndex((w) => w.id === current),
  );
  const wait = waits[page];
  const p = wait && progress.id === wait.id ? progress : fresh(wait?.id ?? "");
  const set = (change: Partial<Progress>) => setProgress({ ...p, ...change });

  const question = wait?.kind === "question" ? wait.questions[p.step] : undefined;
  const choices: Choice[] = !wait
    ? []
    : wait.kind === "permission"
      ? permissionChoices(wait.options)
      : question
        ? questionChoices(question)
        : [];
  // A permission is answered in the user's own words by refusing it, then saying why.
  const hasOwn = wait?.kind === "question" || (!!wait && !!refusal(wait.options));
  const rows = choices.length + (hasOwn ? 1 : 0);
  const multi = !!question?.multi;
  const previews = choices.some((c) => c.preview);
  const layout = !previews ? "rows" : narrow || choices.length > 4 ? "detail" : "tiles";

  const done = (id: string) => setSent((s) => new Set(s).add(id));

  /** Sends the whole answer of a question: every step's picks and words. */
  const answer = (w: Extract<Wait, { kind: "question" }>, answers: QuestionAnswer[]) => {
    const ok =
      w.via === "form"
        ? connection.send({ type: "question.respond", threadId: w.threadId, itemId: w.id, answers })
        : connection.send({
            type: "thread.send",
            threadId: w.threadId,
            text: answerText(w.questions, answers),
          });
    if (ok) done(w.id);
  };

  /** One question answered: the next one of the same wait, or the answer goes out. */
  const commit = (given: QuestionAnswer) => {
    if (wait?.kind !== "question") return;
    const answers = [...p.answers, given];
    if (p.step + 1 < wait.questions.length) {
      setProgress({ ...fresh(wait.id), step: p.step + 1, answers });
    } else answer(wait, answers);
  };

  const pick = (index: number) => {
    if (!wait) return;
    const choice = choices[index];
    if (!choice) {
      if (index === choices.length && hasOwn) set({ hi: index, editing: true });
      return;
    }
    if (wait.kind === "permission") {
      const ok = connection.send({
        type: "permission.respond",
        threadId: wait.threadId,
        itemId: wait.id,
        optionId: choice.value,
      });
      if (ok) done(wait.id);
    } else if (multi) {
      const on = p.picked.includes(choice.value);
      set({
        hi: index,
        picked: on ? p.picked.filter((v) => v !== choice.value) : [...p.picked, choice.value],
      });
    } else commit({ picks: [choice.value] });
  };

  /** The user's own words: an answer of their own, or why a permission is refused. */
  const sayOwn = () => {
    const text = p.other.trim();
    if (!wait || !text) return;
    if (wait.kind === "question") return commit({ picks: multi ? p.picked : [], text });
    const no = refusal(wait.options);
    if (!no) return;
    // The agent is still in its turn when it is refused: the server sends the words once
    // that turn is over.
    const ok = connection.send({
      type: "permission.respond",
      threadId: wait.threadId,
      itemId: wait.id,
      optionId: no.optionId,
      followUp: text,
    });
    if (ok) done(wait.id);
  };

  const confirm = () => {
    if (p.hi === choices.length && hasOwn) return set({ editing: true });
    if (multi && p.picked.length) return commit({ picks: p.picked });
    pick(p.hi);
  };

  const turn = (by: number) => {
    const next = waits[(page + by + waits.length) % waits.length];
    if (next) setCurrent(next.id);
  };

  useEffect(() => {
    if (p.editing) own.current?.focus();
  }, [p.editing, p.id, p.step]);
  const waitId = wait?.id ?? "";
  useEffect(() => {
    since.current = { id: waitId, at: Date.now() };
  }, [waitId]);

  // Keys act from the card, from the empty composer, or with nothing focused: never while
  // the user types, nor from a menu or a dialog that has its own keys. From outside the
  // card a key may be the first of a message, so it never answers a permission from the
  // composer, a request of another thread, or one that has only just come up.
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    if (!wait || folded || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const inside = !!target && !!card.current?.contains(target);
    if (!inside) {
      if (document.querySelector(".scrim, [aria-modal]")) return;
      // Two conversations side by side: only the first card listens from outside itself.
      if (document.querySelector(".dc") !== card.current) return;
      const typing = target instanceof HTMLTextAreaElement && target.value === "";
      if (!typing && target !== document.body && target !== null) return;
      if (wait.threadId !== props.threadId) return;
      if (typing && wait.kind === "permission") return;
      if (since.current.id !== wait.id || Date.now() - since.current.at < FRESH) return;
    } else if (target === own.current) return;
    const action = cardKey(event.key, Math.min(rows, 9), waits.length);
    if (!action) return;
    // Enter and the arrows on one of the card's own buttons do what that button does.
    if (inside && target instanceof HTMLButtonElement && action.do === "confirm") return;
    event.preventDefault();
    event.stopPropagation();
    if (action.do === "pick") pick(action.index);
    else if (action.do === "move") set({ hi: (p.hi + action.by + rows) % rows, editing: false });
    else if (action.do === "page") turn(action.by);
    else if (action.do === "confirm") confirm();
    else setFolded(true);
  };
  useEffect(() => {
    const listen = (event: KeyboardEvent) => keys.current(event);
    document.addEventListener("keydown", listen, true);
    return () => document.removeEventListener("keydown", listen, true);
  }, []);

  if (!wait) return null;

  const thread = props.threads.find((t) => t.id === wait.threadId);
  const elsewhere = wait.threadId !== props.threadId;
  const title =
    wait.kind === "permission" ? wait.title : (question?.question ?? wait.questions[0]?.question);
  const count = waits.length > 1 ? `${page + 1} sur ${waits.length}` : "";

  if (folded) {
    return (
      <button
        className="dcf press"
        aria-label={`Rouvrir la demande : ${title}`}
        // As on the open card: the focus stays in the composer, which would fold and move
        // this line from under the press.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setFolded(false)}
      >
        <span className="pill">À toi</span>
        <span className="q">{title}</span>
        {count && <span className="n">{count}</span>}
        {OPEN}
      </button>
    );
  }

  const steps = wait.kind === "question" && wait.questions.length > 1;
  const source = (
    <span>
      {elsewhere && (thread?.title ?? "Fil")}
      {steps && `${elsewhere ? " · " : ""}question ${p.step + 1} sur ${wait.questions.length}`}
    </span>
  );
  const cap = (index: number, on: boolean) => (
    <span className="k">{multi && on ? CHECK : index + 1}</span>
  );
  const name = (choice: Choice) => (
    <span className="on">
      {choice.label}
      {choice.recommended && <span className="rec">Recommandé</span>}
    </span>
  );
  const shown = choices[Math.min(p.hi, choices.length - 1)];

  return (
    <section
      className="dc"
      ref={card}
      aria-label={`Demande d'un agent : ${title}`}
      // A press on the card leaves the focus where it was: the composer folds when it loses
      // it, and the card would slide from under the finger before the press ends.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
      }}
    >
      <header className="hd">
        <span className="pill">À toi</span>
        {elsewhere ? (
          <button
            className="src"
            title="Ouvrir ce fil"
            onClick={() => props.onOpenThread(wait.threadId, wait.id)}
          >
            {source}
          </button>
        ) : (
          <span className="src">{source}</span>
        )}
        <span className="sp" />
        {count && (
          <span className="pg">
            <button className="ib press" aria-label="Demande précédente" onClick={() => turn(-1)}>
              {PREV}
            </button>
            <span aria-live="polite">{count}</span>
            <button className="ib press" aria-label="Demande suivante" onClick={() => turn(1)}>
              {NEXT}
            </button>
          </span>
        )}
        <button className="later press" onClick={() => setFolded(true)}>
          Plus tard
        </button>
      </header>
      <h3>{title}</h3>

      {layout === "tiles" && (
        <div className="tiles" style={{ ["--n" as string]: choices.length }}>
          {choices.map((choice, i) => {
            const on = p.picked.includes(choice.value);
            return (
              <button
                key={choice.value}
                className={`tile press${p.hi === i ? " hl" : ""}${on ? " on" : ""}`}
                aria-pressed={multi ? on : undefined}
                onClick={() => pick(i)}
              >
                <span className="pv">
                  {choice.preview && <pre>{choice.preview}</pre>}
                  {choice.recommended && <span className="rec">Recommandé</span>}
                </span>
                <span className="tn">
                  {cap(i, on)}
                  <span>{choice.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {layout === "detail" && (
        <div className="pane" aria-live="polite">
          {shown?.preview ? <pre>{shown.preview}</pre> : <span>Pas d'aperçu</span>}
        </div>
      )}

      <div className="rows">
        {layout !== "tiles" &&
          choices.map((choice, i) => {
            const on = p.picked.includes(choice.value);
            const lit = p.hi === i;
            return (
              <button
                key={choice.value}
                className={`opt press${lit ? " hl" : ""}${on ? " on" : ""}`}
                aria-pressed={multi ? on : undefined}
                // With one preview at a time, a first tap shows the row's, a second picks it.
                onClick={() =>
                  layout === "detail" && !lit ? set({ hi: i, editing: false }) : pick(i)
                }
                // A mouse shows the preview of the row it is over; a finger taps for it.
                onPointerEnter={(e) =>
                  e.pointerType === "mouse" && layout === "detail" && !lit && set({ hi: i })
                }
              >
                {cap(i, on)}
                <span className="ot">
                  {name(choice)}
                  {choice.description && <small>{choice.description}</small>}
                </span>
                {layout === "detail" && lit && !multi && <span className="pick">Choisir</span>}
              </button>
            );
          })}
        {hasOwn &&
          (p.editing ? (
            <form
              className={`opt other${p.hi === choices.length ? " hl" : ""}`}
              onSubmit={(e) => {
                e.preventDefault();
                sayOwn();
              }}
            >
              <span className="k">{choices.length + 1}</span>
              <input
                ref={own}
                value={p.other}
                aria-label="Ta réponse"
                placeholder={
                  wait.kind === "permission"
                    ? "Refuser, et dire quoi faire à la place…"
                    : "Écris ta réponse…"
                }
                onChange={(e) => set({ other: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  e.stopPropagation();
                  set({ editing: false, other: "" });
                }}
              />
              <button className="snd press" aria-label="Envoyer" disabled={!p.other.trim()}>
                {ENTER}
              </button>
            </form>
          ) : (
            <button
              className={`opt other press${p.hi === choices.length ? " hl" : ""}`}
              onClick={() => pick(choices.length)}
            >
              <span className="k">{choices.length + 1}</span>
              Autre chose…
            </button>
          ))}
      </div>
      {multi && (
        <div className="go">
          <span>Plusieurs choix</span>
          <button
            className="b2 ink press"
            disabled={!p.picked.length}
            onClick={() => commit({ picks: p.picked })}
          >
            Valider
          </button>
        </div>
      )}
    </section>
  );
}
