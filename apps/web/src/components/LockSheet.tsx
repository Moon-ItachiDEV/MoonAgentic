// The sheet that asks for the /lock code: six digits typed on the keyboard, or on the pad
// shown on touch screens. The server checks it; nothing of it is kept on this device.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import "../lock.css";
import { connection, newId } from "../connection.ts";
import { type Asked, type LockAsk, fullPin, lockSheet } from "../lock.ts";
import { IconLock } from "./icons.tsx";

type Step = "current" | "new" | "confirm" | "code";

const firstStep = (ask: LockAsk): Step =>
  ask.kind === "unlock" ? "code" : ask.kind === "change" ? "current" : "new";

const TITLES: Record<Step, string> = {
  current: "Saisis ton code actuel",
  new: "Choisis ton code",
  confirm: "Confirme ton code",
  code: "",
};

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shown over everything while a code is asked for. */
export function LockSheet() {
  const asked = useSyncExternalStore(lockSheet.subscribe, lockSheet.get);
  const pairedDevice = useSyncExternalStore(connection.subscribe, connection.getState).pairedDevice;
  // A new ask starts afresh, even over one left open.
  if (!asked) return null;
  if (pairedDevice && (asked.ask.kind === "set" || asked.ask.kind === "change")) {
    return <ComputerOnlySheet seq={asked.seq} />;
  }
  return <Sheet key={asked.seq} asked={asked} />;
}

/** Shown on a paired phone when no PIN exists yet (or change was triggered): computer only. */
function ComputerOnlySheet({ seq }: { seq: number }) {
  const close = () => lockSheet.close(seq);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      lockSheet.close(seq);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [seq]);
  return (
    <div
      className="lk-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="lk-card"
        role="dialog"
        aria-modal="true"
        aria-label="À faire depuis l'ordinateur"
        tabIndex={-1}
      >
        <span className="lk-ic">
          <IconLock size={20} />
        </span>
        <b className="lk-ttl">À faire depuis l'ordinateur</b>
        <span className="lk-sub">
          Pour définir ou modifier le code de verrouillage, va sur l'ordinateur où tourne
          MoonAgentic.
        </span>
        <button type="button" className="btn sm" onClick={close}>
          Fermer
        </button>
      </div>
    </div>
  );
}

function Sheet({ asked }: { asked: Asked }) {
  const ask: LockAsk = asked.ask;
  const [step, setStep] = useState<Step>(firstStep(ask));
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"" | "busy" | "ok" | "bad">("");
  const [message, setMessage] = useState<string | null>(null);
  const kept = useRef<{ current?: string; first?: string }>({});
  const card = useRef<HTMLDivElement>(null);
  /** The pauses under way, stopped if the sheet goes first. */
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** What follows a code the server took, still to run if the sheet goes before its pause ends. */
  const pending = useRef<(() => void) | undefined>(undefined);
  const alive = useRef(true);
  const later = (run: () => void, ms: number) => {
    if (!alive.current) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  };
  useEffect(
    () => () => {
      alive.current = false;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
      const after = pending.current;
      pending.current = undefined;
      after?.();
    },
    [],
  );

  const hint =
    step === "confirm"
      ? "Saisis-le une seconde fois"
      : step === "new"
        ? "Six chiffres, que toi seul connais"
        : "Saisis ton code à 6 chiffres";
  const title =
    step === "code" && ask.kind === "unlock" ? `${ask.name} est verrouillé` : TITLES[step];
  const sub =
    step === "code"
      ? "Les agents continuent de travailler. Le contenu reste masqué tant que le code n'est pas saisi."
      : step === "current"
        ? "Pour le remplacer par un nouveau."
        : "Il servira à rouvrir les projets que tu verrouilles, sur tous tes appareils. Tu peux le changer dans Réglages › Général.";

  const close = () => lockSheet.close(asked.seq);

  /** Wrong: says why, then lets it be typed again from `back`. */
  const refuse = (why: string, back: Step) => {
    setState("bad");
    setMessage(why);
    later(() => {
      setTyped("");
      setStep(back);
      setState("");
      setMessage(null);
    }, 750);
  };
  /** Right: the slots turn green, then the sheet goes and what follows runs. */
  const accept = (said: string, after?: () => void) => {
    setState("ok");
    setMessage(said);
    try {
      navigator.vibrate?.(12);
    } catch {
      // Not every browser lets a page vibrate.
    }
    // The server took it: what follows runs even if another sheet replaces this one first.
    if (!alive.current) return after?.();
    pending.current = after;
    later(() => {
      pending.current = undefined;
      close();
      after?.();
    }, 900);
  };

  const done = (pin: string) => {
    if (step === "current") {
      kept.current.current = pin;
      setTyped("");
      setStep("new");
      return;
    }
    if (step === "new") {
      kept.current.first = pin;
      // The last digit is seen before the slots empty for the second time.
      setState("busy");
      later(() => {
        setTyped("");
        setStep("confirm");
        setState("");
      }, 260);
      return;
    }
    setState("busy");
    if (step === "confirm") {
      if (pin !== kept.current.first) {
        refuse("Les deux codes sont différents", "new");
        return;
      }
      const current = kept.current.current;
      connection
        .request({
          type: "lock.setPin",
          requestId: newId(),
          pin,
          ...(current ? { current } : {}),
        })
        .then(
          () => accept("Code enregistré", ask.kind === "set" ? ask.after : undefined),
          (e: unknown) => refuse(reason(e), ask.kind === "change" ? "current" : "new"),
        );
      return;
    }
    if (ask.kind !== "unlock") return;
    connection
      .request({ type: "lock.unlock", requestId: newId(), projectId: ask.projectId, pin })
      .then(
        () => accept("Déverrouillé", ask.after),
        (e: unknown) => refuse(reason(e), "code"),
      );
  };

  const press = (key: string) => {
    if (state) return;
    if (key === "x") return close();
    if (key === "⌫") return setTyped((t) => t.slice(0, -1));
    if (!/^\d$/.test(key) || typed.length >= 6) return;
    const next = typed + key;
    setTyped(next);
    if (fullPin(next)) done(next);
  };
  // The latest `press`, for the keyboard listener set once.
  const pressRef = useRef(press);
  pressRef.current = press;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key === "Escape" ? "x" : event.key === "Backspace" ? "⌫" : event.key;
      if (key !== "x" && key !== "⌫" && !/^\d$/.test(key)) return;
      event.preventDefault();
      event.stopPropagation();
      pressRef.current(key);
    };
    document.addEventListener("keydown", onKey, true);
    card.current?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className="lk-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget && !state) close();
      }}
    >
      <div
        ref={card}
        className={`lk-card${state === "ok" || state === "bad" ? ` ${state}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <span className="lk-ic">
          <IconLock size={20} />
        </span>
        <b className="lk-ttl">{title}</b>
        <span className="lk-sub">{sub}</span>
        <div className="lk-slots" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="lk-slot-wrap">
              {i === 3 && <em />}
              <i
                className={`${i === typed.length && !state ? "cur" : ""}${typed[i] ? " full" : ""}`}
                style={state === "ok" ? { animationDelay: `${i * 70}ms` } : undefined}
              >
                {typed[i] ? "•" : ""}
              </i>
            </span>
          ))}
        </div>
        <span className="lk-msg" role="status" aria-live="polite">
          {message ?? `${hint}${typed.length ? ` · ${typed.length}/6` : ""}`}
        </span>
        <div className="lk-pad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k, i) =>
            k ? (
              <button
                key={k}
                type="button"
                aria-label={k === "⌫" ? "Effacer" : k}
                onClick={() => press(k)}
              >
                {k}
              </button>
            ) : (
              <span key={`gap${i}`} />
            ),
          )}
        </div>
        <button type="button" className="btn sm quiet" onClick={close} disabled={!!state}>
          Annuler
        </button>
      </div>
    </div>
  );
}
