import { useEffect, useState } from "react";

/** How long a menu or a window takes to leave: shorter than it took to come. */
export const EXIT_MS = 150;

/**
 * Keeps what closes on the page while it leaves: `mounted` stays true `ms` longer, with
 * `leaving` set meanwhile, then both go. Without motion, it goes at once.
 */
export function useExit(open: boolean, ms = EXIT_MS): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setMounted(false);
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, mounted, ms]);
  return { mounted: mounted || open, leaving: mounted && !open };
}
