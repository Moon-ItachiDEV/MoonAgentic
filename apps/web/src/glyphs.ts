/**
 * The agent's states drawn in crisp dots, one picture per thing it really does. Each frame
 * is a pure function of the time, so a still frame (reduced motion) is the same drawing.
 */

export type GlyphKind =
  | "pense"
  | "cherche"
  | "lit"
  | "modifie"
  | "commande"
  | "tests"
  | "web"
  | "ecrit"
  | "travaille"
  | "demarre"
  | "attend"
  | "file";

type P3 = [number, number, number];

/** Points spread evenly on a sphere. */
function fibonacci(n: number): P3[] {
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.39996323;
    return [Math.cos(th) * r, y, Math.sin(th) * r];
  });
}

const SPHERE = fibonacci(46);

/** Latitude rings, each point keeping its ring's index. */
const RINGS: { p: P3; ring: number }[] = [];
for (let ring = -2; ring <= 2; ring++) {
  const y = ring / 2.6;
  const r = Math.sqrt(1 - y * y);
  const n = Math.max(6, Math.round(16 * r));
  for (let j = 0; j < n; j++) {
    const a = (j / n) * Math.PI * 2;
    RINGS.push({ p: [Math.cos(a) * r, y, Math.sin(a) * r], ring });
  }
}

/** A globe: meridians and the equator. */
const GLOBE: P3[] = [];
for (let m = 0; m < 6; m++) {
  const a = (m / 6) * Math.PI;
  for (let j = 1; j < 10; j++) {
    const p = (j / 10) * Math.PI;
    const r = Math.sin(p);
    GLOBE.push([Math.cos(a) * r, Math.cos(p), Math.sin(a) * r]);
  }
}
for (let j = 0; j < 14; j++) {
  const a = (j / 14) * Math.PI * 2;
  GLOBE.push([Math.cos(a), 0, Math.sin(a)]);
}

/** A fixed pseudo-random sequence: the same picture on every load. */
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const SWARM = Array.from({ length: 24 }, () => ({
  r: 0.35 + rnd() * 0.6,
  s: (0.6 + rnd()) * (rnd() < 0.5 ? -1 : 1),
  p: rnd() * 6.28,
  tx: rnd() * 3,
  ty: rnd() * 3,
}));
const SCATTER: P3[] = SPHERE.map(() => {
  const a = rnd() * 6.28;
  const b = rnd() * 6.28;
  return [Math.cos(a) * 1.6, Math.sin(a) * Math.cos(b) * 1.6, Math.sin(b)];
});

function rotate([x, y, z]: P3, ay: number, ax: number): P3 {
  const c = Math.cos(ay);
  const s = Math.sin(ay);
  const X = x * c + z * s;
  let Z = -x * s + z * c;
  const c2 = Math.cos(ax);
  const s2 = Math.sin(ax);
  const Y = y * c2 - Z * s2;
  Z = y * s2 + Z * c2;
  return [X, Y, Z];
}

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
/** Front dots bright, back dots faint. */
const depth = (z: number) => 0.18 + (0.82 * (z + 1)) / 2;
/** A stable pseudo-random cell in 0..15 for a step number. */
const cell = (x: number) => {
  const v = Math.sin(x * 12.9898) * 43758.5453;
  return Math.floor((v - Math.floor(v)) * 16);
};

/** Draws one frame of `kind` at time `t` (seconds) on a `size` × `size` CSS-pixel area. */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  kind: GlyphKind,
  t: number,
  size: number,
  color: string,
): void {
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;
  const R = size * 0.42;
  const c = size / 2;
  const base = Math.max(0.8, size * 0.045);
  const dot = (x: number, y: number, alpha: number, scale = 1) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.beginPath();
    ctx.arc(c + x * R, c + y * R, base * scale, 0, Math.PI * 2);
    ctx.fill();
  };

  switch (kind) {
    case "pense":
      for (const p of SPHERE) {
        const [x, y, z] = rotate(p, t * 0.7, 0.45);
        dot(x, y, depth(z), 0.75 + (0.35 * (z + 1)) / 2);
      }
      break;
    case "cherche": {
      const band = Math.sin(t * 1.6) * 2.2;
      for (const { p, ring } of RINGS) {
        const [x, y, z] = rotate(p, t * 0.9, 0.35);
        const hit = Math.max(0, 1 - Math.abs(ring - band) / 1.1);
        dot(x, y, depth(z) * (0.35 + 0.65 * hit), 0.8 + 0.5 * hit);
      }
      break;
    }
    case "web":
      for (const p of GLOBE) {
        const [x, y, z] = rotate(p, t * 1.1, 0.3);
        dot(x, y, depth(z), 0.7 + (0.3 * (z + 1)) / 2);
      }
      break;
    case "lit": {
      const scan = ((t * 0.55) % 1) * 6.5 - 0.75;
      for (let i = 0; i < 5; i++)
        for (let j = 0; j < 5; j++) {
          const hit = Math.max(0, 1 - Math.abs(i - scan));
          dot((j - 2) * 0.42, (i - 2) * 0.42, 0.22 + 0.78 * hit, 0.9 + 0.5 * hit);
        }
      break;
    }
    case "ecrit": {
      const rows = [6, 6, 3];
      const total = 15;
      const step = Math.floor(t * 7) % (total + 5);
      let index = 0;
      rows.forEach((length, r) => {
        for (let j = 0; j < length; j++, index++) {
          const on = index < step;
          dot(-0.9 + j * 0.36, -0.5 + r * 0.5, on ? 0.95 : 0.16, on ? 1.1 : 0.9);
        }
      });
      // The cursor, where the next dot goes.
      let r = 0;
      let j = step;
      while (r < rows.length && j >= rows[r]!) j -= rows[r++]!;
      if (r < rows.length)
        dot(-0.9 + j * 0.36, -0.5 + r * 0.5, Math.floor(t * 4) % 2 ? 1 : 0.3, 1.3);
      break;
    }
    case "modifie": {
      const cycle = t / 0.7;
      const k = Math.floor(cycle);
      const f = ease((cycle - k) / 0.6);
      const a = cell(k);
      let b = cell(k + 0.5);
      if (a === b) b = (b + 5) % 16;
      const at = (i: number) => [((i % 4) - 1.5) * 0.5, (Math.floor(i / 4) - 1.5) * 0.5] as const;
      for (let i = 0; i < 16; i++) {
        let [x, y] = at(i);
        if (i === a || i === b) {
          const [x2, y2] = at(i === a ? b : a);
          x += (x2 - x) * f;
          y += (y2 - y) * f - Math.sin(f * Math.PI) * 0.25 * (i === a ? 1 : -1);
          dot(x, y, 1, 1.35);
        } else dot(x, y, 0.4, 0.95);
      }
      break;
    }
    case "commande": {
      const head = ((t * 1.4) % 1) * 12;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        const trail = Math.max(0, 1 - ((head - i + 12) % 12) / 5);
        dot(Math.cos(a) * 0.85, Math.sin(a) * 0.85, 0.15 + 0.85 * trail, 0.8 + 0.6 * trail);
      }
      break;
    }
    case "tests": {
      const order = [0, 1, 2, 5, 4, 3, 6, 7, 8];
      const step = (t * 5) % 12;
      order.forEach((n, i) => {
        const on = step > i;
        const pop = on ? Math.max(0, 1 - (step - i) / 1.2) : 0;
        dot(((n % 3) - 1) * 0.6, (Math.floor(n / 3) - 1) * 0.6, on ? 0.95 : 0.18, 1 + pop * 0.7);
      });
      break;
    }
    case "travaille":
      for (const q of SWARM) {
        const a = q.p + t * q.s;
        const p: P3 = [Math.cos(a) * q.r, Math.sin(a * 0.7 + q.ty) * q.r * 0.6, Math.sin(a) * q.r];
        const [x, y, z] = rotate(p, q.tx + t * 0.2, q.ty);
        dot(x, y, depth(z), 0.7 + (0.5 * (z + 1)) / 2);
      }
      break;
    case "demarre": {
      const phase = (t * 0.45) % 1;
      const f = ease(phase < 0.7 ? phase / 0.7 : 1);
      const fade = phase > 0.88 ? 1 - (phase - 0.88) / 0.12 : Math.min(1, phase * 6);
      SPHERE.forEach((p, i) => {
        const s = SCATTER[i]!;
        const q: P3 = [
          s[0] + (p[0] - s[0]) * f,
          s[1] + (p[1] - s[1]) * f,
          s[2] + (p[2] - s[2]) * f,
        ];
        const [x, y, z] = rotate(q, t * 0.5, 0.4);
        dot(x, y, depth(z) * fade, 0.8);
      });
      break;
    }
    case "attend": {
      // Barely moves: the agent is not working, it waits for the person.
      const breath = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.4));
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        dot(Math.cos(a) * 0.8, Math.sin(a) * 0.8, breath);
      }
      dot(0, 0, breath, 1.4);
      break;
    }
    case "file": {
      const f = ease(((t / 0.9) % 1) / 0.5);
      for (let i = 0; i < 5; i++) {
        const x = (i - 2) * 0.48 - f * 0.48;
        const alpha =
          i === 0 ? Math.max(0, 1 - f * 1.4) : i === 4 ? 0.3 * f + 0.2 : 0.75 - i * 0.12;
        dot(x, 0, alpha, i === 0 ? 1.25 : 1);
      }
      break;
    }
  }
  ctx.globalAlpha = 1;
}

/** A moment where every still picture reads well. */
export const STILL_TIME = 1.3;
