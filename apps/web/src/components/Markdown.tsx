import DOMPurify from "dompurify";
import { Marked } from "marked";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { fileLink, knownLink, localFiles, markedRef, refName } from "../local-files.ts";
import { prStates } from "../pr-states.ts";
import { pullRequestUrl } from "../pull-request.ts";
import { FileViewer } from "./FileViewer.tsx";

const marked = new Marked(localFiles);

/**
 * Renders agent Markdown; links open outside the app. The files of the computer it names,
 * such as an image it generated, are shown from the server when `threadId` is given.
 */
export const Markdown = memo(function Markdown({
  text,
  threadId,
}: {
  text: string;
  threadId?: string;
}) {
  // Worked out once per text: a pull request's state, when it comes, redraws every answer
  // on the page, and none of them should be parsed and cleaned again for that.
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), {
        // An answer is text to read: nothing in it should look like part of the app or submit anything.
        FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style"],
        // Nor should it place itself over the app, which a style of its own would allow.
        FORBID_ATTR: ["style"],
      }),
    [text],
  );
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
  // The images of the computer it names: each is asked for, then shown from its address.
  useLayoutEffect(() => {
    let current = true;
    for (const img of root.current?.querySelectorAll<HTMLImageElement>("img[data-local]") ?? []) {
      const ref = img.dataset.local ?? "";
      const gone = () => {
        if (!current || !img.isConnected) return;
        const note = document.createElement("span");
        note.className = "md-img-gone";
        note.textContent = `Image indisponible : ${img.alt || refName(ref)}`;
        img.replaceWith(note);
      };
      if (!threadId) {
        gone();
        continue;
      }
      img.onerror = gone;
      const known = knownLink(threadId, ref);
      if (known) {
        img.src = known.url;
        continue;
      }
      img.classList.add("waiting");
      fileLink(threadId, ref).then((link) => {
        if (!current || !img.isConnected) return;
        img.classList.remove("waiting");
        img.src = link.url;
      }, gone);
    }
    return () => {
      current = false;
    };
  }, [html, threadId]);
  const [opened, setOpened] = useState<string>();
  const open = (event: MouseEvent | KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const local = target?.closest<HTMLElement>("[data-local]");
    if (!local || !threadId) return;
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpened(local.dataset.local);
  };
  return (
    <>
      <div
        ref={root}
        className="md"
        onClick={open}
        onKeyDown={open}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {opened && threadId && (
        <FileViewer threadId={threadId} fileRef={opened} onClose={() => setOpened(undefined)} />
      )}
    </>
  );
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // A file of the computer: shown and opened in the app, from an address the server gives.
  const local = markedRef(node.getAttribute(node.tagName === "IMG" ? "src" : "href"));
  // Only what the Markdown itself marked is opened so: never an attribute the answer wrote.
  node.removeAttribute("data-local");
  node.classList.remove("md-img", "md-file");
  if (node.tagName === "IMG") {
    if (local) {
      node.removeAttribute("src");
      node.setAttribute("data-local", local);
      node.classList.add("md-img");
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `Agrandir ${node.getAttribute("alt") || "l'image"}`);
    }
    return;
  }
  if (node.tagName === "A" && local) {
    node.setAttribute("data-local", local);
    node.setAttribute("title", local);
    node.classList.add("md-file");
    node.removeAttribute("target");
    node.removeAttribute("rel");
    return;
  }
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
