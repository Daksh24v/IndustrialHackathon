/** FINNI's dotted sphere on a canvas of any size: the same dots and colours as the big orb (motion.ts), drawn
 * small in the search bar and big while you talk to it. mode sets how it moves: resting turns slowly, thinking
 * turns fast with a light running round, listening and speaking breathe, done sweeps green and fades back. */
import { A_STEPS, COLORS, DS, DX, DY, DZ, G_STEPS, N, TAU, clamp01 } from './motion';

export type SphereMode = 'rest' | 'think' | 'done' | 'listen' | 'speak';

const SPIN: Record<SphereMode, number> = { rest: 0.35, think: 2.4, done: 0.8, listen: 0.6, speak: 0.9 };
const TILT = 0.35;
const GREEN_HOLD_S = 1.1;

export interface Sphere {
  setMode(mode: SphereMode): void;
  destroy(): void;
}

export function createSphere(canvas: HTMLCanvasElement, size: number, reduced: () => boolean): Sphere {
  const ctx = canvas.getContext('2d');
  let mode: SphereMode = 'rest';
  let rot = 0, time = 0, green = 0, greenFor = 0, raf = 0, last = 0, dead = false;
  if (!ctx) return { setMode() {}, destroy() {} };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = size * 0.42, c = size / 2, dot = Math.max(0.7, size / 110);
  const cp = Math.cos(TILT), sp = Math.sin(TILT);

  const draw = (dt: number) => {
    time += dt;
    rot += SPIN[mode] * dt;
    if (mode === 'done') {
      greenFor += dt;
      green = clamp01(green + dt / 0.25);
      if (greenFor > GREEN_HOLD_S) mode = 'rest';
    } else green = clamp01(green - dt / 0.6);
    const breathe = mode === 'listen' ? 1 + 0.05 * Math.sin(time * 4) : mode === 'speak' ? 1 + 0.07 * Math.abs(Math.sin(time * 7)) : 1;
    const head = (time * (mode === 'think' ? 520 : 160)) % N;
    ctx.clearRect(0, 0, size, size);
    const cy = Math.cos(rot), sy = Math.sin(rot);
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < N; n++) {
        const x1 = DX[n] * cy + DZ[n] * sy, z1 = -DX[n] * sy + DZ[n] * cy;
        const y2 = DY[n] * cp - z1 * sp, z2 = DY[n] * sp + z1 * cp;
        const depth = (z2 + 1) / 2;
        if ((depth >= 0.5) !== (pass === 1)) continue;
        let d = Math.abs(n - head); if (d > N - d) d = N - d;
        const lit = Math.max(0, 1 - d / 18) ** 2 * (mode === 'think' ? 1 : 0.5);
        const f = 2.8 / (2.8 - z2);
        let a = 0.22 + 0.04 * Math.sin(DS[n] + time * 1.6) + 0.42 * depth * depth + 0.6 * lit;
        a = Math.min(1, a);
        const ci = Math.round(green * G_STEPS) * (A_STEPS + 1) + Math.round(a * A_STEPS);
        ctx.fillStyle = COLORS[ci];
        ctx.beginPath();
        ctx.arc(c + x1 * r * f * breathe, c - y2 * r * f * breathe, dot * (0.5 + 0.75 * depth) * f + lit * dot * 0.8, 0, TAU);
        ctx.fill();
      }
    }
  };

  const frame = (now: number) => {
    raf = 0;
    if (dead) return;
    draw(reduced() ? 0 : Math.min(0.05, (now - last) / 1000));
    last = now;
    if (!reduced()) raf = requestAnimationFrame(frame);
  };
  last = performance.now();
  frame(last);

  return {
    setMode(next) {
      if (next === 'done') greenFor = 0;
      mode = next;
      if (reduced()) draw(0);
    },
    destroy() {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
