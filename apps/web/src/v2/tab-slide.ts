// The white pill of a row of tabs (`.ovtabs`) slides from the tab left to the one picked,
// instead of jumping. Drawn by the row's ::before from two variables set here, so React's
// own elements are never touched beyond a style property.

const watched = new WeakSet<HTMLElement>();
let resizeObserver: ResizeObserver | undefined;

function place(row: HTMLElement): void {
  if (resizeObserver && !watched.has(row)) {
    watched.add(row);
    resizeObserver.observe(row);
  }
  const on = row.querySelector<HTMLElement>(':scope > [aria-selected="true"]');
  if (!on) {
    row.style.removeProperty("--tw");
    return;
  }
  const x = `${on.offsetLeft}px`;
  const w = `${on.offsetWidth}px`;
  if (row.style.getPropertyValue("--tx") !== x) row.style.setProperty("--tx", x);
  if (row.style.getPropertyValue("--tw") !== w) row.style.setProperty("--tw", w);
  // The first placing does not slide: the pill is simply there.
  if (!row.dataset.slide) requestAnimationFrame(() => (row.dataset.slide = "1"));
}

let queued = false;
function placeAll(): void {
  queued = false;
  for (const row of document.querySelectorAll<HTMLElement>(".ovtabs")) place(row);
}
const soon = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(placeAll);
};

function touchesTabs(records: MutationRecord[]): boolean {
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : null;
    if (record.type === "attributes") {
      if (target?.closest(".ovtabs")) return true;
      continue;
    }
    // Streaming replies mutate inside `.md`: never trigger layout work for them.
    if (target?.closest(".md")) continue;
    if (target?.closest(".ovtabs")) return true;
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(".ovtabs") || node.querySelector(".ovtabs")) return true;
    }
  }
  return false;
}

/** Watches the page for rows of tabs and keeps their pill under the tab picked. */
export function watchTabs(): void {
  if (typeof MutationObserver !== "function" || typeof document === "undefined") return;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement && entry.target.isConnected) place(entry.target);
      }
    });
  }
  new MutationObserver((records) => {
    if (touchesTabs(records)) soon();
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  addEventListener("resize", soon);
  soon();
}
