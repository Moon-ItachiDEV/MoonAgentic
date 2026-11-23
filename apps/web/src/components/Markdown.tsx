import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { prStates } from "../pr-states.ts";
import { pullRequestUrl } from "../pull-request.ts";

/** Renders agent Markdown; links open outside the app. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), {
    // An answer is text to read: nothing in it should look like part of the app or submit anything.
    FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style"],
    // Nor should it place itself over the app, which a style of its own would allow.
    FORBID_ATTR: ["style"],
  });
  const root = useRef<HTMLDivElement>(null);
  const states = useSyncExternalStore(prStates.subscribe, prStates.version);
  // Links to pull requests take the color of their state on GitHub, once it is known.
  useLayoutEffect(() => {
    for (const link of root.current?.querySelectorAll<HTMLElement>("a.prchip[data-pr]") ?? []) {
      const state = prStates.get(link.dataset.pr ?? "");
      if (state) link.dataset.state = state;
      else delete link.dataset.state;
    }
  }, [html, states]);
  useLayoutEffect(() => {
    const links = root.current?.querySelectorAll<HTMLElement>("a.prchip[data-pr]") ?? [];
    return prStates.show([...new Set(Array.from(links, (link) => link.dataset.pr ?? ""))]);
  }, [html]);
  return <div ref={root} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
    // A link to a pull request is drawn as GitHub draws it: its icon, then its number.
    const pr = pullRequestUrl(node.getAttribute("href") ?? "");
    node.classList.remove("prchip");
    node.removeAttribute("data-pr");
    node.removeAttribute("data-state");
    if (pr) {
      node.classList.add("prchip");
      node.setAttribute("data-pr", pr.url);
      // A bare address is long and says less than the number it ends with.
      if (node.textContent?.trim() === node.getAttribute("href"))
        node.textContent = `#${pr.number}`;
    }
  }
});
