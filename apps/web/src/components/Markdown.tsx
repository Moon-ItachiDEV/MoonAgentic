import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo } from "react";

/** Renders agent Markdown; links open outside the app. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), {
    // An answer is text to read: nothing in it should look like part of the app or submit anything.
    FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "style"],
  });
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
