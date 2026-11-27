// The sheet that asks for the /lock code: six digits typed on the keyboard, or on the pad
// shown on touch screens. The server checks it; nothing of it is kept on this device.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import { type Asked, type LockAsk, fullPin, lockSheet } from "../lock.ts";
import { Sheet as Layer } from "../v2/Sheet.tsx";
import { PinDots, PinPad } from "./AppLock.tsx";

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
  const pairedDevice = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().pairedDevice,
  );
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
  return (
    <Layer open onClose={close} label="À faire depuis l'ordinateur">
      <div className="cfw" role="alertdialog" aria-label="À faire depuis l'ordinateur">
        <div className="grab" />
        <h3>À faire depuis l'ordinateur</h3>
        <span className="ppill">Le code se crée et se change sur l'ordinateur</span>
        <div className="cfa">
          <button type="button" className="b2 soft press" autoFocus onClick={close}>
            Fermer
          </button>
        </div>
      </div>
    </Layer>
  );
}

function Sheet({ asked }: { asked: Asked }) {
  const ask: LockAsk = asked.ask;
  const [step, setStep] = useState<Step>(firstStep(ask));
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"" | "busy" | "ok" | "bad">("");
  const [message, setMessage] = useState<string | null>(null);
  const kept = useRef<{ current?: string; first?: string }>({});
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
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <Layer open onClose={() => !state && close()} label={title} modal={!!state} className="lksh">
      <div className="cfw lkw">
        <div className="grab" />
        <h3>{title}</h3>
        <PinDots count={typed.length} state={state} />
        <span
          className={`ppill${state === "bad" ? " t-err" : ""}`}
          role="status"
          aria-live="polite"
        >
          {message ?? hint}
        </span>
        <PinPad onKey={press} disabled={!!state} />
      </div>
    </Layer>
  );
}
