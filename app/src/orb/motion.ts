/** FINNI's dotted sphere: the dots (rings of points on a unit sphere) and their colours, orange to green when an
 * answer is ready, each at 49 alpha steps so a frame never builds colour strings. Drawn by sphere.ts. */

export const TAU = Math.PI * 2;
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A small seeded random generator, so the dots twinkle the same way on every load. */
export function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RINGS = 16;
const DOT_LIST = (() => {
  const rand = mulberry32(7);
  const out: { x: number; y: number; z: number; seed: number }[] = [];
  for (let k = 0; k < RINGS; k++) {
    const y = 1 - ((k + 0.5) / RINGS) * 2;
    const r = Math.sqrt(1 - y * y);
    const m = Math.max(4, Math.round(30 * r));
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU + k * 0.35;
      out.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, seed: rand() * 6.283 });
    }
  }
  return out;
})();
export const N = DOT_LIST.length;
export const DX = Float32Array.from(DOT_LIST, (d) => d.x);
export const DY = Float32Array.from(DOT_LIST, (d) => d.y);
export const DZ = Float32Array.from(DOT_LIST, (d) => d.z);
export const DS = Float32Array.from(DOT_LIST, (d) => d.seed);

export const G_STEPS = 24, A_STEPS = 48;
/** Dot colours: FINNI orange to green (the "done" sweep), each at 49 alpha steps. */
export const COLORS: string[] = (() => {
  const out: string[] = [];
  for (let gi = 0; gi <= G_STEPS; gi++) {
    const g = gi / G_STEPS;
    const r = Math.round(lerp(255, 52, g)), gg = Math.round(lerp(122, 211, g)), b = Math.round(lerp(0, 153, g));
    for (let ai = 0; ai <= A_STEPS; ai++) out.push(`rgba(${r},${gg},${b},${(ai / A_STEPS).toFixed(3)})`);
  }
  return out;
})();
