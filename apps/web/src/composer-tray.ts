/** Up and down arrows move between a menu's items, as in the mockup. */
export function arrowKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(at + step + items.length) % items.length]?.focus();
}

/** A quota close to its limit, said above the composer. */
export interface TrayQuota {
  level: "warn" | "full";
  /** Percent of the tightest window used, for the meter. */
  usedPercent: number;
  text: string;
  when?: string;
  /** The agent with the most room left, to hand over to. */
  roomier?: { id: string; name: string };
  onSwitch?: () => void;
  onLimits?: () => void;
  onDismiss: () => void;
}
