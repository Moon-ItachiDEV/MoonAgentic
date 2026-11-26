import type { Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { appLock, watchIdle } from "../app-lock.ts";
import { connection, newId } from "../connection.ts";
import { fullPin, lockSheet } from "../lock.ts";
import { I } from "../v2/I.tsx";

/** The six dots of a code being typed. */
export function PinDots({ count, state }: { count: number; state: "" | "busy" | "ok" | "bad" }) {
  return (
    <div
      className={`pin${state === "bad" ? " err" : state === "ok" ? " ok" : ""}`}
      role="img"
      aria-label={`${count} chiffres sur 6`}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i < count ? "full" : ""} />
      ))}
    </div>
  );
}

/** The pad a code is typed on; the keyboard's digits do the same. */
export function PinPad({ onKey, disabled }: { onKey: (key: string) => void; disabled?: boolean }) {
  return (
    <div className="kp">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k, i) =>
        k === "" ? (
          <span key={`gap${i}`} />
        ) : k === "⌫" ? (
          <button
            key={k}
            type="button"
            data-a="pin:del"
            aria-label="Effacer"
            disabled={disabled}
            onClick={() => onKey(k)}
          >
            <I n="back" s={22} />
          </button>
        ) : (
          <button key={k} type="button" disabled={disabled} onClick={() => onKey(k)}>
            {k}
          </button>
        ),
      )}
    </div>
  );
}

/** The longest a typed code waits for the connection before it is said not sent. */
const REACH_MS = 10_000;

/**
 * Resolves once the server can be asked, or after `REACH_MS`. A page loaded locked shows its
 * pad before it is connected: a code typed right then waits, instead of being refused as not
 * sent.
 */
function reached(): Promise<void> {
  return new Promise((resolve) => {
    const there = () => connection.getState().status === "open";
    if (there()) return resolve();
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = connection.subscribe(() => {
      if (there()) done();
    });
    const timer = setTimeout(done, REACH_MS);
  });
}

/** Locks the whole app on this device; a first code is asked for when none exists. */
export function lockApp(hasPin: boolean): void {
  if (hasPin) appLock.lock();
  else lockSheet.open({ kind: "set", after: () => appLock.lock() });
}

/**
 * The app locked as a whole: a layer over everything, with what the agents are doing meanwhile
 * and the pad for the code. Nothing under it can be reached, by hand or by keyboard.
 */
export function AppLock({
  threads,
  hasPin,
  ready,
}: {
  threads: Thread[];
  hasPin: boolean;
  /** The server said what it knows: only then is « no code » a fact. */
  ready: boolean;
}) {
  const locked = useSyncExternalStore(appLock.subscribe, appLock.locked);
  const layer = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"" | "busy" | "ok" | "bad">("");
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // Locks by itself after a while away, while a code exists to open it again.
  const pin = useRef(hasPin);
  pin.current = hasPin;
  useEffect(() => watchIdle(() => pin.current), []);

  // The code was cleared on the computer: nothing could open this screen again.
  useEffect(() => {
    if (locked && ready && !hasPin) appLock.unlock();
  }, [locked, ready, hasPin]);

  useEffect(() => {
    if (!locked) return;
    setTyped("");
    setState("");
    setMessage(null);
    setOpening(false);
    // What is under the layer cannot be reached while it is there.
    const root = layer.current?.parentElement;
    const under = [...(root?.children ?? [])].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== layer.current && !el.inert,
    );
    for (const el of under) el.inert = true;
    layer.current?.focus();
    return () => {
      for (const el of under) el.inert = false;
    };
  }, [locked]);

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all) clearTimeout(timer);
    };
  }, []);
  const later = (run: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  };

  const check = (code: string) => {
    setState("busy");
    reached()
      .then(() => connection.request({ type: "lock.check", requestId: newId(), pin: code }))
      .then(
        () => {
          setState("ok");
          try {
            navigator.vibrate?.(12);
          } catch {
            // Not every browser lets a page vibrate.
          }
          later(() => {
            setOpening(true);
            later(() => appLock.unlock(), 520);
          }, 900);
        },
        (e: unknown) => {
          const why = e instanceof Error ? e.message : String(e);
          setState("bad");
          // A wrong code shows on the dots; only another reason needs words.
          setMessage(/incorrect/i.test(why) ? null : why);
          later(() => {
            setTyped("");
            setState("");
          }, 650);
        },
      );
  };

  const press = (key: string) => {
    if (state) return;
    if (key === "⌫") return setTyped((t) => t.slice(0, -1));
    if (!/^\d$/.test(key) || typed.length >= 6) return;
    setMessage(null);
    const next = typed + key;
    setTyped(next);
    if (fullPin(next)) check(next);
  };
  const pressRef = useRef(press);
  pressRef.current = press;

  // Every key goes to the pad: none reaches the app's own shortcuts.
  useEffect(() => {
    if (!locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      const key = event.key === "Backspace" ? "⌫" : event.key;
      if (key !== "⌫" && !/^\d$/.test(key)) return;
      event.preventDefault();
      pressRef.current(key);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [locked]);

  const live = threads.filter((t) => !t.archived);
  const working = live.filter((t) => t.status === "running").length;
  const waiting = live.filter((t) => t.status === "waiting").length;

  return (
    <div
      ref={layer}
      className={`lockl${locked ? " on" : ""}${locked && opening ? " open" : ""}`}
      id="lockl"
      role={locked ? "dialog" : undefined}
      aria-modal={locked ? true : undefined}
      aria-label={locked ? "App verrouillée" : undefined}
      aria-hidden={!locked}
      tabIndex={-1}
    >
      {locked && (
        <div className="lkin">
          <div className="lkpill glass" role="status">
            <I n="lock" s={14} />
            Verrouillé
            {working > 0 && (
              <>
                <i />
                <b className="ld" />
                {working} au travail
              </>
            )}
            {waiting > 0 && (
              <>
                <i />
                <b className="wd" />
                {waiting} {waiting > 1 ? "t'attendent" : "t'attend"}
              </>
            )}
          </div>
          <div className="lkmid">
            <PinDots count={typed.length} state={state} />
            {message && (
              <span className="ppill lkmsg" role="alert">
                {message}
              </span>
            )}
          </div>
          <PinPad onKey={press} disabled={state === "ok"} />
        </div>
      )}
    </div>
  );
}
