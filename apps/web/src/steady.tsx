// Keeps a part of the page still while another part changes many times a second.
import { type ComponentType, memo, useLayoutEffect, useRef } from "react";

/** True when two objects hold the very same values under the same names. */
export function sameFields(a: object, b: object): boolean {
  const namesA = Object.keys(a);
  if (namesA.length !== Object.keys(b).length) return false;
  const [fieldsA, fieldsB] = [a, b] as [Record<string, unknown>, Record<string, unknown>];
  return namesA.every((name) => Object.hasOwn(b, name) && Object.is(fieldsA[name], fieldsB[name]));
}

/** The object of the last pass while its fields are the same, so it can be told unchanged. */
export function useSame<T extends object>(value: T): T {
  const kept = useRef(value);
  if (!sameFields(kept.current, value)) kept.current = value;
  return kept.current;
}

type Handler = (...args: unknown[]) => unknown;
const isHandler = (name: string, value: unknown): value is Handler =>
  typeof value === "function" && /^on[A-Z]/.test(name);

/**
 * The component, drawn again only when what it shows changes. Its handlers (the `on…`
 * props that are functions) may be new at each pass of its parent without it noticing:
 * it always runs the latest one.
 */
export function steady<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  const Inner = memo(Component) as unknown as ComponentType<Record<string, unknown>>;
  function Steady(props: P) {
    const latest = useRef(props as Record<string, unknown>);
    useLayoutEffect(() => {
      latest.current = props as Record<string, unknown>;
    });
    const handlers = useRef<Record<string, Handler>>({});
    const passed: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(props)) {
      passed[name] = isHandler(name, value)
        ? (handlers.current[name] ??= (...args) => (latest.current[name] as Handler)?.(...args))
        : value;
    }
    return <Inner {...passed} />;
  }
  Steady.displayName = `Steady(${Component.displayName ?? Component.name})`;
  return Steady;
}
