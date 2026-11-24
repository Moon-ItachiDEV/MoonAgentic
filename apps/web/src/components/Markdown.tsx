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
import {
  fileLink,
  forgetFileLink,
  knownLink,
  localFiles,
  markedRef,
  refName,
} from "../local-files.ts";
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
        (img.parentElement?.classList.contains("md-img-box") ? img.parentElement : img).replaceWith(
          note,
        );
      };
      if (!threadId) {
        gone();
        continue;
      }
      boxed(img, ref);
      const ask = () =>
        fileLink(threadId, ref).then((link) => {
          if (!current || !img.isConnected) return;
          img.classList.remove("waiting");
          img.src = link.url;
        }, gone);
      img.onload = () => prepareShare(threadId, ref, img.currentSrc || img.src);
      // An address that no longer serves it, the server having started again: asked anew once.
      img.onerror = () => {
        img.onerror = gone;
        forgetFileLink(threadId, ref);
        void ask();
      };
      const known = knownLink(threadId, ref);
      if (known) {
        img.src = known.url;
        continue;
      }
      img.classList.add("waiting");
      void ask();
    }
    return () => {
      current = false;
    };
  }, [html, threadId]);
  const [opened, setOpened] = useState<string>();
  const open = (event: MouseEvent | KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const keep = target?.closest<HTMLButtonElement>("button[data-keep]");
    if (keep && threadId) {
      if ("key" in event) return;
      event.preventDefault();
      void keepImage(threadId, keep.dataset.keep ?? "");
      return;
    }
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

const KEEP_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10V2.5M5 5.25 8 2.25l3 3M4.5 7.5H4a1.5 1.5 0 0 0-1.5 1.5v3.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V9A1.5 1.5 0 0 0 12 7.5h-.5"/></svg>';

/**
 * Puts an answer's image in a box of its own with, over its corner, what keeps it: shared to
 * Photos or another app on a phone, downloaded on a computer. Drawn here, once the answer is
 * cleaned: nothing an answer writes becomes a button.
 */
function boxed(img: HTMLImageElement, ref: string) {
  if (img.parentElement?.classList.contains("md-img-box")) return;
  const box = document.createElement("span");
  box.className = "md-img-box";
  img.replaceWith(box);
  box.append(img);
  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "md-img-keep";
  keep.dataset.keep = ref;
  const label = canShareFiles() ? "Partager l'image" : "Télécharger l'image";
  keep.setAttribute("aria-label", label);
  keep.title = label;
  keep.innerHTML = KEEP_ICON;
  box.append(keep);
}

function canShareFiles(): boolean {
  try {
    return (
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([""], "x.png", { type: "image/png" })] })
    );
  } catch {
    return false;
  }
}

/** The images already read, ready to share: a share sheet opens only right after the tap. */
const ready = new Map<string, File>();
const readyKey = (threadId: string, ref: string) => `${threadId}\n${ref}`;

/** Reads a shown image once more, from the page's cache, so the tap can share it at once. */
function prepareShare(threadId: string, ref: string, url: string) {
  const key = readyKey(threadId, ref);
  if (ready.has(key) || !canShareFiles()) return;
  const link = knownLink(threadId, ref);
  if (!link) return;
  void fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((blob) => {
      ready.set(key, new File([blob], link.name, { type: link.mime }));
      while (ready.size > 20) ready.delete(ready.keys().next().value!);
    })
    .catch(() => undefined);
}

/** Shares an image to the device's apps (Photos on an iPhone), or downloads it. */
async function keepImage(threadId: string, ref: string) {
  const file = ready.get(readyKey(threadId, ref));
  if (file && canShareFiles() && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      // The user closed the share sheet: nothing more to do.
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  const link = await fileLink(threadId, ref).catch(() => undefined);
  if (!link) return;
  const a = document.createElement("a");
  a.href = link.url;
  a.download = link.name;
  document.body.append(a);
  a.click();
  a.remove();
}

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
