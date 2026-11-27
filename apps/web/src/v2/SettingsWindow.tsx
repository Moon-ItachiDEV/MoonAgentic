import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { I } from "./I.tsx";
import { scrRoot, useScrFlag } from "./scr.ts";
import { Sheet } from "./Sheet.tsx";
import type { IconName } from "./sprite.ts";
import { useExit } from "./use-exit.ts";
import { useScreen } from "./use-screen.ts";

export type Section<T extends string> = { id: T; label: string; icon: IconName };

/** How long the window takes to leave: shorter than it took to come. */
const WINDOW_EXIT_MS = 180;

/**
 * Settings in sections, as the Claude app shows them: on an iPad or a computer a window with
 * its sections on the left, a pill sliding to the one open; on a phone a sheet with the
 * sections as pills along its top.
 */
export function SettingsWindow<T extends string>(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  sections: Section<T>[];
  section: T;
  onSection: (section: T) => void;
  /** A smaller window, for fewer settings (a conversation's). */
  small?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { roomy } = useScreen();
  if (!roomy) {
    return (
      <Sheet
        open={props.open}
        onClose={props.onClose}
        title={props.title}
        tall
        className={`ppm${props.className ? ` ${props.className}` : ""}`}
      >
        <div className="sbody">
          <Pills {...props} />
          <section className="ppsec2" key={props.section}>
            {props.children}
          </section>
        </div>
      </Sheet>
    );
  }
  return <Window {...props} />;
}

function Pills<T extends string>(props: {
  sections: Section<T>[];
  section: T;
  onSection: (section: T) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  // The section open stays in sight when the pills scroll.
  useEffect(() => {
    bar.current
      ?.querySelector<HTMLElement>("[aria-current=true]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.section]);
  return (
    <div className="ppseg" ref={bar} role="tablist">
      {props.sections.map((s) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={s.id === props.section}
          aria-current={s.id === props.section}
          onClick={() => props.onSection(s.id)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function Window<T extends string>(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  sections: Section<T>[];
  section: T;
  onSection: (section: T) => void;
  small?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { open, onClose } = props;
  const { mounted, leaving } = useExit(open, WINDOW_EXIT_MS);
  // One frame at rest, then it comes in.
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useScrFlag("sh", open);
  useEffect(() => {
    if (!open) return setShown(false);
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  // The latest `onClose`, so a new one at each pass of the page neither moves the focus back
  // to the window nor listens again.
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    box.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A sheet or a menu over it leaves first.
      if (scrRoot().querySelector(".sheet.on, .ddm:not(.out)")) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  // The pill under the open section slides to it; it does not slide in when the window opens.
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ y: number; slide: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!mounted) return setPill(null);
    const at = nav.current?.querySelector<HTMLElement>("[aria-current=true]");
    if (at) setPill((was) => ({ y: at.offsetTop, slide: was !== null }));
  }, [props.section, mounted]);
  // Only the first look at a section, each time the window opens, brings its lines in.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!open) seen.current.clear();
  }, [open]);

  if (!mounted) return null;
  return createPortal(
    <div className={`ppo${shown && !leaving ? " on" : ""}${leaving ? " out" : ""}`}>
      <div className="ppsc" onClick={onClose} aria-hidden />
      <div
        ref={box}
        className={`ppw${props.small ? " sm" : ""}${props.className ? ` ${props.className}` : ""}`}
        role="dialog"
        aria-modal
        aria-label={props.title}
        tabIndex={-1}
        inert={!open}
      >
        <div className="pph">
          <h3>{props.title}</h3>
          <button type="button" className="pib" aria-label="Fermer" onClick={onClose}>
            <I n="x" s={16} />
          </button>
        </div>
        <div className="ppb">
          <nav className="ppn" ref={nav} aria-label="Sections">
            {pill && (
              <span
                className={`pppill${pill.slide ? " sl" : ""}`}
                style={{ transform: `translateY(${pill.y}px)` }}
                aria-hidden
              />
            )}
            {props.sections.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-current={s.id === props.section}
                onClick={() => props.onSection(s.id)}
              >
                <I n={s.icon} s={16} />
                {s.label}
              </button>
            ))}
          </nav>
          <div className="ppc">
            <Body key={props.section} id={props.section} seen={seen.current}>
              {props.children}
            </Body>
          </div>
        </div>
      </div>
    </div>,
    scrRoot(),
  );
}

/** A section's lines: they come in one after the other the first time it is shown. */
function Body(props: { id: string; seen: Set<string>; children: ReactNode }) {
  const [first] = useState(() => !props.seen.has(props.id));
  useEffect(() => {
    props.seen.add(props.id);
  }, [props.seen, props.id]);
  return <section className={first ? undefined : "still"}>{props.children}</section>;
}
