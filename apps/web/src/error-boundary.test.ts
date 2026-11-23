import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFailed, ErrorBoundary } from "./components/ErrorBoundary.tsx";

function findButton(
  node: ReactNode,
  label: string,
): ReactElement<{ onClick?: () => void }> | undefined {
  if (!isValidElement(node)) return undefined;
  const props = node.props as { children?: ReactNode; onClick?: () => void };
  if (node.type === "button" && props.children === label) {
    return node as ReactElement<{ onClick?: () => void }>;
  }
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, null, createElement("p", null, "Contenu OK")),
    );
    expect(html).toContain("Contenu OK");
  });

  it("turns thrown errors and non-error values into Error state", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("boom")).error?.message).toBe("boom");
    const nonError = ErrorBoundary.getDerivedStateFromError("échec brut").error;
    expect(nonError).toBeInstanceOf(Error);
    expect(nonError?.message).toBe("échec brut");
  });

  it("renders a Recharger button in error state that reloads the page by default", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const boundary = new ErrorBoundary({ children: createElement("div", null, "OK") });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error("Chargement impossible"));

    const tree = boundary.render();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Impossible d&#x27;afficher cet écran.");
    expect(html).toContain("Chargement impossible");
    expect(html).toContain("Recharger");

    const button = findButton(tree, "Recharger");
    expect(button).toBeDefined();
    button?.props.onClick?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("resets error state and calls onReload when provided", () => {
    const onReload = vi.fn();
    const boundary = new ErrorBoundary({
      children: createElement("div", null, "OK"),
      onReload,
    });
    const setStateSpy = vi.spyOn(boundary, "setState").mockImplementation(() => undefined);
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error("Chunk manquant"));

    const tree = boundary.render();
    const button = findButton(tree, "Recharger");
    button?.props.onClick?.();

    expect(setStateSpy).toHaveBeenCalledWith({ error: null });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("logs the error and component stack in componentDidCatch", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boundary = new ErrorBoundary({ children: null });
    const err = new Error("crash");

    boundary.componentDidCatch(err, { componentStack: "\n  in Planner" });

    expect(errorSpy).toHaveBeenCalledWith("Erreur d'affichage :", err, "\n  in Planner");
  });

  it("forgets the error when what it shows changes, such as another thread", () => {
    const boundary = new ErrorBoundary({ children: null, resetKey: "fil-2" });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error("Fil illisible"));
    const setState = vi.spyOn(boundary, "setState").mockImplementation(() => undefined);
    // The same thread drawn again: the error stays, rather than be thrown in a loop.
    boundary.componentDidUpdate({ children: null, resetKey: "fil-2" });
    expect(setState).not.toHaveBeenCalled();
    // It came from another thread: this one gets its chance.
    boundary.componentDidUpdate({ children: null, resetKey: "fil-1" });
    expect(setState).toHaveBeenCalledWith({ error: null });
    // Nothing to forget when all is well.
    setState.mockClear();
    boundary.state = { error: null };
    boundary.componentDidUpdate({ children: null, resetKey: "fil-0" });
    expect(setState).not.toHaveBeenCalled();
  });

  it("leaves a page at the root rather than a white screen, with a way back", () => {
    const reload = vi.fn();
    const tree = AppFailed({ error: new Error("l is not a function"), reload });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('role="alert"');
    expect(html).toContain("MoonAgentic n&#x27;a pas pu s&#x27;afficher");
    expect(html).toContain("Tes agents continuent sur le serveur");
    expect(html).toContain("l is not a function");
    findButton(tree, "Recharger")?.props.onClick?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("supports a custom fallback with a working reload callback", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const boundary = new ErrorBoundary({
      children: null,
      fallback: (err, onRetry) =>
        createElement(
          "div",
          null,
          createElement("span", null, `Erreur : ${err.message}`),
          createElement("button", { type: "button", onClick: onRetry }, "Recharger"),
        ),
    });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error("Réglages cassés"));

    const tree = boundary.render();
    expect(renderToStaticMarkup(tree)).toContain("Erreur : Réglages cassés");
    findButton(tree, "Recharger")?.props.onClick?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
