import type { GlyphKind } from "../glyphs.ts";
import { useEffect, useId, useRef } from "react";

/*
 * Frost Moon – mascotte lune givrée (croissant ou pleine lune) dont les yeux expriment en direct
 * chacun des états réels d'un agent MoonAgentic (repos, démarre, pense, cherche, lit, écrit,
 * modifie, commande, tests, web, travaille, attend, file, terminé, erreur).
 *
 * Anatomie des yeux :
 * - Puits d'iris profond en dégradé + lueur d'iris inférieure + double reflet spéculaire en parallaxe
 *   + reflet de lignes de terminal qui défilent pendant `commande`.
 * - Paupières sculptées indépendantes par œil : paupière supérieure orientable, paupière inférieure
 *   plate de visée/plissement (`modifie`, `cherche`) et arche inférieure de sourire `^ ^` (`termine`, `tests`).
 * - Raccourci perspectif 3D entre l'œil proche du bord et l'œil face caméra.
 */

export const FROST_MOON_COLORS = [
  "moon",
  "blue",
  "orange",
  "emerald",
  "violet",
  "rose",
  "gold",
  "crimson",
  "silver",
] as const;

export type FrostMoonPhase = "crescent" | "full" | "star" | "planet" | "chef";
export type FrostMoonColor = (typeof FROST_MOON_COLORS)[number];
export type FrostMoonLook = "frost" | "glow";
export type FrostMoonState = GlyphKind | "repos" | "termine" | "erreur";

/** Associe chaque agent de MoonAgentic à sa teinte de lune givrée naturelle */
export function agentMoonColor(agentId: string | undefined): FrostMoonColor {
  switch (agentId) {
    case "claude":
      return "orange";
    case "antigravity":
    case "agy":
      return "blue";
    case "hermes":
      return "emerald";
    case "cursor":
      return "violet";
    case "codex":
      return "silver";
    default:
      return "moon";
  }
}

export type FrostMoonProps = {
  /** "crescent" : croissant · "full" : pleine lune · "star" : étoile · "planet" : planète 3D · "chef" : chef couronné */
  phase?: FrostMoonPhase;
  /** Teinte givrée : moon, blue, orange, emerald, violet, rose, gold, crimson ou silver */
  color?: FrostMoonColor;
  /** "frost" : glace teintée aux yeux découpés profonds · "glow" : cœur coloré intense aux yeux givrés */
  look?: FrostMoonLook;
  /** État réel de l'agent exprimé par les yeux ("repos" par défaut, ou tout GlyphKind MoonAgentic) */
  state?: FrostMoonState;
  /** Taille carrée explicite en px ou unité CSS (ex. 96 ou "6rem") */
  size?: number | string;
  /** Affiche les deux mini-éclats cristallins autour de la mascotte étoile (true par défaut) */
  sparkles?: boolean;
  /** Affiche la petite lune givrée en orbite sur l'anneau de la mascotte planète (true par défaut) */
  moonlet?: boolean;
  /** Affiche la couronne cristalline flottante au-dessus de la mascotte chef (true par défaut) */
  crown?: boolean;
  /** Ajoute optionnellement une tuile de ciel derrière la mascotte (false par défaut : flotte sans tuile en gardant sa couleur) */
  background?: boolean;
  /** Les yeux suivent le pointeur tant qu'il survole l'illustration */
  followPointer?: boolean;
  className?: string;
  /** Description accessible de l'illustration */
  label?: string;
};

/*
 * Croissant dodu à pointes arrondies tangentes (cercles R1=75 et R2=57 décalés de 70 px à -32°,
 * coiffés d'arcs tangents de rayon 9 px) : assez large au creux de la joue pour que les deux yeux
 * bougent librement sans jamais approcher le bord concave.
 */
const CRESCENT =
  "M122.03 40A75 75 0 1 0 189.42 147.85A9 9 0 0 0 181.34 134.91A57 57 0 0 1 130.12 52.94A9 9 0 0 0 122.03 40Z";

/*
 * Étoile mascotte à 5 branches bombées (continuité G1 exacte à 3 arcs : pointes R=14, joues convexes R=95,
 * vallées douces R=12.5 autour de (120,123)) accompagnée de deux éclats cristallins à 4 pointes.
 */
const STAR =
  "M107.46 54.28A14 14 0 0 1 132.54 54.28A95 95 0 0 1 140.91 79.52A12.5 12.5 0 0 0 154.89 89.68A95 95 0 0 1 181.48 89.84A14 14 0 0 1 189.23 113.69A95 95 0 0 1 167.81 129.45A12.5 12.5 0 0 0 162.47 145.88A95 95 0 0 1 170.54 171.23A14 14 0 0 1 150.25 185.97A95 95 0 0 1 128.64 170.46A12.5 12.5 0 0 0 111.36 170.46A95 95 0 0 1 89.75 185.97A14 14 0 0 1 69.46 171.23A95 95 0 0 1 77.53 145.88A12.5 12.5 0 0 0 72.19 129.45A95 95 0 0 1 50.77 113.69A14 14 0 0 1 58.52 89.84A95 95 0 0 1 85.11 89.68A12.5 12.5 0 0 0 99.09 79.52A95 95 0 0 1 107.46 54.28Z";

const SPARKLE_LG =
  "M-1.5 -10A1.5 1.5 0 0 1 1.5 -10Q2.65 -2.65 10 -1.5A1.5 1.5 0 0 1 10 1.5Q2.65 2.65 1.5 10A1.5 1.5 0 0 1 -1.5 10Q-2.65 2.65 -10 1.5A1.5 1.5 0 0 1 -10 -1.5Q-2.65 -2.65 -1.5 -10Z";

const SPARKLE_SM =
  "M-0.98 -6.53A0.98 0.98 0 0 1 0.98 -6.53Q1.73 -1.73 6.53 -0.98A0.98 0.98 0 0 1 6.53 0.98Q1.73 1.73 0.98 6.53A0.98 0.98 0 0 1 -0.98 6.53Q-1.73 1.73 -6.53 0.98A0.98 0.98 0 0 1 -6.53 -0.98Q-1.73 -1.73 -0.98 -6.53Z";

const FULL_RADIUS = 68;
const PLANET_RADIUS = 54;
const PLANET_CY = 118;
const RING_CY = 125;
const RING_ROT = -18;
const PLANET_RING =
  "M-95 0A95 26.5 0 1 1 95 0A95 26.5 0 1 1 -95 0ZM-63.5 0A63.5 16 0 1 0 63.5 0A63.5 16 0 1 0 -63.5 0Z";

const CHEF_RADIUS = 60;
const CHEF_CY = 132;
const CROWN_Y = 58;
const CHEF_CROWN =
  "M-27 11C-31 11 -33 7.5 -32 3.5L-29 -10C-28.2 -13.5 -24 -14.8 -21.2 -12.4L-11.5 -4.2C-10.2 -3.1 -8.2 -3.5 -7.5 -5.1L-2.8 -16.2C-1.6 -19.1 1.6 -19.1 2.8 -16.2L7.5 -5.1C8.2 -3.5 10.2 -3.1 11.5 -4.2L21.2 -12.4C24 -14.8 28.2 -13.5 29 -10L32 3.5C33 7.5 31 11 27 11Q0 16.5 -27 11Z";
const CHEF_BAND = "M-24 6.5Q0 11.2 24 6.5";

/** Cratères givrés asymétriques de la pleine lune, éclairés depuis le haut-gauche */
const CRATERS = [
  { cx: 155, cy: 80, rx: 12.5, ry: 10.5, rot: 30 },
  { cx: 171, cy: 103, rx: 6, ry: 5, rot: 48 },
  { cx: 77, cy: 147, rx: 10, ry: 8.5, rot: -34 },
  { cx: 148, cy: 159, rx: 6.5, ry: 5.2, rot: 22 },
] as const;

const GEOMETRY = {
  crescent: {
    cx: 116,
    cy: 120,
    bottom: 186,
    shadowRx: 50,
    eyes: { y: 113, w: 18, h: 31, left: 76.5, right: 106.5 },
    gazeX: 9.5,
    gazeY: 5.5,
    shine: { cx: 91, cy: 76, rx: 29, ry: 13, rot: -30 },
  },
  full: {
    cx: 120,
    cy: 120,
    bottom: 188,
    shadowRx: 52,
    eyes: { y: 106, w: 19, h: 32, left: 94.5, right: 126.5 },
    gazeX: 11.5,
    gazeY: 6.8,
    shine: { cx: 96, cy: 75, rx: 32, ry: 13.5, rot: -24 },
  },
  star: {
    cx: 120,
    cy: 123,
    bottom: 186,
    shadowRx: 48,
    eyes: { y: 112, w: 18.5, h: 30.5, left: 94.5, right: 127 },
    gazeX: 10.5,
    gazeY: 6.2,
    shine: { cx: 105, cy: 82, rx: 27, ry: 12.5, rot: -26 },
  },
  planet: {
    cx: 120,
    cy: PLANET_CY,
    bottom: 184,
    shadowRx: 58,
    eyes: { y: 95.5, w: 16.5, h: 27.5, left: 97.5, right: 126 },
    gazeX: 9.5,
    gazeY: 5.2,
    shine: { cx: 101, cy: 82, rx: 25, ry: 11, rot: -24 },
  },
  chef: {
    cx: 120,
    cy: CHEF_CY,
    bottom: 192,
    shadowRx: 50,
    eyes: { y: 117, w: 18.5, h: 31, left: 95, right: 126.5 },
    gazeX: 10.5,
    gazeY: 6,
    shine: { cx: 98, cy: 95, rx: 26, ry: 11.5, rot: -24 },
  },
} as const;

/** Micro-expressions spontanées au repos : regard droit, côtés, ou petit air curieux */
const IDLE_POSES = [
  { x: 0, y: 0, tilt: 0, lidL: 0, lidR: 0, slantL: 0, slantR: 0 },
  { x: -0.9, y: 0.05, tilt: -1.5, lidL: 0, lidR: 0, slantL: 0, slantR: 0 },
  { x: 0.88, y: -0.04, tilt: 1.5, lidL: 0, lidR: 0, slantL: 0, slantR: 0 },
  { x: 0, y: -0.05, tilt: 0, lidL: 0, lidR: 0, slantL: 0, slantR: 0 },
  { x: 0.55, y: -0.45, tilt: 2.5, lidL: 0.14, lidR: 0.06, slantL: 4, slantR: 0 },
  { x: -0.22, y: -0.1, tilt: -5, lidL: 0.22, lidR: 0, slantL: -7, slantR: 0 },
  { x: -0.72, y: 0.3, tilt: -1.5, lidL: 0.08, lidR: 0.08, slantL: 0, slantR: 0 },
] as const;

/** Points de fouille rapide dans le code pour l'état `cherche` */
const SEARCH_POINTS = [
  { x: -0.72, y: -0.26 },
  { x: 0.68, y: 0.18 },
  { x: -0.35, y: 0.42 },
  { x: 0.62, y: -0.38 },
  { x: -0.66, y: 0.14 },
  { x: 0.22, y: -0.44 },
] as const;

type EyePose = {
  gx: number;
  gy: number;
  tilt: number;
  topL: number;
  topR: number;
  slantL: number;
  slantR: number;
  botL: number;
  botR: number;
  smile: number;
  dilate: number;
  scaleYL: number;
  scaleYR: number;
  irisPulse: number;
  termScroll: number; // > 0 pendant `commande` : lignes de terminal reflétées dans les yeux
  cursorBlink: number; // > 0 pendant `ecrit` : éclat de curseur qui tape
  jitterX: number;
};

/** Calcule l'expression exacte des yeux à l'instant `t` pour chaque état réel d'un agent */
export function computeEyePose(state: FrostMoonState, t: number): EyePose {
  const base: EyePose = {
    gx: 0,
    gy: 0,
    tilt: 0,
    topL: 0,
    topR: 0,
    slantL: 0,
    slantR: 0,
    botL: 0,
    botR: 0,
    smile: 0,
    dilate: 1,
    scaleYL: 1,
    scaleYR: 1,
    irisPulse: 0.72,
    termScroll: 0,
    cursorBlink: 0,
    jitterX: 0,
  };

  switch (state) {
    case "demarre": {
      // Réveil vif : paupières qui s'ouvrent grand avec dilatation lumineuse
      const cycle = (t * 0.65) % 1;
      const wake = Math.min(1, cycle / 0.42);
      const ease = 1 - (1 - wake) ** 3;
      base.gy = (1 - ease) * 0.22 - ease * 0.1;
      base.topL = (1 - ease) * 0.52;
      base.topR = (1 - ease) * 0.52;
      base.scaleYL = 0.92 + ease * 0.18;
      base.scaleYR = 0.92 + ease * 0.18;
      base.dilate = 0.9 + ease * 0.28;
      base.irisPulse = 0.65 + ease * 0.3;
      return base;
    }

    case "pense": {
      // Réflexion profonde : regard levé en coin qui pèse deux pistes, paupières pensives, iris pulsant
      const side = Math.sin(t * 0.44) >= 0 ? 1 : -1;
      base.gx = side * 0.52 + Math.sin(t * 1.4) * 0.06;
      base.gy = -0.54 + Math.cos(t * 1.1) * 0.05;
      base.tilt = side * 4.5 + Math.sin(t * 0.9) * 1;
      base.topL = side > 0 ? 0.3 : 0.14;
      base.topR = side > 0 ? 0.14 : 0.3;
      base.slantL = side * 5;
      base.slantR = side * 5;
      base.botL = 0.08;
      base.botR = 0.08;
      base.dilate = 1.06 + Math.sin(t * 2.6) * 0.08;
      base.irisPulse = 0.55 + 0.42 * (0.5 + 0.5 * Math.sin(t * 2.6));
      return base;
    }

    case "cherche": {
      // Détective / radar : un œil plissé à la loupe, l'autre grand ouvert, saccades rapides dans le code
      const step = Math.floor(t / 0.48) % SEARCH_POINTS.length;
      const pt = SEARCH_POINTS[step]!;
      base.gx = pt.x;
      base.gy = pt.y;
      base.tilt = pt.x * 3.2;
      base.topL = 0.42;
      base.botL = 0.2;
      base.slantL = 6;
      base.topR = 0.04;
      base.scaleYL = 0.88;
      base.scaleYR = 1.12;
      base.dilate = 1.14;
      return base;
    }

    case "lit": {
      // Lecture fluide ligne par ligne : balayage gauche -> droite puis retour chariot net
      const period = 1.35;
      const cycle = t / period;
      const line = Math.floor(cycle) % 4;
      const f = cycle - Math.floor(cycle);
      const scan = f < 0.84 ? -0.58 + (f / 0.84) * 1.16 : 0.58 - ((f - 0.84) / 0.16) * 1.16;
      base.gx = scan;
      base.gy = 0.08 + line * 0.11;
      base.tilt = scan * 1.6;
      base.topL = 0.22;
      base.topR = 0.22;
      base.slantL = 3;
      base.slantR = -3;
      base.dilate = 1.02;
      return base;
    }

    case "ecrit": {
      // Écriture de tokens : regard concentré qui avance par petits crans rapides + curseur qui clignote
      const cols = 9;
      const tick = Math.floor(t * 8.5);
      const col = tick % (cols + 2);
      const row = Math.floor(tick / (cols + 2)) % 3;
      const xStep = Math.min(col, cols - 1) / (cols - 1);
      base.gx = -0.5 + xStep * 1.0;
      base.gy = 0.22 + row * 0.1;
      base.tilt = base.gx * 2;
      base.topL = 0.3;
      base.topR = 0.3;
      base.slantL = 8;
      base.slantR = -8;
      base.botL = 0.1;
      base.botR = 0.1;
      base.dilate = 0.96;
      base.cursorBlink = Math.floor(t * 6) % 2 === 0 ? 1 : 0.25;
      return base;
    }

    case "modifie": {
      // Chirurgien du diff : visière laser étroite (paupières haut + bas resserrées) qui compare avant <-> après
      const slot = Math.floor(t / 0.72) % 2;
      base.gx = slot === 0 ? -0.54 : 0.54;
      base.gy = 0.12 + (Math.floor(t / 1.44) % 2) * 0.14;
      base.tilt = base.gx * 2.4;
      base.topL = 0.36;
      base.topR = 0.36;
      base.botL = 0.26;
      base.botR = 0.26;
      base.slantL = 9;
      base.slantR = -9;
      base.dilate = 0.9;
      return base;
    }

    case "commande": {
      // Terminal en cours : yeux ouverts concentrés dans lesquels défilent les lignes de sortie de bas en haut
      base.gx = -0.14 + Math.sin(t * 1.8) * 0.08;
      base.gy = 0.16;
      base.tilt = -1.5;
      base.topL = 0.14;
      base.topR = 0.14;
      base.slantL = 4;
      base.slantR = -4;
      base.scaleYL = 1.05;
      base.scaleYR = 1.05;
      base.dilate = 1.08;
      base.termScroll = (t * 1.55) % 1;
      base.irisPulse = 0.85;
      return base;
    }

    case "tests": {
      // Suite de tests : vérifie 1 -> 2 -> 3 puis esquisse un sourire d'approbation ^ ^ en fin de passe
      const phase = (t / 2.2) % 1;
      if (phase < 0.72) {
        const idx = Math.floor((phase / 0.72) * 3);
        base.gx = (idx - 1) * 0.52;
        base.gy = 0.08;
        base.topL = 0.2;
        base.topR = 0.2;
        base.botL = 0.12;
        base.botR = 0.12;
        base.slantL = 5;
        base.slantR = -5;
      } else {
        const s = Math.sin(((phase - 0.72) / 0.28) * Math.PI);
        base.gx = 0;
        base.gy = -0.08 * s;
        base.smile = s * 0.78;
        base.tilt = -2.5 * s;
      }
      return base;
    }

    case "web": {
      // Exploration web : grands yeux curieux dilatés qui balayent un large horizon
      base.gx = Math.sin(t * 1.15) * 0.76;
      base.gy = Math.sin(t * 2.3) * 0.26 - 0.08;
      base.tilt = base.gx * 3.2;
      base.scaleYL = 1.1;
      base.scaleYR = 1.1;
      base.dilate = 1.24;
      base.irisPulse = 0.88;
      return base;
    }

    case "travaille": {
      // Au travail : sourcils déterminés en V léger, coups d'œil actifs et réguliers
      base.gx = Math.sin(t * 1.5) * 0.45;
      base.gy = 0.1 + Math.cos(t * 1.1) * 0.12;
      base.tilt = base.gx * 2;
      base.topL = 0.24;
      base.topR = 0.24;
      base.slantL = 7;
      base.slantR = -7;
      base.dilate = 1.02;
      return base;
    }

    case "attend": {
      // Attend ta réponse / permission : tête penchée, un œil grand ouvert brillant, l'autre mi-plissé interrogateur
      base.gx = Math.sin(t * 0.85) * 0.14 - 0.08;
      base.gy = -0.1 + Math.cos(t * 0.7) * 0.05;
      base.tilt = -7 + Math.sin(t * 1.2) * 1.2;
      base.topL = 0.28;
      base.slantL = -9;
      base.topR = 0;
      base.scaleYL = 0.88;
      base.scaleYR = 1.1;
      base.dilate = 1.16;
      base.irisPulse = 0.65 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.4));
      return base;
    }

    case "file": {
      // En file d'attente : paupières mi-closes patientes, regard calme posé de côté
      base.gx = -0.34 + Math.sin(t * 0.5) * 0.08;
      base.gy = 0.18;
      base.tilt = -3 + Math.sin(t * 0.6) * 1;
      base.topL = 0.46;
      base.topR = 0.46;
      base.slantL = -4;
      base.slantR = 4;
      base.dilate = 0.92;
      return base;
    }

    case "termine": {
      // Succès : yeux rieurs en arche ^ ^
      base.gx = Math.sin(t * 1.2) * 0.15;
      base.gy = -0.08;
      base.tilt = Math.sin(t * 1.4) * 3.2;
      base.smile = 0.8;
      base.dilate = 1.08;
      base.irisPulse = 0.9;
      return base;
    }

    case "erreur": {
      // Énervé / alerte rouge : sourcils froncés en V agressif (\ /), yeux rouges incandescents et frémissement de rage
      const decay = Math.exp(-(t % 2.8) * 3.2);
      base.jitterX = Math.sin(t * 46) * 2.8 * decay + Math.sin(t * 28) * 0.35;
      base.gx = Math.sin(t * 1.7) * 0.08;
      base.gy = 0.06;
      base.tilt = Math.sin(t * 2.4) * 1.2;
      base.topL = 0.45;
      base.topR = 0.45;
      base.botL = 0.17;
      base.botR = 0.17;
      base.slantL = 24;
      base.slantR = -24;
      base.dilate = 0.9;
      base.irisPulse = 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(t * 6));
      return base;
    }

    case "repos":
      return base;
  }
}

const about = (x: number, y: number, t: string) =>
  `translate(${x} ${y}) ${t} translate(${-x} ${-y})`;

/** Un arrêt de dégradé piloté par une variable CSS pour suivre la palette et le thème */
const Stop = ({ offset, color, opacity }: { offset: number; color: string; opacity?: number }) => (
  <stop offset={offset} style={{ stopColor: `var(--ui-fm-${color})`, stopOpacity: opacity }} />
);

export function FrostMoon({
  phase = "crescent",
  color = "moon",
  look = "frost",
  state = "repos",
  size,
  sparkles = true,
  moonlet = true,
  crown = true,
  background = false,
  followPointer = true,
  className,
  label,
}: FrostMoonProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (name: string) => `fm${uid}-${name}`;
  const geo = GEOMETRY[phase];
  const isFull = phase === "full";
  const isStar = phase === "star";
  const isPlanet = phase === "planet";
  const isChef = phase === "chef";
  const isRound = isFull || isPlanet || isChef;
  const roundRadius = isPlanet ? PLANET_RADIUS : isChef ? CHEF_RADIUS : FULL_RADIUS;
  const isGlow = look === "glow";
  const resolvedLabel =
    label ??
    (isChef
      ? "Un bot chef givré couronné au regard expressif qui réagit à l'état de l'agent"
      : isPlanet
        ? "Une planète givrée à anneau cristallin au regard expressif qui réagit à l'état de l'agent"
        : isStar
          ? "Une étoile givrée au regard expressif qui réagit à l'état de l'agent"
          : isFull
            ? "Une pleine lune givrée au regard expressif qui réagit à l'état de l'agent"
            : "Un croissant de lune givré au regard expressif qui réagit à l'état de l'agent");

  const root = useRef<HTMLDivElement>(null);
  const floatRef = useRef<SVGGElement>(null);
  const turnRef = useRef<SVGGElement>(null);
  const sparkleARef = useRef<SVGGElement>(null);
  const sparkleBRef = useRef<SVGGElement>(null);
  const cratersRef = useRef<SVGGElement>(null);
  const planetBandsRef = useRef<SVGGElement>(null);
  const ringRef = useRef<SVGGElement>(null);
  const ringOccRef = useRef<SVGGElement>(null);
  const moonletRef = useRef<SVGGElement>(null);
  const crownRef = useRef<SVGGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const leftEye = useRef<SVGGElement>(null);
  const rightEye = useRef<SVGGElement>(null);
  const leftTopLid = useRef<SVGEllipseElement>(null);
  const rightTopLid = useRef<SVGEllipseElement>(null);
  const leftBotLid = useRef<SVGEllipseElement>(null);
  const rightBotLid = useRef<SVGEllipseElement>(null);
  const leftSmileLid = useRef<SVGEllipseElement>(null);
  const rightSmileLid = useRef<SVGEllipseElement>(null);
  const leftGlint = useRef<SVGGElement>(null);
  const rightGlint = useRef<SVGGElement>(null);
  const leftSecGlint = useRef<SVGCircleElement>(null);
  const rightSecGlint = useRef<SVGCircleElement>(null);
  const leftTerm = useRef<SVGGElement>(null);
  const rightTerm = useRef<SVGGElement>(null);
  const leftIris = useRef<SVGEllipseElement>(null);
  const rightIris = useRef<SVGEllipseElement>(null);
  const shineRef = useRef<SVGGElement>(null);
  const shadowRef = useRef<SVGEllipseElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const g0 = GEOMETRY[phase];

    const gaze = { x: 0, y: 0, vx: 0, vy: 0 };
    const target = { x: 0, y: 0 };
    const idleGoal = { tilt: 0, topL: 0, topR: 0, slantL: 0, slantR: 0 };
    const expr = {
      tilt: 0,
      topL: 0,
      topR: 0,
      slantL: 0,
      slantR: 0,
      botL: 0,
      botR: 0,
      smile: 0,
      dilate: 1,
      scaleYL: 1,
      scaleYR: 1,
      irisPulse: 0.72,
    };
    const squish = { p: 0, v: 0 };

    let pointer = false;
    let nextGlance = 1.0;
    let nextBlink = 1.8;
    let blinkAt = -1;
    let blinkTwice = false;
    let winkAt = -1;
    let smileBurstAt = -1;
    let clickCount = 0;
    let frame = 0;
    let last = 0;
    let time = still ? 1.1 : 0;
    let orbitAngle = -0.36;

    const blinkScale = (since: number, length = 0.15) =>
      since < 0 || since > length ? 1 : 1 - 0.92 * Math.sin((since / length) * Math.PI);

    const smilePulse = (since: number, length = 0.68) =>
      since < 0 || since > length ? 0 : Math.sin((since / length) * Math.PI) * 0.8;

    const currentGoal = (t: number): EyePose => {
      if (pointer) {
        const angry = state === "erreur";
        return {
          gx: target.x,
          gy: target.y,
          tilt: target.x * 3.5,
          topL: angry ? 0.43 : 0,
          topR: angry ? 0.43 : 0,
          slantL: angry ? 24 : 0,
          slantR: angry ? -24 : 0,
          botL: angry ? 0.16 : 0,
          botR: angry ? 0.16 : 0,
          smile: state === "termine" ? 0.65 : 0,
          dilate: angry ? 0.92 : 1.14,
          scaleYL: angry ? 1 : 1.04,
          scaleYR: angry ? 1 : 1.04,
          irisPulse: angry ? 0.95 : 0.85,
          termScroll: 0,
          cursorBlink: 0,
          jitterX: angry ? Math.sin(t * 28) * 0.35 : 0,
        };
      }
      if (state === "repos") {
        return {
          gx: target.x,
          gy: target.y,
          tilt: idleGoal.tilt,
          topL: idleGoal.topL,
          topR: idleGoal.topR,
          slantL: idleGoal.slantL,
          slantR: idleGoal.slantR,
          botL: 0,
          botR: 0,
          smile: 0,
          dilate: 1,
          scaleYL: 1,
          scaleYR: 1,
          irisPulse: 0.72,
          termScroll: 0,
          cursorBlink: 0,
          jitterX: 0,
        };
      }
      return computeEyePose(state, t);
    };

    const draw = (poseNow: EyePose) => {
      const speed = state === "file" ? 0.72 : state === "termine" ? 1.3 : 1.05;
      const float = still ? 0 : Math.sin(time * speed) * 5;
      const breathe = still ? 0 : Math.sin(time * speed + Math.PI / 2) * 0.012;
      const sy = 1 + breathe - squish.p * 0.12;
      const sx = 1 - breathe + squish.p * 0.1;
      floatRef.current?.setAttribute(
        "transform",
        `translate(${poseNow.jitterX.toFixed(2)} ${float.toFixed(2)}) ${about(g0.cx, g0.bottom, `scale(${sx.toFixed(4)} ${sy.toFixed(4)})`)}`,
      );

      const starBias =
        phase === "star"
          ? (state === "erreur" ? 0 : -3.2) + (still ? 0 : Math.sin(time * speed * 0.5) * 1.4)
          : 0;
      const totalRot = gaze.x * 2.6 + expr.tilt + starBias;
      turnRef.current?.setAttribute(
        "transform",
        `translate(${(gaze.x * 4).toFixed(2)} ${(gaze.y * 2).toFixed(2)}) ${about(g0.cx, g0.cy, `rotate(${totalRot.toFixed(2)}) scale(${(1 - Math.abs(gaze.x) * 0.025).toFixed(4)} 1)`)}`,
      );

      if (phase === "star") {
        const lively =
          state === "demarre" ||
          state === "pense" ||
          state === "web" ||
          state === "tests" ||
          state === "termine";
        const twRate = lively ? 3.2 : 1.6;
        const twA = still ? 1 : 0.92 + Math.sin(time * twRate) * (lively ? 0.16 : 0.08);
        const twB = still ? 1 : 0.92 + Math.cos(time * twRate * 1.15) * (lively ? 0.18 : 0.09);
        const bobA = still ? 0 : Math.cos(time * speed * 1.3) * 2.8;
        const bobB = still ? 0 : Math.sin(time * speed * 1.2 + 1.4) * 2.4;
        sparkleARef.current?.setAttribute(
          "transform",
          `translate(${(192 - gaze.x * 3.4).toFixed(2)} ${(64 + bobA - gaze.y * 2.4).toFixed(2)}) rotate(${(12 + (twA - 1) * 28).toFixed(2)}) scale(${twA.toFixed(3)})`,
        );
        sparkleBRef.current?.setAttribute(
          "transform",
          `translate(${(49 - gaze.x * 2.6).toFixed(2)} ${(156 + bobB - gaze.y * 2).toFixed(2)}) rotate(${(-14 - (twB - 1) * 28).toFixed(2)}) scale(${twB.toFixed(3)})`,
        );
      }

      if (phase === "planet") {
        const wobble = still ? 0 : Math.sin(time * speed * 0.65) * 1.4;
        const ringRot = RING_ROT + gaze.x * 3.2 - expr.tilt * 0.45 + wobble;
        const ringScaleY = Math.max(0.84, Math.min(1.16, 1 + gaze.y * 0.08));
        ringRef.current?.setAttribute(
          "transform",
          `translate(${g0.cx} ${RING_CY}) rotate(${ringRot.toFixed(2)}) scale(1 ${ringScaleY.toFixed(4)})`,
        );
        ringOccRef.current?.setAttribute(
          "transform",
          `scale(1 ${(1 / ringScaleY).toFixed(4)}) rotate(${(-ringRot).toFixed(2)}) translate(0 ${PLANET_CY - RING_CY})`,
        );
        planetBandsRef.current?.setAttribute(
          "transform",
          `translate(${(gaze.x * 4.5).toFixed(2)} ${(gaze.y * 2.4).toFixed(2)})`,
        );
        const mx = 80.5 * Math.cos(orbitAngle);
        const my = 21.6 * Math.sin(orbitAngle);
        const depthScale = 0.92 + 0.12 * Math.sin(orbitAngle);
        moonletRef.current?.setAttribute(
          "transform",
          `translate(${mx.toFixed(2)} ${my.toFixed(2)}) scale(${depthScale.toFixed(3)})`,
        );
      }

      if (phase === "chef") {
        const hover = still ? 0 : Math.sin(time * speed * 1.35 - 0.6) * 2.4;
        const pop = expr.smile * 3.8 + squish.p * 7.5;
        const angryTilt = state === "erreur" ? -5 + (still ? 0 : Math.sin(time * 34) * 1.8) : 0;
        const crownRot = -3.5 + gaze.x * 4.2 + expr.tilt * 0.4 + angryTilt;
        crownRef.current?.setAttribute(
          "transform",
          `translate(${(g0.cx + gaze.x * 3.2).toFixed(2)} ${(CROWN_Y + hover - pop + gaze.y * 1.6).toFixed(2)}) rotate(${crownRot.toFixed(2)})`,
        );
      }

      const cornerPinch =
        phase === "crescent" && gaze.x > 0 && gaze.y < 0 ? gaze.x * -gaze.y * 0.28 : 0;
      const eyeDx = gaze.x * (g0.gazeX - cornerPinch * 3);
      const eyeDy = gaze.y * (g0.gazeY - cornerPinch * 2);
      eyesRef.current?.setAttribute(
        "transform",
        `translate(${eyeDx.toFixed(2)} ${eyeDy.toFixed(2)})`,
      );
      cratersRef.current?.setAttribute(
        "transform",
        `translate(${(gaze.x * 6).toFixed(2)} ${(gaze.y * 3.5).toFixed(2)})`,
      );
      shineRef.current?.setAttribute(
        "transform",
        `translate(${(-gaze.x * 6.8).toFixed(2)} ${(-gaze.y * 3.2).toFixed(2)})`,
      );

      const both =
        blinkAt < 0
          ? 1
          : Math.min(
              blinkScale(time - blinkAt),
              blinkTwice ? blinkScale(time - blinkAt - 0.25) : 1,
            );
      const wink = blinkScale(time - winkAt, 0.32);
      const activeSmile = Math.max(expr.smile, smilePulse(time - smileBurstAt));

      const { y, w, h, left, right } = g0.eyes;
      const eyeY = y + h / 2;
      const leftForeshorten = gaze.x < 0 ? 1 + gaze.x * 0.14 : 1 + gaze.x * 0.03;
      const rightForeshorten = gaze.x > 0 ? 1 - gaze.x * 0.14 : 1 - gaze.x * 0.03;

      leftEye.current?.setAttribute(
        "transform",
        about(
          left + w / 2,
          eyeY,
          `scale(${leftForeshorten.toFixed(3)} ${(both * expr.scaleYL).toFixed(3)})`,
        ),
      );
      rightEye.current?.setAttribute(
        "transform",
        about(
          right + w / 2,
          eyeY,
          `scale(${rightForeshorten.toFixed(3)} ${(Math.min(both, wink) * expr.scaleYR).toFixed(3)})`,
        ),
      );

      const setUpperLid = (
        lidEl: SVGEllipseElement | null,
        cxEye: number,
        amount: number,
        slant: number,
      ) => {
        if (!lidEl) return;
        const drop = amount * (h * 0.58);
        const cyLid = y - h * 0.62 + drop;
        lidEl.setAttribute("cy", cyLid.toFixed(2));
        lidEl.setAttribute("opacity", amount > 0.005 ? "1" : "0");
        lidEl.setAttribute(
          "transform",
          `rotate(${slant.toFixed(2)} ${cxEye} ${(y + drop).toFixed(2)})`,
        );
      };
      setUpperLid(leftTopLid.current, left + w / 2, expr.topL, expr.slantL);
      setUpperLid(rightTopLid.current, right + w / 2, expr.topR, expr.slantR);

      const setBottomLid = (lidEl: SVGEllipseElement | null, amount: number) => {
        if (!lidEl) return;
        const rise = amount * (h * 0.52);
        lidEl.setAttribute("cy", (y + h + h * 0.62 - rise).toFixed(2));
        lidEl.setAttribute("opacity", amount > 0.005 ? "1" : "0");
      };
      setBottomLid(leftBotLid.current, expr.botL);
      setBottomLid(rightBotLid.current, expr.botR);

      const smileCy = y + h + h * 0.46 - activeSmile * (h * 0.64);
      for (const sEl of [leftSmileLid.current, rightSmileLid.current]) {
        sEl?.setAttribute("cy", smileCy.toFixed(2));
        sEl?.setAttribute("opacity", activeSmile > 0.01 ? "1" : "0");
      }

      // Parallaxe cornéenne + compensation verticale quand les paupières froncent (`erreur`, `modifie`)
      const lidDrop = Math.max(0, (expr.topL + expr.topR) * 0.5 - (expr.botL + expr.botR) * 0.35);
      const glintDx = gaze.x * 2.5;
      const glintDy = gaze.y * 1.9 - activeSmile * 4 + lidDrop * 9;
      const showTerm = !pointer && state === "commande";
      const glintOpacity = showTerm ? 0.2 : Math.max(0.08, 1 - activeSmile * 0.82);
      for (const gEl of [leftGlint.current, rightGlint.current]) {
        gEl?.setAttribute(
          "transform",
          `translate(${glintDx.toFixed(2)} ${glintDy.toFixed(2)}) scale(${expr.dilate.toFixed(3)})`,
        );
        gEl?.setAttribute("opacity", glintOpacity.toFixed(3));
      }
      const secOpacity = poseNow.cursorBlink > 0 ? poseNow.cursorBlink : isGlow ? 0.45 : 0.58;
      const secRadius = poseNow.cursorBlink > 0.5 ? 1.85 : 1.35;
      for (const cEl of [leftSecGlint.current, rightSecGlint.current]) {
        cEl?.setAttribute("opacity", secOpacity.toFixed(2));
        cEl?.setAttribute("r", secRadius.toFixed(2));
      }

      const termOffset = -poseNow.termScroll * 18;
      for (const tEl of [leftTerm.current, rightTerm.current]) {
        tEl?.setAttribute("opacity", showTerm ? "0.72" : "0");
        tEl?.setAttribute("transform", `translate(0 ${termOffset.toFixed(2)})`);
      }

      for (const iEl of [leftIris.current, rightIris.current]) {
        iEl?.setAttribute(
          "transform",
          `translate(${(gaze.x * 1.6).toFixed(2)} ${(gaze.y * 0.8).toFixed(2)})`,
        );
        iEl?.setAttribute("opacity", expr.irisPulse.toFixed(2));
      }

      const lift = (float + 5) / 10;
      shadowRef.current?.setAttribute(
        "transform",
        about(g0.cx, 210, `scale(${(1 - lift * 0.13).toFixed(3)} 1)`),
      );
      shadowRef.current?.setAttribute("opacity", (0.36 - lift * 0.1).toFixed(3));
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      time += dt;
      if (phase === "planet" && !still) {
        const fastOrbit =
          state === "web" ||
          state === "cherche" ||
          state === "commande" ||
          state === "tests" ||
          state === "termine";
        orbitAngle += dt * (state === "file" ? 0.25 : fastOrbit ? 0.92 : 0.46);
      }

      if (!pointer && state === "repos" && time > nextGlance) {
        const p = IDLE_POSES[Math.floor(Math.random() * IDLE_POSES.length)];
        if (p) {
          target.x = p.x;
          target.y = p.y;
          idleGoal.tilt = p.tilt;
          idleGoal.topL = p.lidL;
          idleGoal.topR = p.lidR;
          idleGoal.slantL = p.slantL;
          idleGoal.slantR = p.slantR;
        }
        nextGlance = time + 1.3 + Math.random() * 2.2;
      }

      const goal = currentGoal(time);

      if (time > nextBlink && state !== "termine" && goal.smile < 0.2) {
        blinkAt = time;
        blinkTwice = state !== "file" && Math.random() < 0.26;
        nextBlink =
          time + (state === "file" ? 1.8 + Math.random() * 1.8 : 2.4 + Math.random() * 3.1);
      }

      // Ressorts adaptés à l'action : saccades franches en fouille/lecture/diff, souples sinon
      const snappy =
        state === "cherche" || state === "lit" || state === "ecrit" || state === "modifie";
      const gazeStiff = snappy ? 155 : 85;
      const gazeDamp = snappy ? 19 : 14;
      gaze.vx += ((goal.gx - gaze.x) * gazeStiff - gaze.vx * gazeDamp) * dt;
      gaze.vy += ((goal.gy - gaze.y) * gazeStiff - gaze.vy * gazeDamp) * dt;
      gaze.x += gaze.vx * dt;
      gaze.y += gaze.vy * dt;

      const lerp = 1 - Math.exp(-11 * dt);
      expr.tilt += (goal.tilt - expr.tilt) * lerp;
      expr.topL += (goal.topL - expr.topL) * lerp;
      expr.topR += (goal.topR - expr.topR) * lerp;
      expr.slantL += (goal.slantL - expr.slantL) * lerp;
      expr.slantR += (goal.slantR - expr.slantR) * lerp;
      expr.botL += (goal.botL - expr.botL) * lerp;
      expr.botR += (goal.botR - expr.botR) * lerp;
      expr.smile += (goal.smile - expr.smile) * lerp;
      expr.dilate += (goal.dilate - expr.dilate) * lerp;
      expr.scaleYL += (goal.scaleYL - expr.scaleYL) * lerp;
      expr.scaleYR += (goal.scaleYR - expr.scaleYR) * lerp;
      expr.irisPulse += (goal.irisPulse - expr.irisPulse) * lerp;

      squish.v += (-squish.p * 220 - squish.v * 9) * dt;
      squish.p += squish.v * dt;

      draw(goal);
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frame || still) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const initPose = currentGoal(time);
    gaze.x = initPose.gx;
    gaze.y = initPose.gy;
    expr.tilt = initPose.tilt;
    expr.topL = initPose.topL;
    expr.topR = initPose.topR;
    expr.slantL = initPose.slantL;
    expr.slantR = initPose.slantR;
    expr.botL = initPose.botL;
    expr.botR = initPose.botR;
    expr.smile = initPose.smile;
    expr.dilate = initPose.dilate;
    expr.scaleYL = initPose.scaleYL;
    expr.scaleYR = initPose.scaleYR;
    expr.irisPulse = initPose.irisPulse;

    const io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([e]) => (e?.isIntersecting ? start() : stop()))
        : null;
    if (io) io.observe(el);
    else start();

    const onMove = (e: PointerEvent) => {
      if (!followPointer) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      pointer = true;
      target.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2.4));
      target.y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2.4));
    };
    const onLeave = () => {
      pointer = false;
      if (state === "repos") {
        target.x = 0;
        target.y = 0;
        idleGoal.tilt = 0;
        idleGoal.topL = 0;
        idleGoal.topR = 0;
        idleGoal.slantL = 0;
        idleGoal.slantR = 0;
        nextGlance = time + 1.1;
      }
    };
    const onDown = () => {
      squish.p = 0.92;
      squish.v = 0;
      clickCount += 1;
      if (clickCount % 2 === 1 && state !== "termine") {
        smileBurstAt = time + 0.04;
      } else {
        winkAt = time + 0.1;
      }
      if (still) {
        cancelAnimationFrame(frame);
        last = 0;
        frame = requestAnimationFrame(tick);
        window.setTimeout(stop, 1200);
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    draw(initPose);

    return () => {
      stop();
      io?.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
    };
  }, [followPointer, phase, state]);

  const eye = (
    x: number,
    ref: typeof leftEye,
    topLidRef: typeof leftTopLid,
    botLidRef: typeof leftBotLid,
    smileLidRef: typeof leftSmileLid,
    glintRef: typeof leftGlint,
    secGlintRef: typeof leftSecGlint,
    termRef: typeof leftTerm,
    irisRef: typeof leftIris,
    side: string,
  ) => {
    const { y, w, h } = geo.eyes;
    const cx = x + w / 2;
    const pill = { x, y, width: w, height: h, rx: w / 2 };
    const glintX = x + w * 0.34;
    const glintY = y + h * 0.28;
    const dotX = x + w * 0.68;
    const dotY = y + h * 0.72;

    return (
      <g ref={ref}>
        <mask
          id={id(`eye-mask-${side}`)}
          maskUnits="userSpaceOnUse"
          x={x - 10}
          y={y - 10}
          width={w + 20}
          height={h + 20}
        >
          <rect {...pill} fill="#fff" />
          <ellipse
            ref={topLidRef}
            cx={cx}
            cy={y - h * 0.62}
            rx={w * 1.48}
            ry={h * 0.7}
            fill="#000"
            opacity="0"
          />
          <ellipse
            ref={botLidRef}
            cx={cx}
            cy={y + h + h * 0.62}
            rx={w * 1.38}
            ry={h * 0.68}
            fill="#000"
            opacity="0"
          />
          <ellipse
            ref={smileLidRef}
            cx={cx}
            cy={y + h + h * 0.46}
            rx={w * 0.88}
            ry={h * 0.52}
            fill="#000"
            opacity="0"
          />
        </mask>

        <ellipse
          cx={cx}
          cy={y + h * 0.54}
          rx={w * 0.76}
          ry={h * 0.48}
          className="ui-fm__eye-aura"
          filter={`url(#${id("shade")})`}
        />

        <g mask={`url(#${id(`eye-mask-${side}`)})`}>
          {!isGlow && (
            <rect
              {...pill}
              x={x - 1.5}
              y={y - 1}
              width={w + 3}
              height={h + 3}
              rx={w / 2 + 1.5}
              className="ui-fm__eye-drop"
              filter={`url(#${id("edge")})`}
            />
          )}
          <rect {...pill} fill={`url(#${id("hole")})`} />
          <ellipse
            ref={irisRef}
            cx={cx}
            cy={y + h - 4}
            rx={w * 0.46}
            ry={6.5}
            className="ui-fm__iris-glow"
            filter={`url(#${id("crater")})`}
          />
          {/* Reflet de lignes de terminal qui défilent pendant `commande` */}
          <g ref={termRef} opacity="0">
            {[0, 6, 12, 18, 24, 30].map((rowOffset, idx) => (
              <rect
                key={idx}
                x={x + 3.5}
                y={y + 6 + rowOffset}
                width={idx % 2 === 0 ? w - 7 : w - 10}
                height="2"
                rx="1"
                className="ui-fm__eye-glint"
              />
            ))}
          </g>
          <rect
            {...pill}
            y={y + 2.2}
            className="ui-fm__eye-shade"
            fill="none"
            strokeWidth="4.8"
            filter={`url(#${id("edge")})`}
          />
          <g ref={glintRef} style={{ transformOrigin: `${glintX}px ${glintY}px` }}>
            <ellipse
              cx={glintX}
              cy={glintY}
              rx={2.6}
              ry={3.9}
              transform={`rotate(-16 ${glintX} ${glintY})`}
              className="ui-fm__eye-glint"
              opacity={isGlow ? "0.75" : "0.92"}
            />
            <circle
              ref={secGlintRef}
              cx={dotX}
              cy={dotY}
              r={1.35}
              className="ui-fm__eye-glint"
              opacity={isGlow ? "0.45" : "0.58"}
            />
          </g>
        </g>
      </g>
    );
  };

  return (
    <div
      ref={root}
      className={["ui-fm", className].filter(Boolean).join(" ")}
      style={size !== undefined ? { width: size, height: size, flex: "none" } : undefined}
      data-bg={background || undefined}
      data-color={color}
      data-phase={phase}
      data-look={look}
      data-state={state}
      role="img"
      aria-label={resolvedLabel}
    >
      {/* React 19 hisse ce bloc <style> une seule fois dans <head> */}
      <style href="ui-frost-moon" precedence="default">
        {css}
      </style>
      <svg viewBox="0 0 240 240" aria-hidden="true">
        <defs>
          <filter
            id={id("soft")}
            x="-130"
            y="-130"
            width="380"
            height="380"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation={isGlow ? "7.5" : isPlanet ? "10" : "11"} />
          </filter>
          <filter
            id={id("halo")}
            x="-130"
            y="-130"
            width="380"
            height="380"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="10.5" />
          </filter>
          <filter
            id={id("edge")}
            x="-130"
            y="-130"
            width="380"
            height="380"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
          <filter
            id={id("crater")}
            x="-30"
            y="-30"
            width="300"
            height="300"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
          <filter
            id={id("shade")}
            x="-130"
            y="-130"
            width="380"
            height="380"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="5" />
          </filter>
          {isRound ? (
            <circle id={id("shape")} cx={geo.cx} cy={geo.cy} r={roundRadius} />
          ) : (
            <path id={id("shape")} d={isStar ? STAR : CRESCENT} />
          )}
          <mask id={id("mask")} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="240">
            <use href={`#${id("shape")}`} fill="#fff" />
          </mask>
          {isChef && (
            <>
              <path id={id("crown-shape")} d={CHEF_CROWN} />
              <mask
                id={id("crown-mask")}
                maskUnits="userSpaceOnUse"
                x="-60"
                y="-40"
                width="120"
                height="80"
              >
                <use href={`#${id("crown-shape")}`} fill="#fff" />
              </mask>
              <linearGradient
                id={id("crown-grad")}
                x1="-22"
                y1="-18"
                x2="26"
                y2="18"
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset={0} color="white" />
                <Stop offset={0.34} color={isGlow ? "glow-3" : "frost-mid"} />
                <Stop offset={1} color={isGlow ? "glow-2" : "frost"} />
              </linearGradient>
            </>
          )}
          {isPlanet && (
            <>
              <path id={id("ring-shape")} d={PLANET_RING} fillRule="evenodd" />
              <clipPath id={id("ring-back")}>
                <rect x="-130" y="-120" width="260" height="120" />
              </clipPath>
              <mask
                id={id("ring-3d")}
                maskUnits="userSpaceOnUse"
                x="-130"
                y="-120"
                width="260"
                height="240"
              >
                <rect x="-130" y="-120" width="260" height="240" fill="#fff" />
                <g clipPath={`url(#${id("ring-back")})`}>
                  <g
                    ref={ringOccRef}
                    transform={`rotate(${-RING_ROT}) translate(0 ${PLANET_CY - RING_CY})`}
                  >
                    <circle cx="0" cy="0" r={PLANET_RADIUS + 0.4} fill="#000" />
                  </g>
                </g>
              </mask>
              <mask
                id={id("ring-fill")}
                maskUnits="userSpaceOnUse"
                x="-130"
                y="-120"
                width="260"
                height="240"
              >
                <use href={`#${id("ring-shape")}`} fill="#fff" />
              </mask>
              <linearGradient
                id={id("ring-grad")}
                x1="-95"
                y1="-22"
                x2="90"
                y2="24"
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset={0} color="white" />
                <Stop offset={0.24} color={isGlow ? "glow-3" : "frost-mid"} />
                <Stop offset={0.72} color={isGlow ? "glow-2" : "frost"} opacity={0.96} />
                <Stop offset={1} color={isGlow ? "glow-1" : "frost"} opacity={0.98} />
              </linearGradient>
            </>
          )}
          <linearGradient
            id={id("frost")}
            x1="88"
            y1={isChef ? "68" : isPlanet ? "54" : "44"}
            x2={isPlanet || isChef ? "142" : "132"}
            y2={isChef ? "194" : isPlanet ? "180" : "192"}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset={0} color="white" />
            <Stop offset={0.44} color="frost-mid" />
            <Stop offset={1} color="frost" opacity={0.98} />
          </linearGradient>
          <linearGradient id={id("sparkle")} x1="0" y1="0" x2="1" y2="1">
            <Stop offset={0} color="white" />
            <Stop offset={0.46} color={isGlow ? "glow-3" : "frost-mid"} />
            <Stop offset={1} color={isGlow ? "glow-2" : "frost"} />
          </linearGradient>
          <radialGradient
            id={id("glow-body")}
            cx={geo.cx}
            cy={isChef ? "122" : "108"}
            r={isPlanet ? "64" : isChef ? "68" : "78"}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset={0} color="glow-1" />
            <Stop offset={0.62} color="glow-2" />
            <Stop offset={1} color="glow-3" />
          </radialGradient>
          <linearGradient id={id("hole")} x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} color="hole-1" />
            <Stop offset={0.65} color="hole-2" />
            <Stop offset={1} color="hole-3" />
          </linearGradient>
        </defs>

        <ellipse
          ref={shadowRef}
          className="ui-fm__shadow"
          cx={geo.cx}
          cy="210"
          rx={geo.shadowRx}
          ry="7"
          filter={`url(#${id("shade")})`}
        />

        <g ref={floatRef}>
          {isStar && sparkles && (
            <g className="ui-fm__sparkles">
              <g ref={sparkleARef} transform="translate(192 64) rotate(12)">
                <path d={SPARKLE_LG} className="ui-fm__halo" filter={`url(#${id("edge")})`} />
                <path d={SPARKLE_LG} className="ui-fm__edge" filter={`url(#${id("edge")})`} />
                <path d={SPARKLE_LG} fill={`url(#${id("sparkle")})`} />
              </g>
              <g ref={sparkleBRef} transform="translate(49 156) rotate(-14)">
                <path d={SPARKLE_SM} className="ui-fm__halo" filter={`url(#${id("edge")})`} />
                <path d={SPARKLE_SM} className="ui-fm__edge" filter={`url(#${id("edge")})`} />
                <path d={SPARKLE_SM} fill={`url(#${id("sparkle")})`} />
              </g>
            </g>
          )}
          <g ref={turnRef}>
            <use href={`#${id("shape")}`} className="ui-fm__halo" filter={`url(#${id("halo")})`} />
            <use href={`#${id("shape")}`} className="ui-fm__edge" filter={`url(#${id("edge")})`} />
            <g mask={`url(#${id("mask")})`}>
              <rect width="240" height="240" fill={`url(#${id("frost")})`} />
              {isGlow ? (
                <g
                  filter={`url(#${id("soft")})`}
                  fill={`url(#${id("glow-body")})`}
                  transform={`translate(0 2) ${about(geo.cx, geo.cy, "scale(0.9 0.87)")}`}
                >
                  {isRound ? (
                    <circle cx={geo.cx} cy={geo.cy} r={roundRadius} />
                  ) : (
                    <path d={isStar ? STAR : CRESCENT} />
                  )}
                </g>
              ) : (
                <g
                  filter={`url(#${id("soft")})`}
                  className="ui-fm__tint"
                  transform={`translate(${isStar || isPlanet || isChef ? -5 : -6} ${isPlanet ? 12 : isStar || isChef ? 14 : 16}) ${about(geo.cx, geo.cy, "scale(0.84 0.81)")}`}
                >
                  {isRound ? (
                    <circle cx={geo.cx} cy={geo.cy} r={roundRadius} />
                  ) : (
                    <path d={isStar ? STAR : CRESCENT} />
                  )}
                </g>
              )}
              {isChef && crown && (
                <ellipse
                  cx={geo.cx}
                  cy="79"
                  rx="22"
                  ry="4.5"
                  className="ui-fm__crater"
                  opacity="0.72"
                  filter={`url(#${id("shade")})`}
                />
              )}
              {isPlanet && (
                <g ref={planetBandsRef}>
                  <g transform={`translate(${geo.cx} ${RING_CY}) rotate(${RING_ROT})`}>
                    <path
                      d="M-60 -24 Q0 -16 60 -24"
                      fill="none"
                      className="ui-fm__crater-shade"
                      strokeWidth="5.5"
                      strokeLinecap="round"
                      opacity="0.38"
                      filter={`url(#${id("edge")})`}
                    />
                    <path
                      d="M-64 20 A68 18 0 0 0 64 20"
                      fill="none"
                      className="ui-fm__crater-shade"
                      strokeWidth="8"
                      opacity="0.52"
                      filter={`url(#${id("shade")})`}
                    />
                  </g>
                </g>
              )}
              {isFull && (
                <g ref={cratersRef}>
                  {CRATERS.map((c, idx) => (
                    <g key={idx} transform={`translate(${c.cx} ${c.cy}) rotate(${c.rot})`}>
                      <clipPath id={id(`cr-${idx}`)}>
                        <ellipse cx="0" cy="0" rx={c.rx} ry={c.ry} />
                      </clipPath>
                      <ellipse
                        cx="1.2"
                        cy="1.6"
                        rx={c.rx}
                        ry={c.ry}
                        fill="none"
                        stroke="#fff"
                        strokeWidth="2.2"
                        opacity={isGlow ? "0.55" : "0.85"}
                        filter={`url(#${id("crater")})`}
                      />
                      <ellipse
                        cx="0"
                        cy="0"
                        rx={c.rx}
                        ry={c.ry}
                        className="ui-fm__crater"
                        opacity="0.9"
                      />
                      <ellipse
                        cx="1.6"
                        cy="2"
                        rx={c.rx}
                        ry={c.ry}
                        fill="none"
                        className="ui-fm__crater-shade"
                        strokeWidth="3.2"
                        opacity="0.85"
                        filter={`url(#${id("crater")})`}
                        clipPath={`url(#${id(`cr-${idx}`)})`}
                      />
                    </g>
                  ))}
                </g>
              )}
              <g ref={shineRef}>
                <ellipse
                  cx={geo.shine.cx}
                  cy={geo.shine.cy}
                  rx={geo.shine.rx}
                  ry={geo.shine.ry}
                  transform={`rotate(${geo.shine.rot} ${geo.shine.cx} ${geo.shine.cy})`}
                  fill="#fff"
                  opacity={isGlow ? "0.4" : "0.88"}
                  filter={`url(#${id("shade")})`}
                />
                {isStar && (
                  <ellipse
                    cx="76"
                    cy="109"
                    rx="14"
                    ry="6.5"
                    transform="rotate(-12 76 109)"
                    fill="#fff"
                    opacity={isGlow ? "0.26" : "0.64"}
                    filter={`url(#${id("shade")})`}
                  />
                )}
              </g>
            </g>
            <g ref={eyesRef}>
              {eye(
                geo.eyes.left,
                leftEye,
                leftTopLid,
                leftBotLid,
                leftSmileLid,
                leftGlint,
                leftSecGlint,
                leftTerm,
                leftIris,
                "l",
              )}
              {eye(
                geo.eyes.right,
                rightEye,
                rightTopLid,
                rightBotLid,
                rightSmileLid,
                rightGlint,
                rightSecGlint,
                rightTerm,
                rightIris,
                "r",
              )}
            </g>
            {isChef && crown && (
              <g
                ref={crownRef}
                className="ui-fm__crown"
                transform={`translate(${geo.cx} ${CROWN_Y}) rotate(-3.5)`}
              >
                <use
                  href={`#${id("crown-shape")}`}
                  className="ui-fm__halo"
                  opacity="0.86"
                  filter={`url(#${id("halo")})`}
                />
                <use
                  href={`#${id("crown-shape")}`}
                  className="ui-fm__edge"
                  filter={`url(#${id("edge")})`}
                />
                <g mask={`url(#${id("crown-mask")})`}>
                  <rect x="-42" y="-28" width="84" height="50" fill={`url(#${id("crown-grad")})`} />
                  <path
                    d={CHEF_BAND}
                    fill="none"
                    className="ui-fm__crater-shade"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    opacity="0.4"
                    filter={`url(#${id("edge")})`}
                  />
                  <ellipse
                    cx="-10"
                    cy="-6"
                    rx="14"
                    ry="6"
                    transform="rotate(-16 -10 -6)"
                    fill="#fff"
                    opacity="0.82"
                    filter={`url(#${id("shade")})`}
                  />
                </g>
                <circle
                  cx="0"
                  cy="-21.5"
                  r="4.2"
                  className="ui-fm__halo"
                  filter={`url(#${id("edge")})`}
                />
                <circle
                  cx="0"
                  cy="-21.5"
                  r="3.8"
                  className="ui-fm__edge"
                  filter={`url(#${id("edge")})`}
                />
                <circle cx="0" cy="-21.5" r="3.5" fill={`url(#${id("crown-grad")})`} />
                <circle cx="-1" cy="-22.6" r="1.2" fill="#fff" opacity="0.92" />
                <circle
                  cx="-26.5"
                  cy="-14.5"
                  r="2.8"
                  className="ui-fm__edge"
                  filter={`url(#${id("edge")})`}
                />
                <circle cx="-26.5" cy="-14.5" r="2.5" fill={`url(#${id("crown-grad")})`} />
                <circle
                  cx="26.5"
                  cy="-14.5"
                  r="2.8"
                  className="ui-fm__edge"
                  filter={`url(#${id("edge")})`}
                />
                <circle cx="26.5" cy="-14.5" r="2.5" fill={`url(#${id("crown-grad")})`} />
                <circle cx="0" cy="4" r="3.1" fill={`url(#${id("hole")})`} opacity="0.9" />
                <circle cx="-0.9" cy="3.1" r="1" fill="#fff" opacity="0.9" />
              </g>
            )}
            {isPlanet && (
              <g
                ref={ringRef}
                className="ui-fm__ring"
                transform={`translate(${geo.cx} ${RING_CY}) rotate(${RING_ROT})`}
              >
                <g mask={`url(#${id("ring-3d")})`}>
                  <use
                    href={`#${id("ring-shape")}`}
                    className="ui-fm__halo"
                    opacity="0.76"
                    filter={`url(#${id("shade")})`}
                  />
                  <use
                    href={`#${id("ring-shape")}`}
                    className="ui-fm__edge"
                    filter={`url(#${id("edge")})`}
                  />
                  <g mask={`url(#${id("ring-fill")})`}>
                    <rect
                      x="-110"
                      y="-40"
                      width="220"
                      height="80"
                      fill={`url(#${id("ring-grad")})`}
                      opacity="0.93"
                    />
                    <ellipse
                      cx="0"
                      cy="0"
                      rx="79.5"
                      ry="21.2"
                      fill="none"
                      className="ui-fm__crater-shade"
                      strokeWidth="1.8"
                      opacity="0.45"
                      filter={`url(#${id("edge")})`}
                    />
                    <ellipse
                      cx="0"
                      cy="0"
                      rx="81"
                      ry="21.8"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="1.4"
                      opacity="0.72"
                    />
                    <ellipse
                      cx="-76"
                      cy="-2"
                      rx="16"
                      ry="6"
                      transform="rotate(-12 -76 -2)"
                      fill="#fff"
                      opacity="0.82"
                      filter={`url(#${id("shade")})`}
                    />
                  </g>
                  {moonlet && (
                    <g ref={moonletRef} className="ui-fm__moonlet" transform="translate(75.3 -7.6)">
                      <circle
                        cx="0"
                        cy="0"
                        r="6.2"
                        className="ui-fm__halo"
                        filter={`url(#${id("edge")})`}
                      />
                      <circle
                        cx="0"
                        cy="0"
                        r="5.6"
                        className="ui-fm__edge"
                        filter={`url(#${id("edge")})`}
                      />
                      <circle cx="0" cy="0" r="5.3" fill={`url(#${id("sparkle")})`} />
                      <circle cx="-1.6" cy="-1.8" r="1.7" fill="#fff" opacity="0.9" />
                    </g>
                  )}
                </g>
              </g>
            )}
          </g>
        </g>
      </svg>
    </div>
  );
}

/** Variante prête à l'emploi pour afficher directement la pleine lune givrée sans tuile */
export function FrostFullMoon(props: Omit<FrostMoonProps, "phase">) {
  return <FrostMoon {...props} phase="full" />;
}

/** Mascotte étoile givrée prête à l'emploi (partage les 9 teintes et les 15 états d'yeux) */
export function FrostStar(props: Omit<FrostMoonProps, "phase">) {
  return <FrostMoon {...props} phase="star" />;
}

/** Mascotte planète givrée à anneau cristallin 3D incliné et lune satellite en orbite */
export function FrostPlanet(props: Omit<FrostMoonProps, "phase">) {
  return <FrostMoon {...props} phase="planet" />;
}

/** Mascotte Chef / Coordinateur givré coiffé d'une couronne cristalline flottante */
export function FrostChef(props: Omit<FrostMoonProps, "phase">) {
  return <FrostMoon {...props} phase="chef" />;
}

/* ---------- Styles ---------- */

const darkOverrides = (scope: string) => /* css */ `
${scope} .ui-fm {
  --ui-fm-sky-top: #1b2e94;
  --ui-fm-sky-bottom: #3d63de;
  --ui-fm-sky-light: rgba(131, 158, 255, 0.45);
  --ui-fm-ground: rgba(8, 18, 90, 0.52);
}
${scope} .ui-fm[data-color="blue"] {
  --ui-fm-sky-top: #1659c8;
  --ui-fm-sky-bottom: #2aa6e6;
  --ui-fm-sky-light: rgba(90, 205, 255, 0.45);
  --ui-fm-ground: rgba(5, 50, 140, 0.5);
}
${scope} .ui-fm[data-color="orange"] {
  --ui-fm-sky-top: #bf2722;
  --ui-fm-sky-bottom: #ed701d;
  --ui-fm-sky-light: rgba(255, 175, 120, 0.42);
  --ui-fm-ground: rgba(110, 15, 5, 0.5);
}
${scope} .ui-fm[data-color="emerald"] {
  --ui-fm-sky-top: #065f46;
  --ui-fm-sky-bottom: #10b981;
  --ui-fm-sky-light: rgba(110, 245, 195, 0.44);
  --ui-fm-ground: rgba(4, 55, 38, 0.5);
}
${scope} .ui-fm[data-color="violet"] {
  --ui-fm-sky-top: #4c1d95;
  --ui-fm-sky-bottom: #8b5cf6;
  --ui-fm-sky-light: rgba(196, 165, 255, 0.45);
  --ui-fm-ground: rgba(45, 12, 95, 0.52);
}
${scope} .ui-fm[data-color="rose"] {
  --ui-fm-sky-top: #9d174d;
  --ui-fm-sky-bottom: #ec4899;
  --ui-fm-sky-light: rgba(255, 170, 215, 0.44);
  --ui-fm-ground: rgba(85, 10, 42, 0.5);
}
${scope} .ui-fm[data-color="gold"] {
  --ui-fm-sky-top: #92400e;
  --ui-fm-sky-bottom: #eab308;
  --ui-fm-sky-light: rgba(254, 230, 138, 0.45);
  --ui-fm-ground: rgba(85, 38, 5, 0.5);
}
${scope} .ui-fm[data-color="crimson"] {
  --ui-fm-sky-top: #881337;
  --ui-fm-sky-bottom: #e11d48;
  --ui-fm-sky-light: rgba(255, 150, 168, 0.44);
  --ui-fm-ground: rgba(78, 8, 25, 0.52);
}
${scope} .ui-fm[data-color="silver"] {
  --ui-fm-sky-top: #1e293b;
  --ui-fm-sky-bottom: #475569;
  --ui-fm-sky-light: rgba(203, 213, 225, 0.42);
  --ui-fm-ground: rgba(15, 23, 42, 0.55);
}
${scope} .ui-fm:not([data-bg]) {
  --ui-fm-halo: rgba(105, 138, 255, 0.42);
  --ui-fm-edge: rgba(175, 198, 255, 0.48);
  --ui-fm-shadow: rgba(85, 115, 255, 0.38);
}
${scope} .ui-fm[data-color="blue"]:not([data-bg]) {
  --ui-fm-halo: rgba(45, 178, 255, 0.42);
  --ui-fm-edge: rgba(155, 222, 255, 0.48);
  --ui-fm-shadow: rgba(35, 155, 255, 0.38);
}
${scope} .ui-fm[data-color="orange"]:not([data-bg]) {
  --ui-fm-halo: rgba(255, 118, 65, 0.42);
  --ui-fm-edge: rgba(255, 190, 155, 0.48);
  --ui-fm-shadow: rgba(240, 95, 45, 0.38);
}
${scope} .ui-fm[data-color="emerald"]:not([data-bg]) {
  --ui-fm-halo: rgba(52, 211, 153, 0.42);
  --ui-fm-edge: rgba(167, 243, 208, 0.48);
  --ui-fm-shadow: rgba(16, 185, 129, 0.38);
}
${scope} .ui-fm[data-color="violet"]:not([data-bg]) {
  --ui-fm-halo: rgba(167, 139, 250, 0.42);
  --ui-fm-edge: rgba(221, 214, 254, 0.48);
  --ui-fm-shadow: rgba(139, 92, 246, 0.38);
}
${scope} .ui-fm[data-color="rose"]:not([data-bg]) {
  --ui-fm-halo: rgba(244, 114, 182, 0.42);
  --ui-fm-edge: rgba(251, 207, 232, 0.48);
  --ui-fm-shadow: rgba(236, 72, 153, 0.38);
}
${scope} .ui-fm[data-color="gold"]:not([data-bg]) {
  --ui-fm-halo: rgba(251, 191, 36, 0.42);
  --ui-fm-edge: rgba(254, 240, 138, 0.48);
  --ui-fm-shadow: rgba(245, 158, 11, 0.38);
}
${scope} .ui-fm[data-color="crimson"]:not([data-bg]) {
  --ui-fm-halo: rgba(251, 113, 133, 0.42);
  --ui-fm-edge: rgba(254, 205, 211, 0.48);
  --ui-fm-shadow: rgba(244, 63, 94, 0.38);
}
${scope} .ui-fm[data-color="silver"]:not([data-bg]) {
  --ui-fm-halo: rgba(203, 213, 225, 0.38);
  --ui-fm-edge: rgba(241, 245, 249, 0.46);
  --ui-fm-shadow: rgba(148, 163, 184, 0.34);
}
`;

const css = /* css */ `
/* Sans tuile par défaut : 9 teintes de cristal givré (moon, blue, orange, emerald, violet, rose, gold, crimson, silver) */
.ui-fm {
  --ui-fm-sky-top: #2944c4;
  --ui-fm-sky-bottom: #5b87f9;
  --ui-fm-sky-light: rgba(168, 198, 255, 0.55);
  --ui-fm-white: #ffffff;
  --ui-fm-frost-mid: #d3dfff;
  --ui-fm-frost: #86a0ff;
  --ui-fm-tint: rgba(52, 84, 230, 0.42);
  --ui-fm-glow-1: #3b5bdb;
  --ui-fm-glow-2: #5576f6;
  --ui-fm-glow-3: #8ea7ff;
  --ui-fm-crater: rgba(52, 82, 222, 0.22);
  --ui-fm-crater-shade: rgba(25, 48, 172, 0.3);
  --ui-fm-hole-1: #16288f;
  --ui-fm-hole-2: #3b5bdb;
  --ui-fm-hole-3: #789aff;
  --ui-fm-iris-glow: #a8c2ff;
  --ui-fm-eye-glint: #ffffff;
  --ui-fm-eye-drop: rgba(255, 255, 255, 0.65);
  --ui-fm-eye-shade: rgba(8, 16, 85, 0.42);
  --ui-fm-halo: rgba(72, 106, 248, 0.32);
  --ui-fm-edge: rgba(58, 85, 214, 0.52);
  --ui-fm-shadow: rgba(35, 62, 185, 0.52);
  --ui-fm-ground: rgba(16, 34, 130, 0.42);
}
:where(.ui-fm) {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ui-fm[data-color="blue"] {
  --ui-fm-sky-top: #2475ea;
  --ui-fm-sky-bottom: #4ac8f5;
  --ui-fm-sky-light: rgba(110, 225, 255, 0.55);
  --ui-fm-frost-mid: #c8eeff;
  --ui-fm-frost: #6cd0ff;
  --ui-fm-tint: rgba(16, 142, 238, 0.4);
  --ui-fm-glow-1: #06a3ff;
  --ui-fm-glow-2: #1cb4ff;
  --ui-fm-glow-3: #64d2ff;
  --ui-fm-crater: rgba(18, 132, 225, 0.21);
  --ui-fm-crater-shade: rgba(8, 88, 185, 0.28);
  --ui-fm-hole-1: #0952a8;
  --ui-fm-hole-2: #1686ea;
  --ui-fm-hole-3: #5cd0ff;
  --ui-fm-iris-glow: #9ce6ff;
  --ui-fm-eye-shade: rgba(5, 48, 120, 0.4);
  --ui-fm-halo: rgba(32, 162, 255, 0.32);
  --ui-fm-edge: rgba(20, 125, 240, 0.5);
  --ui-fm-shadow: rgba(10, 95, 205, 0.52);
  --ui-fm-ground: rgba(10, 80, 190, 0.4);
}
.ui-fm[data-color="orange"] {
  --ui-fm-sky-top: #e94135;
  --ui-fm-sky-bottom: #fa9842;
  --ui-fm-sky-light: rgba(255, 205, 150, 0.5);
  --ui-fm-frost-mid: #ffddc8;
  --ui-fm-frost: #ff9d64;
  --ui-fm-tint: rgba(236, 86, 42, 0.38);
  --ui-fm-glow-1: #f24f30;
  --ui-fm-glow-2: #fa7340;
  --ui-fm-glow-3: #ffb272;
  --ui-fm-crater: rgba(220, 80, 38, 0.2);
  --ui-fm-crater-shade: rgba(175, 44, 16, 0.28);
  --ui-fm-hole-1: #9e210d;
  --ui-fm-hole-2: #e04826;
  --ui-fm-hole-3: #ff9852;
  --ui-fm-iris-glow: #ffc89e;
  --ui-fm-eye-shade: rgba(105, 18, 5, 0.4);
  --ui-fm-halo: rgba(248, 102, 52, 0.32);
  --ui-fm-edge: rgba(225, 80, 40, 0.5);
  --ui-fm-shadow: rgba(180, 55, 20, 0.5);
  --ui-fm-ground: rgba(150, 30, 10, 0.36);
}
.ui-fm[data-color="emerald"] {
  --ui-fm-sky-top: #059669;
  --ui-fm-sky-bottom: #34d399;
  --ui-fm-sky-light: rgba(167, 243, 208, 0.52);
  --ui-fm-frost-mid: #c6f9e4;
  --ui-fm-frost: #5ee3b0;
  --ui-fm-tint: rgba(12, 158, 108, 0.4);
  --ui-fm-glow-1: #059669;
  --ui-fm-glow-2: #10b981;
  --ui-fm-glow-3: #6ee7b7;
  --ui-fm-crater: rgba(10, 145, 98, 0.21);
  --ui-fm-crater-shade: rgba(6, 95, 68, 0.28);
  --ui-fm-hole-1: #064e3b;
  --ui-fm-hole-2: #0d9468;
  --ui-fm-hole-3: #34d399;
  --ui-fm-iris-glow: #99f6d4;
  --ui-fm-eye-shade: rgba(4, 65, 45, 0.4);
  --ui-fm-halo: rgba(16, 185, 129, 0.32);
  --ui-fm-edge: rgba(13, 148, 104, 0.5);
  --ui-fm-shadow: rgba(6, 115, 78, 0.5);
  --ui-fm-ground: rgba(4, 80, 55, 0.4);
}
.ui-fm[data-color="violet"] {
  --ui-fm-sky-top: #6d28d9;
  --ui-fm-sky-bottom: #a855f7;
  --ui-fm-sky-light: rgba(221, 214, 254, 0.52);
  --ui-fm-frost-mid: #e6d6ff;
  --ui-fm-frost: #b48aff;
  --ui-fm-tint: rgba(124, 58, 237, 0.4);
  --ui-fm-glow-1: #6d28d9;
  --ui-fm-glow-2: #8b5cf6;
  --ui-fm-glow-3: #c4a5ff;
  --ui-fm-crater: rgba(115, 52, 228, 0.21);
  --ui-fm-crater-shade: rgba(76, 29, 149, 0.28);
  --ui-fm-hole-1: #3b0764;
  --ui-fm-hole-2: #7c3aed;
  --ui-fm-hole-3: #b78aff;
  --ui-fm-iris-glow: #ddd0ff;
  --ui-fm-eye-shade: rgba(55, 15, 115, 0.42);
  --ui-fm-halo: rgba(139, 92, 246, 0.32);
  --ui-fm-edge: rgba(124, 58, 237, 0.5);
  --ui-fm-shadow: rgba(91, 33, 182, 0.5);
  --ui-fm-ground: rgba(65, 20, 135, 0.42);
}
.ui-fm[data-color="rose"] {
  --ui-fm-sky-top: #be185d;
  --ui-fm-sky-bottom: #f472b6;
  --ui-fm-sky-light: rgba(251, 207, 232, 0.52);
  --ui-fm-frost-mid: #ffd6eb;
  --ui-fm-frost: #fb8cc2;
  --ui-fm-tint: rgba(219, 39, 119, 0.38);
  --ui-fm-glow-1: #db2777;
  --ui-fm-glow-2: #ec4899;
  --ui-fm-glow-3: #f9a8d4;
  --ui-fm-crater: rgba(205, 35, 110, 0.2);
  --ui-fm-crater-shade: rgba(145, 22, 78, 0.28);
  --ui-fm-hole-1: #831843;
  --ui-fm-hole-2: #db2777;
  --ui-fm-hole-3: #f472b6;
  --ui-fm-iris-glow: #fbcfe8;
  --ui-fm-eye-shade: rgba(110, 15, 58, 0.4);
  --ui-fm-halo: rgba(236, 72, 153, 0.3);
  --ui-fm-edge: rgba(219, 39, 119, 0.48);
  --ui-fm-shadow: rgba(175, 28, 95, 0.48);
  --ui-fm-ground: rgba(130, 18, 68, 0.4);
}
.ui-fm[data-color="gold"] {
  --ui-fm-sky-top: #b45309;
  --ui-fm-sky-bottom: #facc15;
  --ui-fm-sky-light: rgba(254, 240, 138, 0.55);
  --ui-fm-frost-mid: #fef0be;
  --ui-fm-frost: #fbcb52;
  --ui-fm-tint: rgba(217, 130, 10, 0.38);
  --ui-fm-glow-1: #d97706;
  --ui-fm-glow-2: #f59e0b;
  --ui-fm-glow-3: #fde068;
  --ui-fm-crater: rgba(202, 120, 8, 0.21);
  --ui-fm-crater-shade: rgba(146, 78, 10, 0.28);
  --ui-fm-hole-1: #713f12;
  --ui-fm-hole-2: #ca7b08;
  --ui-fm-hole-3: #facc15;
  --ui-fm-iris-glow: #fef08a;
  --ui-fm-eye-shade: rgba(105, 52, 8, 0.4);
  --ui-fm-halo: rgba(245, 158, 11, 0.32);
  --ui-fm-edge: rgba(202, 123, 8, 0.5);
  --ui-fm-shadow: rgba(161, 92, 7, 0.48);
  --ui-fm-ground: rgba(120, 62, 6, 0.4);
}
.ui-fm[data-color="crimson"] {
  --ui-fm-sky-top: #be123c;
  --ui-fm-sky-bottom: #fb7185;
  --ui-fm-sky-light: rgba(254, 205, 211, 0.52);
  --ui-fm-frost-mid: #ffd4d8;
  --ui-fm-frost: #ff7a88;
  --ui-fm-tint: rgba(220, 38, 62, 0.4);
  --ui-fm-glow-1: #dc2638;
  --ui-fm-glow-2: #f43f5e;
  --ui-fm-glow-3: #fda4af;
  --ui-fm-crater: rgba(205, 32, 55, 0.21);
  --ui-fm-crater-shade: rgba(145, 18, 38, 0.28);
  --ui-fm-hole-1: #7f1d28;
  --ui-fm-hole-2: #dc2638;
  --ui-fm-hole-3: #fb7185;
  --ui-fm-iris-glow: #fecdd3;
  --ui-fm-eye-shade: rgba(105, 12, 24, 0.42);
  --ui-fm-halo: rgba(244, 63, 94, 0.32);
  --ui-fm-edge: rgba(220, 38, 56, 0.5);
  --ui-fm-shadow: rgba(175, 24, 45, 0.5);
  --ui-fm-ground: rgba(130, 15, 32, 0.42);
}
.ui-fm[data-color="silver"] {
  --ui-fm-sky-top: #334155;
  --ui-fm-sky-bottom: #64748b;
  --ui-fm-sky-light: rgba(226, 232, 240, 0.5);
  --ui-fm-frost-mid: #e6ecf4;
  --ui-fm-frost: #b0bfd4;
  --ui-fm-tint: rgba(71, 85, 105, 0.36);
  --ui-fm-glow-1: #475569;
  --ui-fm-glow-2: #64748b;
  --ui-fm-glow-3: #cbd5e1;
  --ui-fm-crater: rgba(71, 85, 105, 0.2);
  --ui-fm-crater-shade: rgba(30, 41, 59, 0.26);
  --ui-fm-hole-1: #1e293b;
  --ui-fm-hole-2: #475569;
  --ui-fm-hole-3: #94a3b8;
  --ui-fm-iris-glow: #cbd5e1;
  --ui-fm-eye-shade: rgba(15, 23, 42, 0.38);
  --ui-fm-halo: rgba(100, 116, 139, 0.3);
  --ui-fm-edge: rgba(71, 85, 105, 0.48);
  --ui-fm-shadow: rgba(51, 65, 85, 0.45);
  --ui-fm-ground: rgba(30, 41, 59, 0.42);
}

/* Variante "glow" : cœur coloré saturé bordé d'un givre blanc lumineux et yeux blancs givrés */
.ui-fm[data-look="glow"] {
  --ui-fm-frost-mid: #f4f6ff;
  --ui-fm-frost: #eef2ff;
  --ui-fm-hole-1: #ffffff;
  --ui-fm-hole-2: #e6ecff;
  --ui-fm-hole-3: #c7d6ff;
  --ui-fm-iris-glow: #ffffff;
  --ui-fm-eye-glint: #3b5bdb;
  --ui-fm-eye-shade: rgba(35, 62, 185, 0.34);
  --ui-fm-crater: rgba(255, 255, 255, 0.24);
  --ui-fm-crater-shade: rgba(35, 62, 185, 0.32);
}
.ui-fm[data-look="glow"][data-color="blue"] {
  --ui-fm-frost-mid: #f2fbff;
  --ui-fm-frost: #ecf8ff;
  --ui-fm-hole-2: #dff5ff;
  --ui-fm-hole-3: #b8e8ff;
  --ui-fm-eye-glint: #0a8cf0;
  --ui-fm-eye-shade: rgba(15, 120, 215, 0.32);
  --ui-fm-crater-shade: rgba(15, 120, 215, 0.3);
}
.ui-fm[data-look="glow"][data-color="orange"] {
  --ui-fm-frost-mid: #fff8f4;
  --ui-fm-frost: #fff4ec;
  --ui-fm-hole-2: #ffede0;
  --ui-fm-hole-3: #ffd4b8;
  --ui-fm-eye-glint: #eb4d2c;
  --ui-fm-eye-shade: rgba(215, 75, 35, 0.32);
  --ui-fm-crater-shade: rgba(215, 75, 35, 0.3);
}
.ui-fm[data-look="glow"][data-color="emerald"] {
  --ui-fm-frost-mid: #f0fdf8;
  --ui-fm-frost: #e6f9f1;
  --ui-fm-hole-2: #d1fae5;
  --ui-fm-hole-3: #a7f3d0;
  --ui-fm-eye-glint: #059669;
  --ui-fm-eye-shade: rgba(6, 115, 78, 0.32);
  --ui-fm-crater-shade: rgba(6, 115, 78, 0.3);
}
.ui-fm[data-look="glow"][data-color="violet"] {
  --ui-fm-frost-mid: #faf5ff;
  --ui-fm-frost: #f3ebff;
  --ui-fm-hole-2: #ede9fe;
  --ui-fm-hole-3: #ddd6fe;
  --ui-fm-eye-glint: #7c3aed;
  --ui-fm-eye-shade: rgba(91, 33, 182, 0.32);
  --ui-fm-crater-shade: rgba(91, 33, 182, 0.3);
}
.ui-fm[data-look="glow"][data-color="rose"] {
  --ui-fm-frost-mid: #fff5f9;
  --ui-fm-frost: #fcecf4;
  --ui-fm-hole-2: #fce7f3;
  --ui-fm-hole-3: #fbcfe8;
  --ui-fm-eye-glint: #db2777;
  --ui-fm-eye-shade: rgba(175, 28, 95, 0.32);
  --ui-fm-crater-shade: rgba(175, 28, 95, 0.3);
}
.ui-fm[data-look="glow"][data-color="gold"] {
  --ui-fm-frost-mid: #fffdf2;
  --ui-fm-frost: #fef9df;
  --ui-fm-hole-2: #fef3c7;
  --ui-fm-hole-3: #fde68a;
  --ui-fm-eye-glint: #ca7b08;
  --ui-fm-eye-shade: rgba(161, 92, 7, 0.32);
  --ui-fm-crater-shade: rgba(161, 92, 7, 0.3);
}
.ui-fm[data-look="glow"][data-color="crimson"] {
  --ui-fm-frost-mid: #fff5f6;
  --ui-fm-frost: #feecef;
  --ui-fm-hole-2: #ffe4e6;
  --ui-fm-hole-3: #fecdd3;
  --ui-fm-eye-glint: #dc2638;
  --ui-fm-eye-shade: rgba(175, 24, 45, 0.32);
  --ui-fm-crater-shade: rgba(175, 24, 45, 0.3);
}
.ui-fm[data-look="glow"][data-color="silver"] {
  --ui-fm-frost-mid: #f8fafc;
  --ui-fm-frost: #f1f5f9;
  --ui-fm-hole-2: #e2e8f0;
  --ui-fm-hole-3: #cbd5e1;
  --ui-fm-eye-glint: #475569;
  --ui-fm-eye-shade: rgba(51, 65, 85, 0.32);
  --ui-fm-crater-shade: rgba(51, 65, 85, 0.3);
}

/* État erreur : yeux rouges incandescents et halo rubis énervé quelle que soit la couleur ou le look */
.ui-fm[data-state="erreur"],
.ui-fm[data-look="glow"][data-state="erreur"] {
  --ui-fm-hole-1: #45050c;
  --ui-fm-hole-2: #dc2626;
  --ui-fm-hole-3: #ff5460;
  --ui-fm-iris-glow: #ff9aa2;
  --ui-fm-eye-glint: #ffffff;
  --ui-fm-eye-drop: rgba(255, 64, 78, 0.72);
  --ui-fm-eye-shade: rgba(69, 5, 12, 0.55);
  --ui-fm-eye-aura: rgba(239, 35, 60, 0.52);
}

.ui-fm svg { display: block; width: 100%; height: 100%; max-width: 320px; max-height: 320px; overflow: visible; }
.ui-fm__halo { fill: var(--ui-fm-halo); }
.ui-fm__edge { fill: var(--ui-fm-edge); }
.ui-fm__shadow { fill: var(--ui-fm-shadow); }
.ui-fm__tint { fill: var(--ui-fm-tint); }
.ui-fm__crater { fill: var(--ui-fm-crater); }
.ui-fm__crater-shade { stroke: var(--ui-fm-crater-shade); }
.ui-fm__eye-aura { fill: var(--ui-fm-eye-aura, transparent); }
.ui-fm__eye-drop { fill: var(--ui-fm-eye-drop); }
.ui-fm__eye-shade { stroke: var(--ui-fm-eye-shade); }
.ui-fm__iris-glow { fill: var(--ui-fm-iris-glow); }
.ui-fm__eye-glint { fill: var(--ui-fm-eye-glint); }

/* Tuile optionnelle si background={true} est demandé explicitement */
.ui-fm[data-bg] {
  --ui-fm-halo: rgba(255, 255, 255, 0.75);
  --ui-fm-edge: rgba(255, 255, 255, 0.5);
  --ui-fm-shadow: var(--ui-fm-ground);
  background:
    radial-gradient(60% 55% at 62% 42%, var(--ui-fm-sky-light), transparent 70%),
    linear-gradient(180deg, var(--ui-fm-sky-top), var(--ui-fm-sky-bottom));
}

${darkOverrides(':where(.dark, [data-theme="dark"])')}
@media (prefers-color-scheme: dark) {
  ${darkOverrides(':where(:root:not([data-theme="light"]):not(.light))')}
}
`;
