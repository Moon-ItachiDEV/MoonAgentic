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

export const IconCompose = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
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
export const IconStop = ({ size = 12 }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
    <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
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
