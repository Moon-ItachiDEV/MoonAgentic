/** The icons of the v2 redesign, as one hidden sprite: `<I n="…" />` draws one of them. */
export const ICONS = {
  edit: [
    "0 0 24 24",
    '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  folder: [
    "0 0 24 24",
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  clock: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  ],
  grid: [
    "0 0 24 24",
    '<g fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></g>',
  ],
  refresh: [
    "0 0 24 24",
    '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  list: [
    "0 0 24 24",
    '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ],
  image: [
    "0 0 24 24",
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="m4 18 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  down: [
    "0 0 24 24",
    '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  right: [
    "0 0 24 24",
    '<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  left: [
    "0 0 24 24",
    '<path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  back: [
    "0 0 24 24",
    '<path d="M19 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  users: [
    "0 0 24 24",
    '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.6.5 2.7 1.9 3 4.4"/></g>',
  ],
  grip: [
    "0 0 24 24",
    '<g fill="currentColor"><circle cx="9" cy="7" r="1.4"/><circle cx="15" cy="7" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="17" r="1.4"/><circle cx="15" cy="17" r="1.4"/></g>',
  ],
  lock: [
    "0 0 24 24",
    '<g fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></g>',
  ],
  plug: [
    "0 0 24 24",
    '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  side: [
    "0 0 24 24",
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.5 4.5v15" stroke="currentColor" stroke-width="1.7"/>',
  ],
  gear: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  ],
  search: [
    "0 0 24 24",
    '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ],
  plus: [
    "0 0 24 24",
    '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ],
  hand: [
    "0 0 24 24",
    '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v5m0-2.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5-2.7L4.6 15a1.6 1.6 0 0 1 2.6-1.8L8 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  bolt: [
    "0 0 24 24",
    '<path d="M13 2 4 14h7l-1 8 9-12h-7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  mic: [
    "0 0 24 24",
    '<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  ],
  share: [
    "0 0 24 24",
    '<path d="M12 14V3.5M8 7l4-4 4 4M7 10.5H6a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  dl: [
    "0 0 24 24",
    '<path d="M12 3.5V14m-4-4 4 4 4-4M5 16.5V18a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18v-1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  target: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  ],
  pause: [
    "0 0 24 24",
    '<path d="M9 6.5v11M15 6.5v11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  ],
  play: [
    "0 0 24 24",
    '<path d="M8.5 6.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L9.7 6.1a.8.8 0 0 0-1.2.7Z" fill="currentColor"/>',
  ],
  up: [
    "0 0 24 24",
    '<path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  stop: ["0 0 24 24", '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>'],
  branch: [
    "0 0 24 24",
    '<circle cx="6" cy="5.5" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6" cy="18.5" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="7.5" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 7.5v9M18 9.5c0 4-6 3-11 7" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  ],
  merge: [
    "0 0 24 24",
    '<circle cx="6" cy="5.5" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6" cy="18.5" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="14" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 7.5v9M6 8c1 4 5 6 10 6" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  ],
  gh: [
    "0 0 24 24",
    '<path fill="currentColor" d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .8 1.5 2.3 1 2.8.8.1-.6.3-1 .6-1.3-2.1-.2-4.3-1-4.3-4.7 0-1 .4-1.9 1-2.6-.1-.3-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.2.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.2 4.5-4.3 4.7.3.3.6.9.6 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5Z"/>',
  ],
  check: [
    "0 0 24 24",
    '<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  okc: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m8 12.3 2.8 2.7L16.2 9.5" fill="none" stroke="var(--surface)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  errc: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m9 9 6 6m0-6-6 6" stroke="var(--surface)" stroke-width="2" stroke-linecap="round"/>',
  ],
  warn: [
    "0 0 24 24",
    '<path d="M12 3.5 2.5 20h19Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="var(--surface)" stroke-width="2" stroke-linecap="round"/>',
  ],
  x: [
    "0 0 24 24",
    '<path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ],
  eye: [
    "0 0 24 24",
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  ],
  wrench: [
    "0 0 24 24",
    '<path d="M14.5 6.5a4 4 0 0 0 5 5l-8.8 8.8a2.1 2.1 0 0 1-3-3L16.5 8.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 6.5 17 4l3 3-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  code: [
    "0 0 24 24",
    '<path d="m8 7-5 5 5 5m8-10 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  dots: [
    "0 0 24 24",
    '<circle cx="5.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor"/>',
  ],
  moon: [
    "0 0 24 24",
    '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  star: [
    "0 0 24 24",
    '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  ],
  starf: [
    "0 0 24 24",
    '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8Z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  ],
  gauge: [
    "0 0 24 24",
    '<path d="M4 17a8 8 0 1 1 16 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m12 17 4-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  ],
  wifi: [
    "0 0 24 24",
    '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  ],
  shield: [
    "0 0 24 24",
    '<path d="M12 3 5 6v5.5c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  file: [
    "0 0 24 24",
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  ext: [
    "0 0 24 24",
    '<path d="M14 4h6v6m0-6-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  menu: [
    "0 0 24 24",
    '<path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ],
  bubble: [
    "0 0 24 24",
    '<path d="M4 12a8 8 0 1 1 3.5 6.6L4 20l1.2-3.4A8 8 0 0 1 4 12Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  ],
  sun: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  ],
  dot: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  ],
  draft: [
    "0 0 24 24",
    '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.5 2.8"/>',
  ],
  num: ["0 0 24 24", '<circle cx="12" cy="12" r="9" fill="currentColor"/>'],
  camera: [
    "0 0 24 24",
    '<path d="M4 8h3l2-3h6l2 3h3v11H4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  ],
  menu2: [
    "0 0 24 24",
    '<path d="M5 9h14M5 15h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ],
  hook: [
    "0 0 24 24",
    '<path d="M6 4v5a6 6 0 0 0 6 6h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  ],
  tbubble: [
    "0 0 16 16",
    '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  ],
  stack: [
    "0 0 16 16",
    '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8 2.5 13.5 5 8 7.5 2.5 5Z"/><path d="M2.5 8 8 10.5 13.5 8M2.5 11 8 13.5l5.5-2.5"/></g>',
  ],
  copies: [
    "0 0 16 16",
    '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="5" y="5" width="8.5" height="8.5" rx="2"/><path d="M10.5 3.2A1.7 1.7 0 0 0 9 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2V9a1.7 1.7 0 0 0 .7 1.4"/></g>',
  ],
  tcode: [
    "0 0 16 16",
    '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  ],
  ghost: [
    "0 0 24 24",
    '<path fill="currentColor" fill-rule="evenodd" d="M5 10.5a7 7 0 0 1 14 0v8.9q-1.17 1.5-2.33 0t-2.34 0-2.33 0-2.33 0-2.34 0-2.33 0Z M9.5 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z M14.5 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>',
  ],
  info: [
    "0 0 24 24",
    '<path d="M12 10.5V17M12 7v.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ],
} as const satisfies Record<string, readonly [viewBox: string, body: string]>;

export type IconName = keyof typeof ICONS;

/**
 * A stroke's width, scaled by `--icon-k` set on a part of the page (the menu, the popups draw
 * finer lines). A CSS selector cannot reach the lines inside `<use>`, a custom property can.
 * The rings in the page's own colour (`var(--surface)`) that cut a badge out keep their width.
 */
export const thinnable = (body: string): string =>
  body.replace(/<[a-z]+\b[^>]*>/g, (tag) =>
    tag.includes('stroke="var(--surface)"')
      ? tag
      : tag.replace(
          /stroke-width="([\d.]+)"/,
          (_, w: string) => `style="stroke-width:calc(${w}px * var(--icon-k, 1))"`,
        ),
  );

export const SPRITE = Object.entries(ICONS)
  .map(
    ([name, [box, body]]) => `<symbol id="i-${name}" viewBox="${box}">${thinnable(body)}</symbol>`,
  )
  .join("");
