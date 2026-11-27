/**
 * `<moon-mascot>`: the moon that stands for an agent, drawn on a canvas.
 *
 * Breezydev's own design (moon-mascot.js), kept as it was drawn: the same outlines, lighting,
 * craters and eyes. Typed for the app, and its expression comes from what the agent really
 * does (see mascot.ts), never from a demo picker.
 *
 * Attributes: `shape` (crescent, full, orb), `color` (ice, violet, pink, mint, amber,
 * silver), `expression` (idle, reading, coding, review, error, testing, success) and
 * `label`, read aloud for the button that makes it wink.
 */

type Rgb = [number, number, number];
type Crater = [x: number, y: number, rx: number, ry: number, opacity: number];

interface Shape {
  outline: Path2D;
  eyes: [number, number];
  faceY: number;
  frostX: number;
  craters: Crater[];
  maria?: [x: number, y: number, radius: number][];
  polished?: boolean;
}

interface Palette {
  tint: Rgb;
  shade: Rgb;
  glow: Rgb;
  light: [Rgb, Rgb];
}

interface Face {
  symbol?: "code" | "error" | "dot" | "smile";
  lookX?: number;
  lookY?: number;
  left?: number;
  right?: number;
  liftLeft?: number;
  liftRight?: number;
  angleLeft?: number;
  angleRight?: number;
  stretch?: number;
}

interface Surface {
  texture: HTMLCanvasElement;
  glow: HTMLCanvasElement;
}

const size = 420;
let shapes: Map<string, Shape> | undefined;
let eyePaths: Record<NonNullable<Face["symbol"]>, Path2D> | undefined;
let crescent: Path2D | undefined;

/** Path2D exists only in a browser: the outlines are made on first use. */
function geometry() {
  if (shapes && eyePaths && crescent) return { shapes, eyePaths, crescent };
  crescent = new Path2D(
    "M243 43 C161 43 85 95 66 169 C44 252 91 333 168 357 " +
      "C241 380 315 352 352 292 Q355 287 350 290 " +
      "C311 309 267 304 231 281 C183 250 159 202 165 151 " +
      "C170 106 198 68 244 46 Q249 43 243 43 Z",
  );
  const fullMoon = new Path2D();
  fullMoon.arc(210, 207, 152, 0, Math.PI * 2);
  const orb = new Path2D();
  orb.arc(210, 212, 143, 0, Math.PI * 2);
  shapes = new Map<string, Shape>([
    [
      "crescent",
      {
        outline: crescent,
        eyes: [109, 142],
        faceY: 230,
        frostX: 139,
        craters: [
          [116, 145, 10, 7, 0.12],
          [135, 120, 4, 3, 0.09],
          [139, 292, 13, 9, 0.14],
          [165, 313, 5, 4, 0.12],
          [262, 332, 8, 4, 0.13],
        ],
      },
    ],
    [
      "full",
      {
        outline: fullMoon,
        eyes: [187, 233],
        faceY: 206,
        frostX: 204,
        maria: [
          [153, 155, 57],
          [240, 123, 52],
          [277, 256, 72],
          [171, 284, 40],
        ],
        craters: [
          [141, 135, 23, 18, 0.22],
          [185, 96, 8, 6, 0.13],
          [226, 125, 16, 10, 0.17],
          [281, 127, 25, 20, 0.2],
          [309, 161, 8, 6, 0.18],
          [121, 190, 9, 7, 0.13],
          [100, 229, 12, 9, 0.14],
          [141, 265, 24, 21, 0.25],
          [169, 294, 9, 6, 0.13],
          [222, 314, 24, 15, 0.2],
          [250, 284, 8, 7, 0.14],
          [301, 250, 19, 16, 0.2],
          [280, 219, 8, 6, 0.14],
          [303, 296, 6, 4, 0.12],
          [198, 334, 7, 4, 0.14],
        ],
      },
    ],
    [
      "orb",
      { outline: orb, eyes: [187, 233], faceY: 206, frostX: 207, craters: [], polished: true },
    ],
  ]);
  const dot = new Path2D();
  dot.arc(0, 0, 12, 0, Math.PI * 2);
  eyePaths = {
    code: new Path2D(
      "M2 -17 Q5 -21 8 -18 Q12 -15 8 -11 L-2 0 L8 11 " +
        "Q12 15 8 18 Q5 21 2 17 L-12 3 Q-15 0 -12 -3 Z",
    ),
    error: new Path2D(
      "M-13 -10 Q-17 -14 -13 -17 Q-10 -20 -6 -15 L0 -7 L6 -15 " +
        "Q10 -20 13 -17 Q17 -14 13 -10 L5 0 L13 10 Q17 14 13 17 " +
        "Q10 20 6 15 L0 7 L-6 15 Q-10 20 -13 17 Q-17 14 -13 10 L-5 0 Z",
    ),
    dot,
    smile: new Path2D(
      "M-17 5 C-14 -8 -7 -14 0 -14 C7 -14 14 -8 17 5 " +
        "Q18 10 13 11 Q9 11 8 6 C6 0 3 -3 0 -3 C-3 -3 -6 0 -8 6 " +
        "Q-9 11 -13 11 Q-18 10 -17 5 Z",
    ),
  };
  return { shapes, eyePaths, crescent };
}

const palettes = new Map<string, Palette>([
  [
    "ice",
    {
      tint: [33, 14, 2],
      shade: [8, 87, 148],
      glow: [212, 248, 255],
      light: [
        [51, 143, 226],
        [76, 191, 233],
      ],
    },
  ],
  [
    "violet",
    {
      tint: [26, 43, 2],
      shade: [66, 35, 145],
      glow: [225, 209, 255],
      light: [
        [121, 87, 208],
        [177, 149, 233],
      ],
    },
  ],
  [
    "pink",
    {
      tint: [1, 45, 22],
      shade: [135, 29, 87],
      glow: [255, 213, 235],
      light: [
        [190, 81, 148],
        [238, 151, 185],
      ],
    },
  ],
  [
    "mint",
    {
      tint: [39, 1, 22],
      shade: [5, 105, 91],
      glow: [197, 255, 232],
      light: [
        [39, 146, 150],
        [98, 207, 187],
      ],
    },
  ],
  [
    "amber",
    {
      tint: [1, 32, 58],
      shade: [148, 58, 17],
      glow: [255, 230, 188],
      light: [
        [209, 101, 45],
        [241, 169, 95],
      ],
    },
  ],
  [
    "silver",
    {
      tint: [28, 18, 11],
      shade: [42, 61, 86],
      glow: [232, 245, 255],
      light: [
        [99, 121, 149],
        [162, 186, 208],
      ],
    },
  ],
]);

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const rgba = (rgb: readonly number[], alpha: number) => `rgba(${rgb.join(", ")}, ${alpha})`;
const surfaces = new Map<string, Surface>();

function readExpression(name: string, seconds: number, reduced: boolean): Face {
  switch (name) {
    case "reading": {
      const line = (seconds % 1.7) / 1.7;
      const scan = 2 * Math.min(1, line / 0.86) - 1;
      return { lookX: reduced ? 1 : scan * 9, lookY: 10, left: 0.64, right: 0.72 };
    }
    case "coding":
      return { symbol: "code", lookY: -1, stretch: 1 + Math.sin(seconds * 5.8) * 0.07 };
    case "review":
      return {
        lookX: 6,
        left: 0.39,
        right: 0.88,
        liftLeft: 2,
        liftRight: -5,
        angleLeft: -0.23,
        angleRight: 0.19,
      };
    case "error":
      return { symbol: "error", lookY: 2 };
    case "testing": {
      const pulse = reduced ? 0 : Math.sin(seconds * 5.4) * 0.19;
      return { symbol: "dot", left: 0.96 + pulse, right: 0.74 - pulse, lookY: 3 };
    }
    case "success":
      return { symbol: "smile", lookY: -3 };
    default:
      return {};
  }
}

/**
 * Draws the moon once per shape, colour and scale: at 2 for a large moon, at 1 (a quarter
 * of the pixels to work through) for one shown at 420 device pixels or less.
 */
function renderSurface(
  shape: Shape,
  palette: Palette,
  crescentPath: Path2D,
  scale: 1 | 2,
): Surface {
  const { outline, craters, frostX, maria, polished } = shape;
  const { tint, shade, glow: glowColor } = palette;
  const texture = document.createElement("canvas");
  const width = size * scale;
  texture.width = texture.height = width;
  const context = texture.getContext("2d")!;
  context.scale(scale, scale);
  context.fill(outline);

  const pixels = context.getImageData(0, 0, width, width);
  const data = pixels.data;
  const distance = new Float32Array(width * width);
  for (let index = 0; index < distance.length; index++) {
    distance[index] = data[index * 4 + 3]! > 128 ? width : 0;
  }
  const d = (index: number) => distance[index]!;
  // Distance from the nearest edge gives all three silhouettes the same frosted rim.
  for (let y = 1; y < width - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      distance[index] = Math.min(
        d(index),
        d(index - 1) + 1,
        d(index - width) + 1,
        d(index - width - 1) + Math.SQRT2,
        d(index - width + 1) + Math.SQRT2,
      );
    }
  }
  for (let y = width - 2; y > 0; y--) {
    for (let x = width - 2; x > 0; x--) {
      const index = y * width + x;
      distance[index] = Math.min(
        d(index),
        d(index + 1) + 1,
        d(index + width) + 1,
        d(index + width - 1) + Math.SQRT2,
        d(index + width + 1) + Math.SQRT2,
      );
    }
  }

  const spherical = outline !== crescentPath;
  // How far apart the bevel's slope is read: 7 units of the drawing, whatever the scale.
  const reach = 7 * scale;
  const radius = polished ? 143 : 152;
  const centerY = polished ? 212 : 207;
  let seed = 7234;
  for (let y = 1; y < width - 1; y++) {
    const transmitted = palette.light[0].map(
      (top, c) => top + (palette.light[1][c]! - top) * (y / (width - 1)),
    );
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const offset = index * 4;
      if (!data[offset + 3]) continue;

      const depth = d(index) / scale;
      const falloff = clamp((y / scale - 83) / 292);
      const pool = Math.exp(-(((x / scale - frostX) / 93) ** 2 + ((y / scale - 241) / 83) ** 2));
      const edge = Math.exp(-depth / 12);
      const cast = 0.46 * falloff + 0.62 * pool;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const grain = (seed / 4294967296 - 0.5) * (polished ? 3 : 7);
      // A sphere has an analytic normal. On the crescent the bevel follows both rims.
      const bevel = Math.exp(-depth / 25);
      let nx = (x / scale - 210) / radius;
      let ny = (y / scale - centerY) / radius;
      if (!spherical) {
        nx = 0.35 * nx + (bevel * (d(index - reach) - d(index + reach))) / (2 * reach);
        ny =
          0.35 * ny + (bevel * (d(index - width * reach) - d(index + width * reach))) / (2 * reach);
      }
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const diffuse = clamp(-0.48 * nx - 0.62 * ny + 0.62 * nz);
      const specular = clamp(-0.34 * nx - 0.43 * ny + 0.836 * nz) ** (polished ? 90 : 32);
      const fresnel = (1 - nz) ** 3;
      const shadow = 0.41 * (1 - diffuse) ** 1.25;
      const frost = clamp(0.96 - 0.18 * falloff - 0.15 * pool + 0.15 * edge + 0.08 * specular);
      for (let channel = 0; channel < 3; channel++) {
        const milk = 252 - tint[channel]! * cast;
        const lit = milk + (shade[channel]! - milk) * shadow;
        const highlight = lit + (255 - lit) * clamp(0.76 * specular + 0.62 * fresnel) + grain;
        data[offset + channel] = highlight * frost + transmitted[channel]! * (1 - frost);
      }
    }
  }
  context.putImageData(pixels, 0, 0);

  context.save();
  context.clip(outline);
  for (const [x, y, r] of maria ?? []) {
    const patch = context.createRadialGradient(x + 8, y - 5, 4, x, y, r);
    patch.addColorStop(0, rgba(shade, 0.17));
    patch.addColorStop(0.56, rgba(shade, 0.11));
    patch.addColorStop(1, rgba(shade, 0));
    context.fillStyle = patch;
    context.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (const [x, y, rx, ry, opacity] of craters) {
    context.save();
    context.translate(x, y);
    context.rotate(-0.38);
    context.scale(rx, ry);
    context.beginPath();
    context.arc(0, 0, 1, 0, Math.PI * 2);
    const bowl = context.createLinearGradient(-0.3, -1, 0.3, 1);
    bowl.addColorStop(0, rgba(shade, opacity * 1.85));
    bowl.addColorStop(0.17, rgba(shade, opacity * 1.1));
    bowl.addColorStop(0.6, rgba(shade, opacity * 0.2));
    bowl.addColorStop(1, `rgba(255, 255, 255, ${opacity})`);
    context.fillStyle = bowl;
    context.fill();
    const lip = context.createLinearGradient(0, -1, 0, 1);
    lip.addColorStop(0, rgba(shade, opacity * 0.45));
    lip.addColorStop(0.48, rgba(glowColor, 0));
    lip.addColorStop(1, rgba([255, 255, 255], opacity * 2.5));
    context.strokeStyle = lip;
    context.lineWidth = 1.8 / rx;
    context.stroke();
    context.restore();
  }
  if (polished) {
    const reflection = context.createRadialGradient(151, 135, 4, 155, 146, 119);
    reflection.addColorStop(0, "rgba(255, 255, 255, .94)");
    reflection.addColorStop(0.44, "rgba(255, 255, 255, .63)");
    reflection.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = reflection;
    context.fill(outline);
  }
  context.restore();

  context.lineWidth = 0.8;
  const rimLight = context.createLinearGradient(84, 55, 304, 360);
  rimLight.addColorStop(0, "rgba(255, 255, 255, .9)");
  rimLight.addColorStop(0.54, rgba(glowColor, 0.56));
  rimLight.addColorStop(1, rgba(glowColor, 0.42));
  context.strokeStyle = rimLight;
  context.stroke(outline);

  const glow = document.createElement("canvas");
  glow.width = glow.height = width;
  const halo = glow.getContext("2d")!;
  halo.scale(scale, scale);
  halo.fillStyle = "#fff";
  halo.shadowColor = rgba(glowColor, 0.9);
  // shadowBlur ignores the transform: it is set in canvas pixels, so it follows the scale.
  halo.shadowBlur = 39 * (scale / 2);
  halo.fill(outline);
  halo.shadowBlur = 0;
  halo.globalCompositeOperation = "destination-out";
  halo.fill(outline);
  return { texture, glow };
}

function drawEye(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  openness: number,
  right: boolean,
  palette: Palette,
  symbol: Face["symbol"],
  angle: number,
  stretch: number,
  lunar: boolean,
) {
  const width = right ? 27 : 25;
  const height = (right ? 44 : 42) * openness;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  if (lunar) {
    // Foreshorten the inner eye where the crescent curves away from the viewer.
    const scale = right ? 0.7 : 0.83;
    context.scale(scale, scale * 0.88);
  }
  const shape = symbol ? geometry().eyePaths[symbol] : new Path2D();
  if (symbol) {
    const facing = symbol === "code" && right ? -1 : 1;
    context.scale(facing * stretch * openness, stretch * openness);
  } else if (lunar) {
    const rx = width / 2;
    const ry = height / 2;
    shape.moveTo(0, -ry);
    shape.bezierCurveTo(rx * 0.86, -ry, rx * 1.12, -ry * 0.32, rx * 0.9, ry * 0.25);
    shape.bezierCurveTo(rx * 0.72, ry * 0.88, rx * 0.34, ry, 0, ry);
    shape.bezierCurveTo(-rx * 0.78, ry, -rx, ry * 0.44, -rx, 0);
    shape.bezierCurveTo(-rx, -ry * 0.57, -rx * 0.7, -ry, 0, -ry);
    shape.closePath();
  } else {
    shape.roundRect(-width / 2, -height / 2, width, height, Math.min(width, height) / 2);
  }
  // Give the recess its own reflected light, independent of the surrounding page.
  const reflected = context.createLinearGradient(0, -height / 2, 0, height / 2);
  reflected.addColorStop(0, rgba(palette.light[0], 1));
  reflected.addColorStop(1, rgba(palette.light[1], 1));
  context.fillStyle = reflected;
  context.fill(shape);
  const innerShade = context.createLinearGradient(-width / 2, -height / 2, width / 2, height / 2);
  innerShade.addColorStop(0, rgba(palette.shade, 0.81));
  innerShade.addColorStop(0.5, rgba(palette.shade, 0.19));
  innerShade.addColorStop(1, rgba(palette.glow, 0.08));
  context.fillStyle = innerShade;
  context.fill(shape);
  const bevel = context.createLinearGradient(0, -height / 2, 0, height / 2);
  bevel.addColorStop(0, rgba(palette.shade, 0.56));
  bevel.addColorStop(0.48, rgba(palette.glow, 0.28));
  bevel.addColorStop(1, "rgba(255, 255, 255, .93)");
  context.lineWidth = 1.7;
  context.strokeStyle = bevel;
  context.stroke(shape);
  context.restore();
}

/** The texture's scale for a canvas of this many device pixels. */
const surfaceScale = (pixels: number): 1 | 2 => (pixels > size ? 2 : 1);

/** How long a moon trusts the place it last read for itself, when nothing told it that it moved. */
const RECT_MS = 200;
const DEFAULT_LABEL = "Faire un clin d’œil à la mascotte";

/**
 * Whether the page can be seen, and how to be told when that changes. The app gives its own
 * (visibility.ts): a desktop window hidden in the tray keeps `document.hidden` false.
 */
export interface PageSight {
  hidden(): boolean;
  watch(listener: () => void): () => void;
}
let sight: PageSight = {
  hidden: () => document.hidden,
  watch(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

class MoonMascot extends HTMLElement {
  static observedAttributes = ["shape", "color", "label", "expression", "decorative", "still"];

  #root: ShadowRoot;
  #canvas: HTMLCanvasElement;
  #context: CanvasRenderingContext2D | null;
  #button: HTMLButtonElement;
  #frame = 0;
  #last = 0;
  #bounds: ResizeObserver | undefined;
  #seen: IntersectionObserver | undefined;
  #unwatch: (() => void) | undefined;
  #visible = true;
  #start = 0;
  #wink = -Infinity;
  /** Where the pointer last was on the page, read against a cached bounding box. */
  #client: { x: number; y: number } | undefined;
  #rect: DOMRect | undefined;
  #rectAt = 0;
  #pointerX = 0;
  #pointerY = 0;
  #gazeX = 0;
  #gazeY = 0;
  #appearance:
    | { geometry: Shape; palette: Palette; surface: Surface; lunar: boolean; scale: 1 | 2 }
    | undefined;
  #expression = "idle";
  #expressionStart = 0;
  #motion = matchMedia("(prefers-reduced-motion: reduce)");

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    this.#root.innerHTML = `
      <style>
        :host { display: block; inline-size: min(100%, 420px); aspect-ratio: 1; }
        button {
          display: block; inline-size: 100%; block-size: 100%; padding: 0;
          border: 0; border-radius: 50%; appearance: none; background: transparent;
          cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
        }
        button:focus-visible { outline: 2px solid #edfbff; outline-offset: 4px; }
        canvas { display: block; inline-size: 100%; block-size: 100%; }
      </style>`;
    this.#canvas = document.createElement("canvas");
    this.#canvas.width = this.#canvas.height = 840;
    this.#canvas.setAttribute("aria-hidden", "true");
    this.#button = document.createElement("button");
    this.#button.type = "button";
    this.#context = this.#canvas.getContext("2d");
    this.#button.addEventListener("click", () => {
      this.#wink = performance.now();
      this.#requestFrame();
    });
  }

  /** A decorative moon (inside another control, say) has no button of its own and ignores the pointer. */
  get #decorative() {
    return this.hasAttribute("decorative");
  }

  /** A still moon is drawn once, as with reduced motion: for a state that is over. */
  get #still() {
    return this.hasAttribute("still") || this.#motion.matches;
  }

  /** Puts the canvas in its button, or alone when decorative, and follows the pointer only when it can wink. */
  #mount() {
    if (this.#decorative) {
      this.#button.remove();
      this.#root.append(this.#canvas);
    } else {
      this.#button.append(this.#canvas);
      this.#root.append(this.#button);
      this.#button.setAttribute("aria-label", this.getAttribute("label") || DEFAULT_LABEL);
    }
    window.removeEventListener("pointermove", this.#track);
    window.removeEventListener("pointerout", this.#leave);
    window.removeEventListener("scroll", this.#invalidateRect, true);
    window.removeEventListener("resize", this.#invalidateRect);
    this.#client = undefined;
    this.#rect = undefined;
    this.#pointerX = this.#pointerY = 0;
    if (!this.#decorative && !this.#still) {
      window.addEventListener("pointermove", this.#track, { passive: true });
      window.addEventListener("pointerout", this.#leave);
      window.addEventListener("scroll", this.#invalidateRect, { capture: true, passive: true });
      window.addEventListener("resize", this.#invalidateRect, { passive: true });
    }
  }

  connectedCallback() {
    if (!this.#context) return;
    this.#expression = this.getAttribute("expression") ?? "idle";
    this.#start = performance.now();
    this.#expressionStart = this.#start;
    this.#mount();
    this.#bounds = new ResizeObserver(this.#measure);
    this.#bounds.observe(this);
    // Off screen or in a page nobody sees, nothing is drawn: the loop starts again when seen.
    this.#seen = new IntersectionObserver(([entry]) => {
      this.#visible = entry?.isIntersecting ?? true;
      this.#rect = undefined;
      this.#requestFrame();
    });
    this.#seen.observe(this);
    this.#unwatch = sight.watch(this.#requestFrame);
    this.#measure();
    this.#motion.addEventListener("change", this.#restyle);
    this.#requestFrame();
  }

  attributeChangedCallback(name: string, previousValue: string | null, value: string | null) {
    if (previousValue === value) return;
    if (name === "label") {
      this.#button.setAttribute("aria-label", value || DEFAULT_LABEL);
      return;
    }
    if (name === "decorative" || name === "still") {
      if (this.isConnected) this.#mount();
    } else if (name === "expression") {
      this.#expression = value ?? "idle";
      this.#expressionStart = performance.now();
    } else {
      this.#appearance = undefined;
    }
    this.#requestFrame();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#bounds?.disconnect();
    this.#seen?.disconnect();
    this.#unwatch?.();
    this.#unwatch = undefined;
    window.removeEventListener("pointermove", this.#track);
    window.removeEventListener("pointerout", this.#leave);
    window.removeEventListener("scroll", this.#invalidateRect, true);
    window.removeEventListener("resize", this.#invalidateRect);
    this.#motion.removeEventListener("change", this.#restyle);
  }

  #restyle = () => {
    this.#mount();
    this.#requestFrame();
  };

  #invalidateRect = () => {
    this.#rect = undefined;
  };

  #measure = () => {
    this.#rect = undefined;
    const pixels = Math.min(840, Math.max(64, Math.round(this.clientWidth * devicePixelRatio)));
    if (this.#canvas.width !== pixels) this.#canvas.width = this.#canvas.height = pixels;
    // A moon that grew past what its texture was drawn for gets a finer one.
    if (this.#appearance && this.#appearance.scale !== surfaceScale(pixels))
      this.#appearance = undefined;
    this.#requestFrame();
  };

  #track = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    this.#client = { x: event.clientX, y: event.clientY };
  };

  #leave = (event: PointerEvent) => {
    if (event.relatedTarget) return;
    this.#client = undefined;
  };

  #requestFrame = () => {
    if (!this.#frame && this.isConnected && this.#context && this.#visible && !sight.hidden()) {
      this.#frame = requestAnimationFrame(this.#draw);
    }
  };

  #getAppearance() {
    const { shapes: all, crescent: crescentPath } = geometry();
    const shape = this.getAttribute("shape") ?? "";
    const color = this.getAttribute("color") ?? "";
    const shapeName = all.has(shape) ? shape : "crescent";
    const paletteName = palettes.has(color) ? color : "ice";
    const scale = surfaceScale(this.#canvas.width);
    const key = `${shapeName}:${paletteName}:${scale}`;
    const geometryOf = all.get(shapeName)!;
    const palette = palettes.get(paletteName)!;
    let surface = surfaces.get(key);
    if (!surface) {
      surface = renderSurface(geometryOf, palette, crescentPath, scale);
      if (surfaces.size >= 6) surfaces.delete(surfaces.keys().next().value!);
      surfaces.set(key, surface);
    }
    return {
      geometry: geometryOf,
      palette,
      surface,
      lunar: geometryOf.outline === crescentPath,
      scale,
    };
  }

  #draw = (now: number) => {
    this.#frame = 0;
    const context = this.#context;
    if (!context) return;
    const reduced = this.#still;
    // At most 60 frames a second, on a 120 or 240 Hz screen too.
    const dt = now - this.#last;
    if (!reduced && dt < 15) {
      this.#requestFrame();
      return;
    }
    this.#last = now;
    if (this.#client) {
      // A moon can move with no scroll or resize to say so (a panel opening beside it, a window
      // sliding): its place is read again a few times a second, not at every frame.
      if (!this.#rect || now - this.#rectAt > RECT_MS) {
        this.#rect = this.getBoundingClientRect();
        this.#rectAt = now;
      }
      const box = this.#rect;
      const range = Math.max(110, box.width * 0.65);
      this.#pointerX = clamp((this.#client.x - box.left - box.width * 0.35) / range, -1, 1);
      this.#pointerY = clamp((this.#client.y - box.top - box.height * 0.48) / range, -1, 1);
    } else {
      this.#pointerX = this.#pointerY = 0;
    }
    const {
      geometry: shape,
      palette,
      surface,
      lunar,
    } = (this.#appearance ??= this.#getAppearance());
    const scale = this.#canvas.width / size;
    const elapsed = now - this.#start;
    const moodTime = reduced ? 0 : Math.max(0, now - this.#expressionStart) / 1000;
    const winkTime = Math.max(0, now - this.#wink);
    const winking = winkTime < 470;
    const bounce = !reduced && winking ? Math.sin((Math.PI * winkTime) / 470) : 0;
    const float = reduced ? 0 : Math.sin(elapsed / 850) * 7;
    const cheer =
      this.#expression === "success" && moodTime < 0.7 ? Math.sin((Math.PI * moodTime) / 0.7) : 0;
    const shake =
      this.#expression === "error" && moodTime < 0.45
        ? Math.sin(moodTime * 43) * (1 - moodTime / 0.45)
        : 0;
    const glance =
      !reduced && this.#pointerX === 0 && this.#pointerY === 0
        ? Math.sin(elapsed / 1100) * Math.max(0, Math.sin(elapsed / 1820)) * 0.48
        : 0;
    // The eyes catch up a tenth of the way every 60th of a second, whatever the frame rate.
    const ease = 1 - 0.9 ** (Math.min(dt, 100) / (1000 / 60));
    this.#gazeX = reduced ? 0 : this.#gazeX + (this.#pointerX - this.#gazeX) * ease;
    this.#gazeY = reduced ? 0 : this.#gazeY + (this.#pointerY - this.#gazeY) * ease;

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, size, size);

    context.save();
    context.translate(
      size / 2 + this.#gazeX * 9 + shake * 6,
      size / 2 + float - bounce * 18 - cheer * 17,
    );
    context.rotate((this.#gazeX + glance) * 0.09 - bounce * 0.07 + shake * 0.055);
    context.scale(1 + bounce * 0.04 + float * 0.001, 1 - bounce * 0.025 + cheer * 0.025);
    context.translate(-size / 2, -size / 2);
    context.drawImage(surface.glow, 0, 0, size, size);
    context.drawImage(surface.texture, 0, 0, size, size);
    // An elongated light reflection slides across the surface as the face turns.
    context.save();
    context.clip(shape.outline);
    context.translate(shape.frostX - 35 - this.#gazeX * 16, 118 - this.#gazeY * 10);
    context.rotate(-0.58);
    context.scale(1, shape.polished ? 0.24 : 0.47);
    const sheen = context.createRadialGradient(0, 0, 0, 0, 0, 68);
    sheen.addColorStop(0, rgba([255, 255, 255], shape.polished ? 0.85 : 0.42));
    sheen.addColorStop(0.52, rgba([255, 255, 255], shape.polished ? 0.61 : 0.17));
    sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = sheen;
    context.fillRect(-68, -68, 136, 136);
    context.restore();

    const blinkPhase = (elapsed + 550) % 4600;
    const blink =
      !reduced && blinkPhase > 4400
        ? 1 - 0.88 * Math.sin((Math.PI * (blinkPhase - 4400)) / 200)
        : 1;
    const wink = reduced ? 0.14 : 1 - 0.87 * Math.sin(Math.PI * Math.min(1, winkTime / 380));
    const face: Face = winking ? {} : readExpression(this.#expression, moodTime, reduced);
    const eyeX = ((this.#gazeX + glance) * 7 + (face.lookX ?? 0)) * (lunar ? 0.72 : 1);
    const eyeY = (this.#gazeY * 5 + (face.lookY ?? 0)) * (lunar ? 0.8 : 1);
    const eyelid = face.symbol ? 1 : blink;
    drawEye(
      context,
      shape.eyes[0] + eyeX,
      shape.faceY + eyeY + (face.liftLeft ?? 0),
      (face.left ?? 1) * eyelid,
      false,
      palette,
      face.symbol,
      (face.angleLeft ?? 0.07) - (lunar ? 0.27 : 0),
      face.stretch ?? 1,
      lunar,
    );
    drawEye(
      context,
      shape.eyes[1] + eyeX,
      shape.faceY + eyeY + (lunar ? 8 : 1) + (face.liftRight ?? 0),
      winking ? wink : (face.right ?? 1) * eyelid,
      true,
      palette,
      face.symbol,
      (face.angleRight ?? 0.07) - (lunar ? 0.19 : 0),
      face.stretch ?? 1,
      lunar,
    );
    context.restore();

    if (!reduced || winking) this.#requestFrame();
  };
}

/** Registers `<moon-mascot>` once, in a browser only. */
export function defineMoonMascot(pageSight?: PageSight): void {
  if (pageSight) sight = pageSight;
  if (typeof customElements === "undefined" || customElements.get("moon-mascot")) return;
  customElements.define("moon-mascot", MoonMascot);
}
