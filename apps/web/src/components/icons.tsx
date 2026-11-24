import type { SVGProps } from "react";

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

type P = { size?: number };

/** Drawn on the mockup's 16 px grid, with its 1.4 px lines. */
const fine = (size: number): SVGProps<SVGSVGElement> => ({
  ...base(size),
  viewBox: "0 0 16 16",
  strokeWidth: 1.4,
});

/** A square with a pen: a new conversation, as in the mockup. */
export const IconCompose = ({ size = 16 }: P) => (
  <svg {...fine(size)}>
    <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V8" />
    <path d="M11.5 2.5l2 2L8 10H6V8z" />
  </svg>
);
/** Three lines with bullets: the planner, as in the mockup. */
export const IconList = ({ size = 16 }: P) => (
  <svg {...fine(size)}>
    <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />
  </svg>
);
export const IconFolder = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);
export const IconMenu = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M4 7h16M4 12h10M4 17h16" />
  </svg>
);
export const IconArrowUp = ({ size = 16 }: P) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
/** The microphone, as in the mockup: its capsule fills with the voice's level (`--lv`). */
export const IconMic = () => (
  <svg
    className="mic"
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect className="mic-fill" x="6" y="2" width="4" height="7.5" rx="2" fill="currentColor" />
    <rect x="6" y="2" width="4" height="7.5" rx="2" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2" />
  </svg>
);
/** Five bars: talk instead of typing. */
export const IconWave = () => (
  <span className="vw" aria-hidden>
    <i />
    <i />
    <i />
    <i />
    <i />
  </span>
);
export const IconStop = ({ size = 12 }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
    <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
  </svg>
);
export const IconClock = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
/** A triangle pointing right: starts something. */
export const IconPlay = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M7 4.5v15l12-7.5Z" />
  </svg>
);
export const IconPause = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M8 5v14M16 5v14" />
  </svg>
);
export const IconShield = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z" />
  </svg>
);
export const IconCheck = ({ size = 13 }: P) => (
  <svg {...base(size)} strokeWidth={2.4}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const IconX = ({ size = 13 }: P) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const IconChevron = ({ size = 12 }: P) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const IconPlus = ({ size = 16 }: P) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconGear = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);
/** A speech bubble: the phone's « Nouveau » tab. */
export const IconBubble = ({ size = 20 }: P) => (
  <svg {...fine(size)}>
    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5Z" />
  </svg>
);
/** Three stacked layers: the phone's « Projets » tab. */
export const IconStack = ({ size = 20 }: P) => (
  <svg {...fine(size)}>
    <path d="M8 2.5 13.5 5 8 7.5 2.5 5Z" />
    <path d="M2.5 8 8 10.5 13.5 8M2.5 11 8 13.5l5.5-2.5" />
  </svg>
);
/** Two angle brackets, on the mockup's grid: the phone's « Code » tab. */
export const IconBrackets = ({ size = 20 }: P) => (
  <svg {...fine(size)}>
    <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </svg>
);
/** Two sheets, one over the other, on the mockup's grid: the phone's « Artefacts » tab. */
export const IconCopies = ({ size = 20 }: P) => (
  <svg {...fine(size)}>
    <rect x="5" y="5" width="8.5" height="8.5" rx="2" />
    <path d="M10.5 3.2A1.7 1.7 0 0 0 9 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2V9a1.7 1.7 0 0 0 .7 1.4" />
  </svg>
);
/** An arrow to the left: back home, in a conversation on a phone. */
export const IconArrowLeft = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </svg>
);
export const IconMoon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);
export const IconSun = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
export const IconBack = ({ size = 14 }: P) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="m15 6-6 6 6 6" />
  </svg>
);
export const IconAlert = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </svg>
);
export const IconStar = ({ size = 14, filled = false }: P & { filled?: boolean }) => (
  <svg {...base(size)} fill={filled ? "currentColor" : "none"}>
    <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" />
  </svg>
);
export const IconPlug = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M9 2v5M15 2v5" />
    <path d="M6 7h12v4a6 6 0 0 1-12 0Z" />
    <path d="M12 17v5" />
  </svg>
);
/** A panel with its side bar: folds or unfolds the side bar. */
export const IconSidebar = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </svg>
);
export const IconWifi = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M2.5 9a14 14 0 0 1 19 0M6 12.7a9 9 0 0 1 12 0M9.3 16.3a4 4 0 0 1 5.4 0" />
    <path d="M12 20h.01" />
  </svg>
);
export const IconBranch = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="7" r="2" />
    <path d="M6 7v10" />
    <path d="M18 9c0 5-6 4-11.5 8.5" />
  </svg>
);
export const IconUndo = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </svg>
);
export const IconPin = ({ size = 13, filled = false }: P & { filled?: boolean }) => (
  <svg {...base(size)} fill={filled ? "currentColor" : "none"}>
    <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3Z" />
    <path d="M12 15v5" />
  </svg>
);
export const IconSearch = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);
export const IconCode = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
  </svg>
);
export const IconFile = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const IconTerminal = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="m5 8 4 4-4 4M12 17h7" />
  </svg>
);
export const IconChat = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z" />
  </svg>
);
export const IconBoard = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="9.5" y="4" width="5" height="10" rx="1.5" />
    <rect x="16" y="4" width="5" height="13" rx="1.5" />
  </svg>
);
export const IconInbox = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" />
  </svg>
);
export const IconMore = ({ size = 17 }: P) => (
  <svg {...base(size)}>
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="12" cy="12" r="1.2" />
    <circle cx="19" cy="12" r="1.2" />
  </svg>
);
export const IconArchive = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </svg>
);
export const IconClose = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconExpand = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
  </svg>
);

/** A dial: how much of a subscription is used. */
export const IconGauge = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="m12 17 4-5" />
  </svg>
);

/** Two arrows turning: read again. */
export const IconRefresh = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" />
    <path d="M20 20v-4h-4" />
  </svg>
);
/** Four squares: the activity map. */
export const IconGrid = ({ size = 14 }: P) => (
  <svg {...fine(size)}>
    <rect x="2" y="2" width="5" height="5" rx="1.2" />
    <rect x="9" y="2" width="5" height="5" rx="1.2" />
    <rect x="2" y="9" width="5" height="5" rx="1.2" />
    <rect x="9" y="9" width="5" height="5" rx="1.2" />
  </svg>
);
/** A branch going back into another: a pull request. */
export const IconPullRequest = ({ size = 14 }: P) => (
  <svg {...fine(size)}>
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="12.5" r="1.6" />
    <path d="M4 5.1v5.8M12 10.9V6.5c0-1.1-.9-2-2-2H7.5M9 3l-1.5 1.5L9 6" />
  </svg>
);

/** A framed landscape: an image joined to a message. */
export const IconImage = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 3.5 3 3-2.5L20 17" />
  </svg>
);
export const IconCamera = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.2-1.8h6.2L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z" />
    <circle cx="12" cy="12.5" r="3.2" />
  </svg>
);

/** A raised hand: the agent asks before it acts. */
export const IconHand = ({ size = 15 }: P) => (
  <svg {...fine(size)} strokeWidth={1.3}>
    <path d="M5.5 8V3.3a1 1 0 0 1 2 0V7.5M7.5 7V2.3a1 1 0 0 1 2 0V7.5M9.5 7.5V3.3a1 1 0 0 1 2 0V9c0 3-1.8 5-4.4 5-1.7 0-2.7-.8-3.6-2.2L2 9.3a1 1 0 0 1 1.6-1.2L5.5 10" />
  </svg>
);
/** A lightning bolt: full access, the agent acts without asking. */
export const IconBolt = ({ size = 15 }: P) => (
  <svg {...fine(size)}>
    <path d="M9 1.8 3.5 9h4l-1 5.2L12.5 7h-4z" />
  </svg>
);
/** A small caret under a chip that opens a menu. */
export const IconCaret = ({ size = 10 }: P) => (
  <svg {...fine(size)} viewBox="0 0 10 10" className="caret">
    <path d="m2.5 3.8 2.5 2.5 2.5-2.5" />
  </svg>
);
/** Lines with a plus: put in line, sent once the agent is done. */
export const IconQueue = ({ size = 16 }: P) => (
  <svg {...fine(size)} strokeWidth={1.6}>
    <path d="M3 4.5h10M3 8h6M3 11.5h4M11 9.5v4M9 11.5h4" />
  </svg>
);
/** Two arrows crossing: hand over to another agent. */
export const IconSwap = ({ size = 13 }: P) => (
  <svg {...fine(size)} strokeWidth={1.5}>
    <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" />
  </svg>
);
/** A four-pointed star: the « Galaxie » effort. */
export const IconSparkle = ({ size = 11 }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
    <path d="M6 .5 7.2 4.8 11.5 6 7.2 7.2 6 11.5 4.8 7.2.5 6l4.3-1.2z" />
  </svg>
);
/** A crescent with its orbit: the effort slider's thumb, as on the logo. */
export const IconOrbit = ({ size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M10.6 3.3A5 5 0 1 0 12.7 9 4 4 0 0 1 10.6 3.3z" fill="currentColor" />
    <ellipse
      cx="8"
      cy="8"
      rx="7"
      ry="2.6"
      transform="rotate(-24 8 8)"
      stroke="currentColor"
      strokeWidth="1"
      opacity=".7"
    />
  </svg>
);
/** A folder on the 16 px grid, for the tray under the composer. */
export const IconFolderFine = ({ size = 14 }: P) => (
  <svg {...fine(size)}>
    <path d="M2 4.2c0-.6.5-1.1 1.1-1.1h3l1.5 1.6h5.3c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" />
  </svg>
);
/** A padlock, as the mockup draws it: a project locked with /lock. */
export const IconLock = ({ size = 13 }: P) => (
  <svg {...fine(size)}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.7" />
    <path d="M5.6 7V5.3a2.4 2.4 0 0 1 4.8 0V7" />
  </svg>
);

/** Filled marks for a state, as in the mockup: the inner stroke takes the surface color. */
const mark = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
});
/** A filled round with a check: passed. */
export const IconOkCircle = ({ size = 16 }: P) => (
  <svg {...mark(size)}>
    <circle cx="12" cy="12" r="9" fill="currentColor" />
    <path
      d="m8 12.3 2.8 2.7L16.2 9.5"
      fill="none"
      stroke="var(--surface)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/** A filled round with a cross: failed. */
export const IconErrCircle = ({ size = 16 }: P) => (
  <svg {...mark(size)}>
    <circle cx="12" cy="12" r="9" fill="currentColor" />
    <path d="m9 9 6 6m0-6-6 6" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
/** A filled triangle: something waits to be sorted out. */
export const IconWarnTri = ({ size = 16 }: P) => (
  <svg {...mark(size)}>
    <path
      d="M12 3.5 2.5 20h19Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path d="M12 10v4.5M12 17.2v.1" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
/** GitHub's mark. */
export const IconGithub = ({ size = 14 }: P) => (
  <svg {...mark(size)}>
    <path
      fill="currentColor"
      d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .8 1.5 2.3 1 2.8.8.1-.6.3-1 .6-1.3-2.1-.2-4.3-1-4.3-4.7 0-1 .4-1.9 1-2.6-.1-.3-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.2.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.2 4.5-4.3 4.7.3.3.6.9.6 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5Z"
    />
  </svg>
);
/** Opens elsewhere. */
export const IconExternal = ({ size = 12 }: P) => (
  <svg {...base(size)} strokeWidth={1.7}>
    <path d="M14 4h6v6m0-6-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </svg>
);
/** A wrench: an agent fixes it. */
export const IconWrench = ({ size = 15 }: P) => (
  <svg {...base(size)} strokeWidth={1.7}>
    <path d="M14.5 6.5a4 4 0 0 0 5 5l-8.8 8.8a2.1 2.1 0 0 1-3-3L16.5 8.5" />
    <path d="M14.5 6.5 17 4l3 3-2.5 2.5" />
  </svg>
);
/** Two branches joining: merged. */
export const IconMerge = ({ size = 15 }: P) => (
  <svg {...base(size)} strokeWidth={1.7}>
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="6" cy="18.5" r="2" />
    <circle cx="18" cy="14" r="2" />
    <path d="M6 7.5v9M6 8c1 4 5 6 10 6" />
  </svg>
);
/** Two people: the teams. */
export const IconUsers = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
  </svg>
);
/** An arrow down onto a line: to keep a file on the device. */
export const IconDownload = ({ size = 16 }: P) => (
  <svg {...fine(size)}>
    <path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.5h10" />
  </svg>
);
