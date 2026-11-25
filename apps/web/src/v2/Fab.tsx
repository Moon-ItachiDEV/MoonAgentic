import { type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The page's one floating action, as in the mockup: it stays over the bottom of the page while
 * the page scrolls under it, so it is drawn in the page's frame and not in what scrolls.
 */
export function Fab({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHost(document.getElementById("main")), []);
  return host && createPortal(<div className="fab">{children}</div>, host);
}
