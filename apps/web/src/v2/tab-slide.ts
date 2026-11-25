// The white pill of a row of tabs (`.ovtabs`) slides from the tab left to the one picked,
// instead of jumping. Drawn by the row's ::before from two variables set here, so React's
// own elements are never touched beyond a style property.

function place(row: HTMLElement): void {
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

/** Watches the page for rows of tabs and keeps their pill under the tab picked. */
export function watchTabs(): void {
  if (typeof MutationObserver !== "function" || typeof document === "undefined") return;
  new MutationObserver(soon).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  addEventListener("resize", soon);
  soon();
}
