import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo } from "react";

/** Renders agent Markdown; links open outside the app. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
