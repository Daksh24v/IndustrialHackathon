/** What each kind of thing looks like: a small block model for each of the asset types in the buildings, built
 * from kit.ts parts inside the thing's real footprint (w along x, d along y, +y the back against the wall), at real
 * heights. A fridge is a tall white box with a handle, a toilet a bowl with a cistern behind it, a forklift has its
 * mast and forks, a pallet rack its beams and pallets. Unknown kinds fall back to a box by their category. */
import type { Point } from '../api';
import { box, cylinder, decal, disc, faceY, FRONT, onFront, type Part, rect, ring } from './kit';
import type { Mat } from './materials';

export interface ModelContext {
  /** The room's type (kitchen, office, …): a sink in a kitchen is a counter, in a bathroom a basin. */
  room?: string;
  /** The floor's height: nothing stands taller than its ceiling. */
  ceiling?: number;
}

type Build = (w: number, d: number, ctx: ModelContext) => Part[];

const L = 0.04; // a leg's thickness

/** Four square legs, inset from the corners. */
function legs(w: number, d: number, h: number, mat: Mat, inset = 0.03, t = L): Part[] {
  const [x, y] = [w / 2 - inset, d / 2 - inset];
  return [[-x, -y], [x - t, -y], [x - t, y - t], [-x, y - t]].map(([lx, ly]) => box(lx, ly, lx + t, ly + t, 0, h, mat, 1));
}

/** A table: legs and a top at height h. */
function table(w: number, d: number, h: number, top: Mat, frame: Mat, t = 0.04): Part[] {
  return [...legs(w, d, h - t, frame), box(-w / 2, -d / 2, w / 2, d / 2, h - t, h, top, 0)];
}

/** A chair facing -y: legs, a seat and a back along +y. */
function chair(w: number, d: number, seat: Mat, frame: Mat, back = 0.88): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    ...legs(w, d, 0.42, frame, 0.03, 0.035),
    box(-hw, -hd, hw, hd, 0.42, 0.47, seat, 0),
    box(-hw + 0.02, hd - 0.06, hw - 0.02, hd, 0.47, back, seat, 0),
  ];
}

function officeChair(w: number, d: number): Part[] {
  const r = Math.min(w, d) / 2;
  const arms = Math.min(0.06, r * 0.15);
  return [
    ...[0, 1, 2, 3, 4].map((i) => {
      const a = (i / 5) * 2 * Math.PI + Math.PI / 2;
      const [x, y] = [Math.cos(a) * (r - 0.06), Math.sin(a) * (r - 0.06)];
      return cylinder(x, y, 0.035, 0, 0.07, 'black', 2, 0.035, 6);
    }),
    cylinder(0, 0, r * 0.75, 0.06, 0.1, 'plastic', 1, r * 0.75, 5),
    cylinder(0, 0, 0.03, 0.1, 0.42, 'chrome', 1, 0.03, 6),
    cylinder(0, -0.02, r * 0.85, 0.42, 0.5, 'fabric', 0, r * 0.8, 10),
    box(-r * 0.75, r - 0.08, r * 0.75, r, 0.55, 1.05, 'fabric', 0),
    box(-r * 0.85, -r * 0.4, -r * 0.85 + arms, r * 0.4, 0.5, 0.66, 'plastic', 2),
    box(r * 0.85 - arms, -r * 0.4, r * 0.85, r * 0.4, 0.5, 0.66, 'plastic', 2),
  ];
}

/** Upholstered seating (sofa, armchair): base, back cushion at +y, arms at the ends. */
function upholstered(w: number, d: number, cover: Mat): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const arm = Math.min(0.16, w * 0.12);
  const seats = Math.max(1, Math.round((w - 2 * arm) / 0.65));
  const width = (w - 2 * arm) / seats;
  return [
    ...legs(w, d, 0.1, 'woodDark', 0.05, 0.05),
    box(-hw, -hd, hw, hd, 0.1, 0.38, cover, 0),
    box(-hw, hd - 0.22, hw, hd, 0.38, 0.85, cover, 0),
    box(-hw, -hd, -hw + arm, hd - 0.22, 0.38, 0.62, cover, 1),
    box(hw - arm, -hd, hw, hd - 0.22, 0.38, 0.62, cover, 1),
    ...Array.from({ length: seats }, (_, i) =>
      box(-hw + arm + i * width + 0.02, -hd + 0.02, -hw + arm + (i + 1) * width - 0.02, hd - 0.24, 0.38, 0.46, 'cushion', 1)),
  ];
}

/** A cabinet standing against the wall: body, doors on the front with handles. */
function cabinet(w: number, d: number, h: number, body: Mat, doors: number, handle: Mat = 'chrome', front: Mat = body): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [box(-hw, -hd + 0.02, hw, hd, 0, h, body, 0)];
  const each = w / doors;
  for (let i = 0; i < doors; i += 1) {
    const x0 = -hw + i * each;
    parts.push(onFront(d, x0 + 0.015, x0 + each - 0.015, 0.05, h - 0.03, front, 1));
    const hx = i % 2 === 0 ? x0 + each - 0.06 : x0 + 0.04;
    parts.push(box(hx, -hd, hx + 0.02, -hd + 0.02, h * 0.45, Math.min(h * 0.45 + 0.25, h - 0.05), handle, 2, { on: FRONT }));
  }
  return parts;
}

/** Drawers on the front (filing cabinets, tool chests). */
function drawers(w: number, d: number, h: number, body: Mat, count: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [box(-hw, -hd + 0.02, hw, hd, 0, h, body, 0)];
  const each = (h - 0.06) / count;
  for (let i = 0; i < count; i += 1) {
    const z0 = 0.04 + i * each;
    parts.push(onFront(d, -hw + 0.02, hw - 0.02, z0 + 0.01, z0 + each - 0.01, body, 1));
    parts.push(box(-0.08, -hd, 0.08, -hd + 0.02, z0 + each * 0.6, z0 + each * 0.6 + 0.025, 'chrome', 2, { on: FRONT }));
  }
  return parts;
}

/** Open shelves: sides, back, shelf boards and what is on them. */
function shelves(w: number, d: number, h: number, frame: Mat, levels: number, fill: Mat[] | null): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const t = 0.025;
  const parts: Part[] = [
    box(-hw, -hd, -hw + t, hd, 0, h, frame, 0),
    box(hw - t, -hd, hw, hd, 0, h, frame, 0),
    box(-hw + t, hd - 0.015, hw - t, hd, 0, h, frame, 0),
  ];
  const gap = h / levels;
  for (let i = 0; i <= levels; i += 1) {
    const z = Math.min(h - t, i * gap);
    parts.push(box(-hw + t, -hd, hw - t, hd - 0.015, z, z + t, frame, i === 0 || i === levels ? 0 : 1));
    if (!fill || i === levels) continue;
    const inner = w - 2 * t;
    const blocks = Math.max(2, Math.round(inner / 0.22));
    for (let k = 0; k < blocks; k += 1) {
      const x0 = -hw + t + (k * inner) / blocks + 0.01;
      const tall = gap * (0.55 + 0.25 * (((k * 7 + i * 3) % 5) / 4));
      parts.push(box(x0, -hd + 0.04, x0 + inner / blocks - 0.02, hd - 0.03, z + t, z + t + Math.min(tall, gap - 0.05),
                     fill[(k + i) % fill.length], 2));
    }
  }
  return parts;
}

function bed(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const pillows = w > 1.2 ? 2 : 1;
  const each = (w - 0.12) / pillows;
  return [
    box(-hw, -hd, hw, hd - 0.06, 0, 0.32, 'woodDark', 0),
    box(-hw, hd - 0.06, hw, hd, 0, 0.95, 'woodDark', 0),
    box(-hw + 0.03, -hd + 0.03, hw - 0.03, hd - 0.08, 0.32, 0.52, 'linen', 0),
    ...Array.from({ length: pillows }, (_, i) =>
      box(-hw + 0.06 + i * each + 0.03, hd - 0.48, -hw + 0.06 + (i + 1) * each - 0.03, hd - 0.12, 0.52, 0.62, 'linen', 1)),
    box(-hw + 0.01, -hd + 0.01, hw - 0.01, hd - 0.56, 0.52, 0.58, 'duvet', 1),
  ];
}

function plant(w: number, d: number): Part[] {
  const r = Math.min(w, d) / 2;
  return [
    cylinder(0, 0, r * 0.62, 0, 0.36, 'pot', 0, r * 0.62, 8),
    cylinder(0, 0, r * 0.98, 0.36, 0.8, 'leaf', 0, r * 0.98, 7),
    cylinder(0.02, -0.02, r * 0.7, 0.8, 1.08, 'leafDark', 1, r * 0.7, 7),
    cylinder(-0.01, 0.01, r * 0.38, 1.08, 1.22, 'leaf', 2, r * 0.38, 6),
  ];
}

/** A white appliance standing against the wall, to worktop height. */
function appliance(w: number, d: number, h: number, mat: Mat = 'white'): Part[] {
  return [box(-w / 2, -d / 2 + 0.02, w / 2, d / 2, 0, h, mat, 0)];
}

function fridge(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const h = Math.min(1.85, (ctx.ceiling ?? 3) - 0.3);
  const split = h * 0.68;
  return [
    box(-hw, -hd + 0.03, hw, hd, 0, h, 'white', 0),
    onFront(d - 0.01, -hw + 0.015, hw - 0.015, 0.06, split - 0.01, 'white', 1, 0.015),
    onFront(d - 0.01, -hw + 0.015, hw - 0.015, split + 0.01, h - 0.02, 'white', 1, 0.015),
    box(hw - 0.09, -hd, hw - 0.06, -hd + 0.03, split - 0.55, split - 0.08, 'chrome', 1, { on: FRONT }),
    box(hw - 0.09, -hd, hw - 0.06, -hd + 0.03, split + 0.08, split + 0.4, 'chrome', 1, { on: FRONT }),
  ];
}

function stove(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const r = Math.min(w, d) * 0.14;
  const [bx, by] = [w * 0.22, d * 0.2];
  return [
    box(-hw, -hd + 0.02, hw, hd, 0, 0.86, 'white', 0),
    box(-hw, -hd + 0.02, hw, hd, 0.86, 0.9, 'black', 0),
    ...[[-bx, -by], [bx, -by], [-bx, by], [bx, by]].map(([x, y]) => decal(ring(x, y + 0.02, r, 10), 0.9, 'steelDark', 1)),
    faceY(-hd + 0.02, rect(-hw + 0.08, 0.2, hw - 0.08, 0.62), 'black', FRONT, 1),
    box(-hw + 0.1, -hd, hw - 0.1, -hd + 0.02, 0.66, 0.69, 'chrome', 2, { on: FRONT }),
    ...[-0.3, -0.1, 0.1, 0.3].map((u) => faceY(-hd + 0.02, disc(u * w, 0.79, 0.022, 8), 'black', FRONT, 2)),
  ];
}

/** Base cabinets with a worktop: kitchen counters, and kitchen sinks. */
function counter(w: number, d: number, top: Mat, basin = false): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const doors = Math.max(1, Math.round(w / 0.6));
  const each = w / doors;
  const parts: Part[] = [
    box(-hw, -hd + 0.06, hw, hd, 0, 0.1, 'plastic', 1),
    box(-hw, -hd + 0.03, hw, hd, 0.1, 0.86, 'white', 0),
    box(-hw, -hd, hw, hd, 0.86, 0.9, top, 0),
  ];
  for (let i = 0; i < doors; i += 1) {
    const x0 = -hw + i * each;
    parts.push(faceY(-hd + 0.03, rect(x0 + 0.015, 0.13, x0 + each - 0.015, 0.83), 'white', FRONT, 1));
    parts.push(box(x0 + each / 2 - 0.08, -hd + 0.01, x0 + each / 2 + 0.08, -hd + 0.03, 0.76, 0.785, 'chrome', 2, { on: FRONT }));
  }
  if (basin) {
    parts.push(decal(rect(-Math.min(0.25, hw - 0.05), -hd + 0.08, Math.min(0.25, hw - 0.05), hd - 0.12), 0.9, 'steelDark', 1));
    parts.push(cylinder(0, hd - 0.07, 0.025, 0.9, 1.15, 'chrome', 2, 0.025, 6));
  }
  return parts;
}

function sink(w: number, d: number, ctx: ModelContext): Part[] {
  if (ctx.room === 'kitchen' || ctx.room === 'canteen') return counter(w, d, 'steel', true);
  const [hw, hd] = [w / 2, d / 2];
  return [
    cylinder(0, hd - 0.12, Math.min(0.09, hw * 0.4), 0, 0.72, 'porcelain', 1, 0.08, 8),
    box(-hw, -hd, hw, hd, 0.72, 0.86, 'porcelain', 0),
    decal(ring(0, -0.03, hw * 0.7, 12, hd * 0.6), 0.86, 'tile', 1),
    cylinder(0, hd - 0.05, 0.022, 0.86, 1.0, 'chrome', 2, 0.022, 6),
    box(-hw + 0.04, hd - 0.02, hw - 0.04, hd, 1.15, 1.75, 'glass', 2),
  ];
}

function toilet(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const bowl = d - 0.2;
  return [
    box(-hw, hd - 0.2, hw, hd, 0.3, 0.8, 'porcelain', 0),
    cylinder(0, -hd + bowl / 2, hw * 0.55, 0, 0.22, 'porcelain', 1, bowl * 0.35, 10),
    cylinder(0, -hd + bowl / 2 + 0.01, hw * 0.92, 0.22, 0.4, 'porcelain', 0, bowl / 2, 12),
    decal(ring(0, -hd + bowl / 2 + 0.02, hw * 0.55, 12, bowl * 0.32), 0.4, 'tile', 2),
    box(-0.04, hd - 0.12, 0.04, hd - 0.06, 0.8, 0.82, 'chrome', 2),
  ];
}

function bathtub(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const t = Math.min(0.08, d * 0.12);
  return [
    decal(rect(-hw + t, -hd + t, hw - t, hd - t), 0.12, 'tile', 1),
    decal(rect(-hw + t, -hd + t, hw - t, hd - t), 0.32, 'water', 2),
    box(-hw, hd - t, hw, hd, 0, 0.55, 'porcelain', 0),
    box(-hw, -hd, hw, -hd + t, 0, 0.55, 'porcelain', 0),
    box(-hw, -hd + t, -hw + t, hd - t, 0, 0.55, 'porcelain', 0),
    box(hw - t, -hd + t, hw, hd - t, 0, 0.55, 'porcelain', 0),
    cylinder(-hw + t + 0.05, 0, 0.025, 0.55, 0.75, 'chrome', 2, 0.025, 6),
  ];
}

function shower(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd, hw, hd, 0, 0.06, 'porcelain', 0),
    decal(ring(0, 0, 0.05, 8), 0.06, 'steelDark', 2),
    box(-hw, -hd, hw, -hd + 0.02, 0.06, 2.0, 'glass', 1),
    box(-hw, -hd + 0.02, -hw + 0.02, hd, 0.06, 2.0, 'glass', 1),
    box(hw - 0.05, hd - 0.05, hw - 0.02, hd - 0.02, 0.06, 2.05, 'chrome', 2),
    cylinder(hw - 0.2, hd - 0.15, 0.08, 1.95, 2.0, 'chrome', 2, 0.08, 8),
  ];
}

function washer(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    ...appliance(w, d, 0.85),
    faceY(-hd + 0.02, rect(-hw + 0.03, 0.72, hw - 0.03, 0.82), 'steel', FRONT, 2),
    faceY(-hd + 0.02, disc(0, 0.4, Math.min(hw, 0.42) * 0.62, 14), 'steelDark', FRONT, 1),
    faceY(-hd + 0.02, disc(0, 0.4, Math.min(hw, 0.42) * 0.46, 14), 'glass', FRONT, 2),
  ];
}

function desk(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [
    box(-hw, -hd + 0.05, -hw + 0.03, hd, 0, 0.72, 'woodDark', 0),
    box(hw - 0.03, -hd + 0.05, hw, hd, 0, 0.72, 'woodDark', 0),
    box(-hw + 0.03, hd - 0.05, hw - 0.03, hd - 0.03, 0.3, 0.72, 'woodDark', 1),
    box(-hw, -hd, hw, hd, 0.72, 0.75, 'wood', 0),
  ];
  if (ctx.room !== 'bedroom' && w >= 1) {
    const sw = Math.min(0.3, hw * 0.55);
    parts.push(box(-0.04, hd - 0.18, 0.04, hd - 0.12, 0.75, 0.86, 'black', 2));
    parts.push(box(-sw, hd - 0.15, sw, hd - 0.12, 0.86, 1.18, 'black', 1));
    parts.push(faceY(hd - 0.15, rect(-sw + 0.015, 0.875, sw - 0.015, 1.165), 'screenOn', FRONT, 2));
    parts.push(decal(rect(-0.22, -hd + 0.12, 0.22, -hd + 0.27), 0.75, 'plastic', 2));
  }
  return parts;
}

/** A row of lecture seats facing -y, with the writing strip in front. */
function lectureRow(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const seats = Math.max(1, Math.round(w / 0.55));
  const each = w / seats;
  const parts: Part[] = [
    box(-hw, -hd, hw, -hd + 0.25, 0.7, 0.74, 'wood', 0),
    box(-hw, -hd + 0.2, hw, -hd + 0.25, 0, 0.7, 'woodDark', 1),
  ];
  for (let i = 0; i < seats; i += 1) {
    const x0 = -hw + i * each + 0.04;
    const x1 = x0 + each - 0.08;
    parts.push(box(x0, -hd + 0.3, x1, hd - 0.08, 0.42, 0.47, 'fabric', 1));
    parts.push(box(x0, hd - 0.08, x1, hd, 0.42, 0.9, 'fabric', 1));
  }
  parts.push(box(-hw, -hd + 0.3, -hw + 0.04, hd, 0, 0.6, 'woodDark', 0), box(hw - 0.04, -hd + 0.3, hw, hd, 0, 0.6, 'woodDark', 0));
  return parts;
}

function reception(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd, hw, -hd + 0.3, 0, 1.1, 'woodLight', 0),
    box(-hw, -hd, hw, -hd + 0.34, 1.1, 1.14, 'wood', 0),
    box(-hw, -hd + 0.3, hw, hd, 0.72, 0.75, 'wood', 1),
    box(-hw, -hd + 0.3, -hw + 0.03, hd, 0, 0.72, 'woodDark', 1),
    box(hw - 0.03, -hd + 0.3, hw, hd, 0, 0.72, 'woodDark', 1),
  ];
}

function tvStand(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const sw = Math.min(hw * 0.85, 0.75);
  return [
    ...cabinet(w, d, 0.48, 'woodDark', Math.max(2, Math.round(w / 0.5)), 'steel'),
    box(-0.12, hd - 0.2, 0.12, hd - 0.1, 0.48, 0.5, 'black', 2),
    box(-0.02, hd - 0.14, 0.02, hd - 0.1, 0.5, 0.6, 'black', 2),
    box(-sw, hd - 0.12, sw, hd - 0.08, 0.6, 0.6 + sw * 1.1, 'black', 1),
    faceY(hd - 0.12, rect(-sw + 0.02, 0.62, sw - 0.02, 0.58 + sw * 1.1), 'screenOn', FRONT, 2),
  ];
}

function nightstand(w: number, d: number): Part[] {
  return [
    ...drawers(w, d, 0.55, 'wood', 2),
    cylinder(0, 0.03, 0.06, 0.55, 0.58, 'steel', 2, 0.06, 6),
    cylinder(0, 0.03, 0.012, 0.58, 0.8, 'steel', 2, 0.012, 5),
    cylinder(0, 0.03, Math.min(0.11, w * 0.24), 0.78, 0.92, 'linen', 2, Math.min(0.11, d * 0.24), 8),
  ];
}

function coatRack(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd, hw, hd, 0, 0.03, 'steelDark', 0),
    box(-hw + 0.03, -0.02, -hw + 0.06, 0.02, 0, 1.7, 'steelDark', 0),
    box(hw - 0.06, -0.02, hw - 0.03, 0.02, 0, 1.7, 'steelDark', 0),
    box(-hw + 0.03, -0.02, hw - 0.03, 0.02, 1.62, 1.66, 'steelDark', 1),
    box(-hw * 0.6, -hd + 0.03, -hw * 0.1, hd - 0.03, 0.85, 1.6, 'fabric', 2),
    box(hw * 0.05, -hd + 0.03, hw * 0.5, hd - 0.03, 0.95, 1.6, 'fabricWarm', 2),
  ];
}

function whiteboard(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const top = Math.min(2.0, (ctx.ceiling ?? 3) - 0.2);
  return [
    box(-hw, -hd, hw, hd, 0.9, top, 'steel', 0),
    faceY(-hd, rect(-hw + 0.03, 0.93, hw - 0.03, top - 0.03), 'porcelain', FRONT, 1),
    box(-hw + 0.1, -hd, hw - 0.1, -hd + 0.01, 0.86, 0.9, 'steel', 2),
  ];
}

function screen(w: number, d: number, low: number, high: number, face: Mat): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw * 0.3, -hd, hw * 0.3, hd, 0, 0.03, 'black', 1),
    box(-0.03, hd - 0.06, 0.03, hd - 0.02, 0.03, low, 'black', 1),
    box(-hw, hd - 0.08, hw, hd, low, high, 'black', 0),
    faceY(hd - 0.08, rect(-hw + 0.03, low + 0.03, hw - 0.03, high - 0.03), face, FRONT, 2),
  ];
}

function serverRack(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const h = Math.min(2.0, (ctx.ceiling ?? 3) - 0.3);
  const parts: Part[] = [box(-hw, -hd, hw, hd, 0, h, 'black', 0)];
  const units = 8;
  for (let i = 0; i < units; i += 1) {
    const z = 0.12 + (i * (h - 0.25)) / units;
    parts.push(faceY(-hd, rect(-hw + 0.05, z, hw - 0.05, z + 0.12), 'plastic', FRONT, 1));
    parts.push(faceY(-hd, rect(hw - 0.12, z + 0.04, hw - 0.08, z + 0.07), i % 3 ? 'led' : 'screenOn', FRONT, 2));
  }
  return parts;
}

function vending(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [box(-hw, -hd + 0.02, hw, hd, 0, 1.85, 'rackBlue', 0)];
  parts.push(faceY(-hd + 0.02, rect(-hw + 0.06, 0.55, hw * 0.4, 1.75), 'glass', FRONT, 1));
  const rows: Mat[] = ['books1', 'yellow', 'books3', 'books2', 'pot'];
  rows.forEach((mat, i) => {
    const z = 0.62 + i * 0.22;
    parts.push(faceY(-hd + 0.02, rect(-hw + 0.1, z, hw * 0.36, z + 0.1), mat, FRONT, 2));
  });
  parts.push(faceY(-hd + 0.02, rect(hw * 0.5, 1.2, hw - 0.06, 1.45), 'black', FRONT, 2));
  parts.push(faceY(-hd + 0.02, rect(-hw + 0.1, 0.2, hw * 0.4, 0.38), 'black', FRONT, 1));
  return parts;
}

function extinguisher(w: number, d: number): Part[] {
  const r = Math.min(w, d) * 0.32;
  return [
    cylinder(0, 0, r, 0, 0.55, 'red', 0, r, 10),
    cylinder(0, 0, r * 0.45, 0.55, 0.64, 'black', 1, r * 0.45, 8),
    box(-r * 0.2, -r * 0.2, r * 1.3, r * 0.2, 0.62, 0.66, 'black', 2),
    box(r * 0.8, -r * 0.15, r * 1.05, r * 0.15, 0.1, 0.62, 'black', 2),
  ];
}

function defibrillator(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const heart: Point[] = [[0, 1.18], [-0.07, 1.27], [-0.05, 1.33], [0, 1.31], [0.05, 1.33], [0.07, 1.27]];
  return [
    box(-hw, -hd, hw, hd, 1.05, 1.5, 'green', 0),
    faceY(-hd, heart, 'porcelain', FRONT, 1),
    box(-hw, hd - 0.02, hw, hd, 1.6, 1.8, 'green', 2),
  ];
}

function eyewash(w: number, d: number): Part[] {
  const r = Math.min(w, d) / 2;
  return [
    box(-0.12, -0.1, 0.12, 0.1, 0, 0.04, 'green', 1),
    cylinder(0, 0.02, 0.04, 0.04, 0.9, 'green', 0, 0.04, 8),
    cylinder(0, -0.02, r * 0.85, 0.9, 1.0, 'green', 0, r * 0.75, 10),
    decal(ring(0, -0.02, r * 0.6, 10, r * 0.5), 1.0, 'water', 2),
  ];
}

function forklift(w: number, d: number, ctx: ModelContext): Part[] {
  // The forks at -x, the counterweight at +x: the data's forklifts lie along x.
  const [hw, hd] = [w / 2, d / 2];
  const mast = Math.min(2.2, (ctx.ceiling ?? 4) - 0.3);
  const forks = Math.min(1.0, w * 0.36);
  const body0 = -hw + forks + 0.12;
  const parts: Part[] = [
    box(-hw, -hd * 0.55, -hw + forks + 0.08, -hd * 0.35, 0.06, 0.11, 'steelDark', 0),
    box(-hw, hd * 0.35, -hw + forks + 0.08, hd * 0.55, 0.06, 0.11, 'steelDark', 0),
    box(-hw + forks, -hd * 0.65, -hw + forks + 0.06, hd * 0.65, 0.06, 0.95, 'steelDark', 1),
    box(-hw + forks + 0.06, -hd * 0.5, -hw + forks + 0.12, -hd * 0.38, 0, mast, 'steelDark', 0),
    box(-hw + forks + 0.06, hd * 0.38, -hw + forks + 0.12, hd * 0.5, 0, mast, 'steelDark', 0),
    box(-hw + forks + 0.06, -hd * 0.5, -hw + forks + 0.12, hd * 0.5, mast - 0.08, mast, 'steelDark', 1),
    box(body0, -hd + 0.14, hw, hd - 0.14, 0.2, 0.95, 'yellow', 0),
    box(hw - 0.38, -hd + 0.14, hw, hd - 0.14, 0.95, 1.2, 'steelDark', 0),
    box(body0 + 0.55, -0.22, body0 + 0.95, 0.22, 0.95, 1.05, 'black', 1),
    box(body0 + 0.85, -0.22, body0 + 0.95, 0.22, 1.05, 1.45, 'black', 1),
    box(body0 + 0.18, -0.03, body0 + 0.24, 0.03, 0.95, 1.35, 'black', 2),
    cylinder(body0 + 0.24, 0, 0.13, 1.35, 1.38, 'black', 2, 0.13, 8),
  ];
  for (const x of [body0 + 0.02, hw - 0.48]) {
    for (const [y0, y1] of [[-hd, -hd + 0.18], [hd - 0.18, hd]]) parts.push(box(x, y0, x + 0.44, y1, 0, 0.44, 'rubber', 0));
  }
  const [gx0, gx1] = [body0 + 0.05, hw - 0.42];
  for (const x of [gx0, gx1 - 0.05]) {
    for (const y of [-hd + 0.15, hd - 0.2]) parts.push(box(x, y, x + 0.05, y + 0.05, 0.95, 2.1, 'black', 1));
  }
  parts.push(box(gx0, -hd + 0.15, gx1, hd - 0.15, 2.06, 2.12, 'black', 1));
  return parts;
}

function palletJack(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd * 0.85, hw - 0.35, -hd * 0.3, 0.03, 0.09, 'yellow', 0),
    box(-hw, hd * 0.3, hw - 0.35, hd * 0.85, 0.03, 0.09, 'yellow', 0),
    box(hw - 0.4, -hd * 0.6, hw - 0.12, hd * 0.6, 0, 0.36, 'yellow', 0),
    box(hw - 0.2, -0.04, hw - 0.12, 0.04, 0.36, 1.15, 'black', 1),
    box(hw - 0.2, -0.16, hw - 0.12, 0.16, 1.1, 1.18, 'black', 2),
  ];
}

function palletRack(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const h = Math.max(1.6, Math.min(4.4, (ctx.ceiling ?? 5) - 0.4));
  const levels = Math.max(1, Math.round(h / 1.4));
  const parts: Part[] = [];
  const post = 0.08;
  for (const x of [-hw, hw - post]) for (const y of [-hd, hd - post]) parts.push(box(x, y, x + post, y + post, 0, h, 'rackBlue', 0));
  const bays = Math.max(1, Math.round((w - 2 * post) / 1.25));
  const each = (w - 2 * post) / bays;
  for (let i = 0; i < levels; i += 1) {
    const z = 0.12 + (i * (h - 0.2)) / levels;
    if (i > 0) {
      parts.push(box(-hw + post, -hd, hw - post, -hd + 0.06, z - 0.1, z, 'rackOrange', 0));
      parts.push(box(-hw + post, hd - 0.06, hw - post, hd, z - 0.1, z, 'rackOrange', 0));
    }
    for (let b = 0; b < bays; b += 1) {
      const x0 = -hw + post + b * each + 0.05;
      const x1 = x0 + each - 0.1;
      parts.push(box(x0, -hd + 0.06, x1, hd - 0.06, z, z + 0.14, 'pallet', 1));
      const tall = Math.min(0.9, (h - 0.2) / levels - 0.35);
      parts.push(box(x0 + 0.04, -hd + 0.1, x1 - 0.04, hd - 0.1, z + 0.14, z + 0.14 + tall, 'cardboard', 1));
    }
  }
  return parts;
}

function conveyor(w: number, d: number): Part[] {
  const long = w >= d;
  const [len, wid] = long ? [w, d] : [d, w];
  const parts: Part[] = [];
  const at = (a0: number, b0: number, a1: number, b1: number, z0: number, z1: number, mat: Mat, detail: 0 | 1 | 2) =>
    (long ? box(a0, b0, a1, b1, z0, z1, mat, detail) : box(b0, a0, b1, a1, z0, z1, mat, detail));
  const [hl, hwid] = [len / 2, wid / 2];
  const posts = Math.max(2, Math.round(len / 1.5) + 1);
  for (let i = 0; i < posts; i += 1) {
    const a = -hl + 0.05 + (i * (len - 0.15)) / (posts - 1);
    parts.push(at(a, -hwid + 0.05, a + 0.05, -hwid + 0.1, 0, 0.75, 'steelDark', 1));
    parts.push(at(a, hwid - 0.1, a + 0.05, hwid - 0.05, 0, 0.75, 'steelDark', 1));
  }
  parts.push(at(-hl, -hwid, hl, -hwid + 0.07, 0.75, 0.92, 'steel', 0));
  parts.push(at(-hl, hwid - 0.07, hl, hwid, 0.75, 0.92, 'steel', 0));
  parts.push(at(-hl, -hwid + 0.07, hl, hwid - 0.07, 0.8, 0.88, 'rubber', 0));
  const rollers = Math.max(2, Math.round(len / 0.25));
  for (let i = 1; i < rollers; i += 1) {
    const a = -hl + (i * len) / rollers;
    const [p, q] = [a - 0.015, a + 0.015];
    const strip = long ? rect(p, -hwid + 0.07, q, hwid - 0.07) : rect(-hwid + 0.07, p, hwid - 0.07, q);
    parts.push(decal(strip, 0.88, 'steelDark', 2));
  }
  return parts;
}

/** A machine tool in its enclosure: plinth, cabinet, a window on the front, a control panel, a stack light. */
function enclosure(w: number, d: number, ctx: ModelContext, h: number, body: Mat = 'machineLight'): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const top = Math.min(h, (ctx.ceiling ?? 4) - 0.3);
  const panel = Math.min(0.45, w * 0.18);
  return [
    box(-hw, -hd, hw, hd, 0, 0.15, 'steelDark', 0),
    box(-hw, -hd + 0.04, hw, hd, 0.15, top, body, 0),
    faceY(-hd + 0.04, rect(-hw + 0.12, 0.17, hw - panel - 0.1, 0.27), 'yellow', FRONT, 2),
    faceY(-hd + 0.04, rect(-hw + 0.15, top * 0.42, hw - panel - 0.2, top * 0.82), 'glass', FRONT, 1),
    faceY(-hd + 0.04, rect(-hw + 0.12, top * 0.38, hw - panel - 0.14, top * 0.4), 'steelDark', FRONT, 2),
    box(hw - panel, -hd, hw - 0.04, -hd + 0.04, top * 0.45, top * 0.78, 'black', 1, { on: FRONT }),
    faceY(-hd, rect(hw - panel + 0.04, top * 0.6, hw - 0.08, top * 0.75), 'screenOn', FRONT, 2),
    cylinder(hw - 0.12, hd - 0.12, 0.04, top, top + 0.12, 'green', 2, 0.04, 6),
    cylinder(hw - 0.12, hd - 0.12, 0.04, top + 0.12, top + 0.2, 'yellow', 2, 0.04, 6),
  ];
}

function drillPress(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw * 0.7, -hd * 0.3, hw * 0.7, hd, 0, 0.08, 'machine', 0),
    cylinder(0, hd * 0.6, 0.05, 0.08, 1.7, 'steel', 0, 0.05, 8),
    cylinder(0, -hd * 0.1, hw * 0.55, 0.8, 0.85, 'machine', 1, hd * 0.45, 10),
    box(-hw * 0.4, -hd * 0.45, hw * 0.4, hd * 0.8, 1.35, 1.65, 'machine', 0),
    box(-hw * 0.3, hd * 0.4, hw * 0.3, hd * 0.95, 1.65, 1.85, 'machine', 1),
    cylinder(0, -hd * 0.2, 0.02, 1.15, 1.35, 'chrome', 2, 0.02, 6),
  ];
}

function millingMachine(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw * 0.4, -hd * 0.2, hw * 0.4, hd, 0, 1.9, 'machine', 0),
    box(-hw * 0.35, -hd * 0.75, hw * 0.35, hd * 0.2, 0, 0.8, 'machine', 0),
    box(-hw, -hd * 0.7, hw, hd * 0.05, 0.8, 0.95, 'steel', 0),
    box(-hw * 0.3, -hd, hw * 0.3, hd * 0.3, 1.5, 1.85, 'machine', 1),
    cylinder(0, -hd * 0.65, 0.04, 1.2, 1.5, 'chrome', 2, 0.04, 6),
  ];
}

function pressBrake(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const h = Math.min(2.6, (ctx.ceiling ?? 4) - 0.3);
  return [
    box(-hw, -hd * 0.3, -hw + 0.3, hd, 0, h, 'machine', 0),
    box(hw - 0.3, -hd * 0.3, hw, hd, 0, h, 'machine', 0),
    box(-hw + 0.3, -hd * 0.3, hw - 0.3, hd * 0.4, 0, 0.9, 'machine', 0),
    box(-hw + 0.3, -hd * 0.3, hw - 0.3, hd * 0.4, h * 0.62, h, 'machine', 0),
    box(-hw + 0.3, -hd * 0.15, hw - 0.3, hd * 0.1, 0.9, 1.0, 'steel', 1),
    box(-hw, -hd, hw, -hd * 0.3, 0, 0.06, 'yellow', 1),
    box(hw - 0.55, -hd, hw - 0.3, -hd * 0.6, 0.9, 1.6, 'black', 2),
  ];
}

function injectionMoulding(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const top = Math.min(2.1, (ctx.ceiling ?? 4) - 0.6);
  return [
    box(-hw, -hd, hw, hd, 0, 1.0, 'machine', 0),
    box(-hw, -hd * 0.8, 0, hd * 0.8, 1.0, top, 'machineLight', 0),
    faceY(-hd * 0.8, rect(-hw + 0.2, 1.15, -0.2, top - 0.15), 'glass', FRONT, 1),
    box(0.05, -hd * 0.25, hw - 0.3, hd * 0.25, 1.0, 1.45, 'steel', 0),
    cylinder(hw * 0.55, 0, Math.min(0.28, hd * 0.4), 1.45, 1.95, 'yellow', 1, Math.min(0.28, hd * 0.4), 8),
    box(0.1, -hd, 0.6, -hd + 0.05, 1.1, 1.7, 'black', 1, { on: FRONT }),
    faceY(-hd, rect(0.15, 1.4, 0.55, 1.65), 'screenOn', FRONT, 2),
  ];
}

function waterjet(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const t = 0.1;
  return [
    box(-hw, -hd, hw, -hd + t, 0, 0.85, 'steel', 0),
    box(-hw, hd - t, hw, hd, 0, 0.85, 'steel', 0),
    box(-hw, -hd + t, -hw + t, hd - t, 0, 0.85, 'steel', 0),
    box(hw - t, -hd + t, hw, hd - t, 0, 0.85, 'steel', 0),
    decal(rect(-hw + t, -hd + t, hw - t, hd - t), 0.7, 'water', 1),
    box(-0.15, -hd, 0.15, -hd + 0.15, 0.85, 1.8, 'yellow', 0),
    box(-0.15, hd - 0.15, 0.15, hd, 0.85, 1.8, 'yellow', 0),
    box(-0.15, -hd, 0.15, hd, 1.65, 1.85, 'yellow', 0),
    box(-0.1, -0.12, 0.1, 0.12, 1.0, 1.65, 'steelDark', 1),
  ];
}

function welding(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    ...table(w * 0.6, d * 0.5, 0.9, 'steelDark', 'steelDark').map((part) => shift(part, -w * 0.1, -d * 0.15)),
    box(-hw, hd - 0.04, hw, hd, 0, 1.8, 'fabricWarm', 0),
    box(-hw, -hd, -hw + 0.04, hd - 0.04, 0, 1.8, 'fabricWarm', 0),
    box(hw - 0.55, hd - 0.5, hw - 0.1, hd - 0.1, 0, 0.75, 'rackBlue', 1),
    cylinder(hw - 0.25, -hd + 0.35, 0.11, 0, 1.4, 'green', 1, 0.11, 8),
  ];
}

function shift(part: Part, dx: number, dy: number): Part {
  return { ...part, base: part.base.map(([x, y]) => [x + dx, y + dy] as Point) };
}

function robotCell(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const fence = Math.min(2.0, (ctx.ceiling ?? 4) - 0.4);
  const door = Math.min(1.0, w * 0.3);
  const parts: Part[] = [
    box(-hw, hd - 0.03, hw, hd, 0, fence, 'glass', 0),
    box(-hw, -hd, -hw + 0.03, hd, 0, fence, 'glass', 0),
    box(hw - 0.03, -hd, hw, hd, 0, fence, 'glass', 0),
    box(-hw, -hd, -door / 2, -hd + 0.03, 0, fence, 'glass', 0),
    box(door / 2, -hd, hw, -hd + 0.03, 0, fence, 'glass', 0),
  ];
  for (const [x, y] of [[-hw, -hd], [hw - 0.06, -hd], [-hw, hd - 0.06], [hw - 0.06, hd - 0.06], [-door / 2 - 0.06, -hd], [door / 2, -hd]]) {
    parts.push(box(x, y, x + 0.06, y + 0.06, 0, fence, 'yellow', 1));
  }
  parts.push(
    box(-0.5, -0.5, 0.5, 0.5, 0, 0.3, 'steelDark', 1),
    cylinder(0, 0, 0.3, 0.3, 0.75, 'yellow', 0, 0.3, 10),
    box(-0.12, -0.12, 0.12, 0.12, 0.75, 1.55, 'yellow', 0),
    box(-0.1, -0.95, 0.1, 0.1, 1.45, 1.65, 'yellow', 0),
    box(-0.07, -1.05, 0.07, -0.85, 1.05, 1.45, 'steelDark', 1),
    box(-hw + 0.3, -0.6, -hw + 1.3, 0.4, 0, 0.8, 'steel', 1),
  );
  return parts;
}

function printer3d(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const h = 0.7;
  const t = 0.03;
  const parts: Part[] = [box(-hw, -hd, hw, hd, 0, 0.08, 'black', 0)];
  for (const [x, y] of [[-hw, -hd], [hw - t, -hd], [-hw, hd - t], [hw - t, hd - t]]) parts.push(box(x, y, x + t, y + t, 0.08, h, 'black', 0));
  parts.push(
    box(-hw, -hd, hw, hd, h - t, h, 'black', 1),
    box(-hw + 0.06, -hd + 0.06, hw - 0.06, hd - 0.06, 0.2, 0.23, 'steel', 1),
    box(-hw + t, -0.03, hw - t, 0.03, 0.42, 0.46, 'steelDark', 2),
    box(-0.04, -0.05, 0.04, 0.05, 0.36, 0.46, 'black', 2),
    cylinder(hw * 0.4, hd * 0.4, 0.09, h, h + 0.06, 'books3', 2, 0.09, 8),
  );
  return parts;
}

function cmm(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd, hw, hd, 0, 0.8, 'black', 0),
    box(-hw + 0.05, -0.12, -hw + 0.18, 0.12, 0.8, 2.0, 'machineLight', 0),
    box(hw - 0.18, -0.12, hw - 0.05, 0.12, 0.8, 2.0, 'machineLight', 0),
    box(-hw + 0.05, -0.12, hw - 0.05, 0.12, 1.85, 2.05, 'machineLight', 0),
    box(-0.08, -0.08, 0.08, 0.08, 1.1, 1.85, 'steel', 1),
    cylinder(0, 0, 0.015, 0.95, 1.1, 'chrome', 2, 0.015, 6),
  ];
}

function boiler(w: number, d: number, ctx: ModelContext): Part[] {
  const r = Math.min(w, d) / 2;
  const h = Math.min(2.0, (ctx.ceiling ?? 3) - 0.3);
  return [
    cylinder(0, 0, r * 0.92, 0, h, 'steel', 0, r * 0.92, 12),
    cylinder(-r * 0.4, r * 0.3, 0.05, h, h + 0.25, 'steelDark', 1, 0.05, 6),
    cylinder(r * 0.4, r * 0.3, 0.05, h, h + 0.25, 'steelDark', 1, 0.05, 6),
    faceY(-r * 0.92, disc(0, h * 0.6, 0.07, 10), 'porcelain', FRONT, 2),
  ];
}

function hvac(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const fans = Math.max(1, Math.round(w / Math.max(d, 0.6)));
  const each = w / fans;
  const parts: Part[] = [box(-hw, -hd, hw, hd, 0, 1.4, 'machineLight', 0)];
  for (let i = 0; i < fans; i += 1) {
    const cx = -hw + each * (i + 0.5);
    parts.push(decal(ring(cx, 0, Math.min(each, d) * 0.36, 12), 1.4, 'black', 1));
    parts.push(decal(ring(cx, 0, Math.min(each, d) * 0.1, 8), 1.401, 'steel', 2));
  }
  for (let i = 0; i < 5; i += 1) parts.push(faceY(-hd, rect(-hw + 0.1, 0.25 + i * 0.18, hw - 0.1, 0.3 + i * 0.18), 'steelDark', FRONT, 2));
  return parts;
}

function electricalPanel(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const h = Math.min(2.0, (ctx.ceiling ?? 3) - 0.3);
  return [
    ...cabinet(w, d, h, 'steel', 2, 'black'),
    faceY(-hd, [[-0.08, h * 0.7], [0.08, h * 0.7], [0, h * 0.7 + 0.14]], 'yellow', FRONT, 1),
  ];
}

/** A workbench: steel frame, wooden top, a lower shelf, and a back panel with tools for the work kinds. */
function workbench(w: number, d: number, kind: 'plain' | 'assembly' | 'packing' | 'inspection' | 'lab'): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [
    ...legs(w, d, 0.86, 'steelDark', 0.03, 0.05),
    box(-hw + 0.03, -hd + 0.05, hw - 0.03, hd - 0.05, 0.15, 0.18, 'steelDark', 1),
    box(-hw, -hd, hw, hd, 0.86, 0.9, kind === 'lab' ? 'black' : 'woodLight', 0),
  ];
  if (kind === 'lab') {
    parts.push(...cabinet(w, d - 0.05, 0.86, 'white', Math.max(2, Math.round(w / 0.6))).slice(0, 1));
    parts.push(box(-hw + 0.05, hd - 0.12, -hw + 0.09, hd - 0.08, 0.9, 1.5, 'steel', 1));
    parts.push(box(hw - 0.09, hd - 0.12, hw - 0.05, hd - 0.08, 0.9, 1.5, 'steel', 1));
    parts.push(box(-hw + 0.05, hd - 0.2, hw - 0.05, hd - 0.02, 1.35, 1.38, 'steel', 1));
  }
  if (kind === 'plain' || kind === 'assembly') {
    parts.push(box(-hw + 0.05, hd - 0.04, hw - 0.05, hd, 0.9, 1.7, kind === 'plain' ? 'steel' : 'steelDark', 1));
    if (kind === 'assembly') {
      parts.push(box(-hw + 0.05, hd - 0.3, hw - 0.05, hd - 0.04, 1.3, 1.33, 'steel', 1));
      const bins = Math.max(2, Math.round(w / 0.3));
      for (let i = 0; i < bins; i += 1) {
        const x0 = -hw + 0.08 + (i * (w - 0.16)) / bins;
        parts.push(box(x0, hd - 0.28, x0 + (w - 0.16) / bins - 0.03, hd - 0.06, 1.33, 1.45, 'rackBlue', 2));
      }
      parts.push(box(-hw + 0.05, hd - 0.15, hw - 0.05, hd - 0.04, 1.75, 1.8, 'porcelain', 2));
    }
  }
  if (kind === 'packing') {
    parts.push(cylinder(hw - 0.25, hd - 0.2, 0.12, 0.9, 1.0, 'cardboard', 1, 0.12, 8));
    parts.push(box(-hw + 0.15, -hd + 0.15, -hw + 0.6, hd - 0.2, 0.9, 1.15, 'cardboard', 1));
  }
  if (kind === 'inspection') {
    parts.push(box(hw - 0.2, hd - 0.12, hw - 0.15, hd - 0.07, 0.9, 1.5, 'steel', 1));
    parts.push(box(hw - 0.55, hd - 0.4, hw - 0.15, hd - 0.07, 1.45, 1.5, 'steel', 1));
    parts.push(cylinder(hw - 0.5, hd - 0.4, 0.1, 1.38, 1.45, 'porcelain', 2, 0.1, 8));
  }
  return parts;
}

function benchTop(w: number, d: number, instrument: 'scope' | 'solder'): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    ...table(w, d, 0.75, 'woodLight', 'steelDark'),
    box(-hw * 0.6, hd - 0.4, hw * (instrument === 'scope' ? 0.2 : -0.1), hd - 0.05, 0.75, 0.97, 'steelDark', 1),
    faceY(hd - 0.4, rect(-hw * 0.55, 0.8, -hw * 0.1, 0.94), instrument === 'scope' ? 'screenOn' : 'black', FRONT, 2),
    instrument === 'solder'
      ? cylinder(hw * 0.4, 0, 0.05, 0.75, 0.85, 'steel', 2, 0.05, 6)
      : box(hw * 0.35, hd - 0.35, hw * 0.75, hd - 0.05, 0.75, 0.9, 'steelDark', 2),
  ];
}

function microscope(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw * 0.5, -hd * 0.6, hw * 0.5, hd * 0.6, 0, 0.04, 'black', 0),
    box(-0.04, hd * 0.2, 0.04, hd * 0.5, 0.04, 0.38, 'porcelain', 0),
    box(-hw * 0.35, -hd * 0.35, hw * 0.35, hd * 0.15, 0.14, 0.17, 'black', 1),
    cylinder(0, 0, 0.035, 0.2, 0.36, 'black', 1, 0.035, 8),
    cylinder(0, hd * 0.15, 0.03, 0.36, 0.45, 'black', 2, 0.03, 8),
  ];
}

function fumeHood(w: number, d: number, ctx: ModelContext): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const top = Math.min(2.3, (ctx.ceiling ?? 3) - 0.2);
  return [
    ...cabinet(w, d, 0.85, 'white', 2),
    box(-hw, -hd, hw, hd, 0.85, 0.9, 'black', 0),
    box(-hw, hd - 0.05, hw, hd, 0.9, top, 'white', 0),
    box(-hw, -hd, -hw + 0.08, hd - 0.05, 0.9, top, 'white', 0),
    box(hw - 0.08, -hd, hw, hd - 0.05, 0.9, top, 'white', 0),
    box(-hw + 0.08, -hd, hw - 0.08, hd - 0.05, top - 0.35, top, 'white', 0),
    box(-hw + 0.08, -hd, hw - 0.08, -hd + 0.02, 1.25, top - 0.35, 'glass', 1),
  ];
}

function counterWithGuard(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd + 0.05, hw, hd, 0, 0.9, 'steel', 0),
    box(-hw, -hd, hw, hd, 0.9, 0.94, 'steelDark', 0),
    box(-hw + 0.05, -hd + 0.25, hw - 0.05, -hd + 0.27, 0.94, 1.35, 'glass', 1),
    ...Array.from({ length: Math.max(1, Math.floor(w / 0.6)) }, (_, i) => {
      const x0 = -hw + 0.1 + i * 0.6;
      return decal(rect(x0, -hd + 0.32, x0 + 0.5, hd - 0.1), 0.94, 'steelDark', 2);
    }),
  ];
}

function waterDispenser(w: number, d: number): Part[] {
  const r = Math.min(w, d) / 2;
  return [
    box(-w / 2, -d / 2, w / 2, d / 2, 0, 1.0, 'white', 0),
    cylinder(0, 0, r * 0.75, 1.0, 1.45, 'water', 1, r * 0.75, 10),
    faceY(-d / 2, rect(-0.06, 0.75, 0.06, 0.82), 'steelDark', FRONT, 2),
  ];
}

function locker(w: number, d: number, ctx: ModelContext): Part[] {
  const h = Math.min(1.9, (ctx.ceiling ?? 3) - 0.3);
  const doors = Math.max(1, Math.round(w / 0.3));
  const parts = cabinet(w, d, h, 'steel', doors, 'steelDark', 'rackBlue');
  for (let i = 0; i < doors; i += 1) {
    const x0 = -w / 2 + (i * w) / doors;
    for (const z of [h - 0.2, h - 0.15, h - 0.1]) {
      parts.push(faceY(-d / 2, rect(x0 + 0.06, z, x0 + w / doors - 0.06, z + 0.02), 'steelDark', FRONT, 2));
    }
  }
  return parts;
}

function chemicalCabinet(w: number, d: number): Part[] {
  const hd = d / 2;
  return [
    ...cabinet(w, d, 1.9, 'yellow', 2, 'black'),
    faceY(-hd, [[0, 1.3], [0.12, 1.42], [0, 1.54], [-0.12, 1.42]], 'hazard', FRONT, 1),
  ];
}

function charger(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    decal(rect(-hw, -hd, hw, hd - 0.35), 0.01, 'yellow', 1),
    box(-0.3, hd - 0.35, 0.3, hd, 0, 1.5, 'steel', 0),
    faceY(hd - 0.35, rect(-0.2, 1.1, 0.2, 1.35), 'screenOn', FRONT, 2),
    faceY(hd - 0.35, rect(-0.12, 0.85, -0.04, 0.95), 'led', FRONT, 2),
    box(-0.04, hd - 0.4, 0.04, hd - 0.35, 0.3, 0.8, 'black', 2),
  ];
}

function compressor(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [box(-hw, -hd, hw, hd, 0, 1.3, 'rackBlue', 0)];
  for (let i = 0; i < 6; i += 1) parts.push(faceY(-hd, rect(-hw + 0.15, 0.3 + i * 0.12, hw * 0.2, 0.35 + i * 0.12), 'steelDark', FRONT, 2));
  parts.push(faceY(-hd, rect(hw * 0.4, 0.9, hw - 0.12, 1.15), 'black', FRONT, 2));
  return parts;
}

function curingOven(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd + 0.03, hw, hd, 0, 1.9, 'steel', 0),
    onFront(d, -hw + 0.05, hw - 0.05, 0.1, 1.6, 'steel', 1, 0.03),
    box(hw - 0.15, -hd, hw - 0.1, -hd + 0.03, 0.6, 1.2, 'black', 2, { on: FRONT }),
    faceY(-hd + 0.03, rect(-hw + 0.1, 1.68, hw * 0.2, 1.82), 'screenOn', FRONT, 2),
  ];
}

function powderBooth(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, hd - 0.4, hw, hd, 0, 2.1, 'machineLight', 0),
    box(-hw, -hd, -hw + 0.05, hd - 0.4, 0.4, 2.1, 'machineLight', 0),
    box(hw - 0.05, -hd, hw, hd - 0.4, 0.4, 2.1, 'machineLight', 0),
    box(-hw, -hd, hw, hd - 0.4, 2.0, 2.1, 'machineLight', 0),
    box(-hw, -hd, hw, hd - 0.4, 0, 0.4, 'steelDark', 0),
    faceY(hd - 0.4, rect(-hw * 0.6, 0.7, hw * 0.6, 1.7), 'steelDark', FRONT, 2),
  ];
}

function laserCutter(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd, hw, hd, 0, 0.9, 'porcelain', 0),
    box(-hw, -hd, hw, hd, 0.9, 1.05, 'black', 0),
    decal(rect(-hw + 0.08, -hd + 0.08, hw * 0.55, hd - 0.08), 1.05, 'glass', 1),
    faceY(-hd, rect(hw * 0.6, 0.65, hw - 0.06, 0.85), 'screenOn', FRONT, 2),
  ];
}

function printerBox(w: number, d: number, h: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  const parts: Part[] = [box(-hw, -hd, hw, hd, 0, h, 'paper', 0), box(-hw, -hd, hw, hd, h, h + 0.04, 'plastic', 1)];
  const trays = h > 0.6 ? 3 : 1;
  for (let i = 0; i < trays; i += 1) {
    const z = 0.08 + i * ((h * 0.6) / trays);
    parts.push(faceY(-hd, rect(-hw + 0.04, z, hw - 0.04, z + (h * 0.6) / trays - 0.03), 'paper', FRONT, 1));
  }
  parts.push(faceY(-hd, rect(hw * 0.3, h - 0.12, hw - 0.05, h - 0.04), 'screenOn', FRONT, 2));
  return parts;
}

function smallBox(w: number, d: number, h: number, mat: Mat, screenMat: Mat | null = null): Part[] {
  const parts: Part[] = [box(-w / 2, -d / 2, w / 2, d / 2, 0, h, mat, 0)];
  if (screenMat) parts.push(faceY(-d / 2, rect(-w / 2 + 0.03, h * 0.25, w * 0.15, h - 0.04), screenMat, FRONT, 1));
  return parts;
}

function coffeeMachine(w: number, d: number): Part[] {
  const [hw, hd] = [w / 2, d / 2];
  return [
    box(-hw, -hd * 0.2, hw, hd, 0, 0.4, 'black', 0),
    box(-hw, -hd, hw, -hd * 0.2, 0.28, 0.4, 'black', 0),
    box(-hw, -hd, hw, -hd * 0.2, 0, 0.03, 'steel', 1),
    cylinder(0, -hd * 0.6, 0.04, 0.03, 0.12, 'porcelain', 2, 0.04, 8),
    faceY(-hd, rect(-hw * 0.6, 0.31, hw * 0.6, 0.37), 'screenOn', FRONT, 2),
  ];
}

function hood(w: number, d: number, low: number, high: number, mat: Mat): Part[] {
  return [box(-w / 2, -d / 2, w / 2, d / 2, low, high, mat, 0)];
}

/** A short straight flight inside a home (the data's internal stairs): steps rising along x. */
function internalStairs(w: number, d: number): Part[] {
  const steps = Math.max(3, Math.round(w / 0.25));
  const run = w / steps;
  return Array.from({ length: steps }, (_, i) =>
    box(-w / 2 + i * run, -d / 2, -w / 2 + (i + 1) * run, d / 2, 0, (i + 1) * 0.18, i % 2 ? 'woodLight' : 'wood', 0));
}

/** By category, for kinds without a model of their own. */
function fallback(category: string): Build {
  switch (category) {
    case 'machine': return (w, d, ctx) => enclosure(w, d, ctx, 1.8);
    case 'equipment': return (w, d) => smallBox(w, d, 1.0, 'steel');
    case 'fixture': return (w, d) => smallBox(w, d, 0.5, 'porcelain');
    default: return (w, d) => smallBox(w, d, 0.45, 'woodLight');
  }
}

const MODELS: Record<string, Build> = {
  // seating and tables
  chair: (w, d, ctx) => chair(w, d, ctx.room === 'office' || ctx.room === 'meeting_room' ? 'fabric' : 'wood', 'woodDark'),
  dining_chair: (w, d) => chair(w, d, 'wood', 'woodDark'),
  outdoor_chair: (w, d) => chair(w, d, 'steel', 'steelDark', 0.8),
  office_chair: (w, d) => officeChair(w, d),
  armchair: (w, d) => upholstered(w, d, 'fabricWarm'),
  sofa: (w, d) => upholstered(w, d, 'fabric'),
  bench: (w, d) => table(w, d, 0.45, 'wood', 'steelDark'),
  desk,
  meeting_table: (w, d) => table(w, d, 0.75, 'woodLight', 'steelDark', 0.05),
  dining_table: (w, d) => table(w, d, 0.75, 'wood', 'woodDark'),
  seminar_table: (w, d) => table(w, d, 0.75, 'woodLight', 'steelDark'),
  canteen_table: (w, d) => table(w, d, 0.75, 'porcelain', 'steelDark'),
  reading_table: (w, d) => table(w, d, 0.75, 'wood', 'woodDark'),
  coffee_table: (w, d) => table(w, d, 0.42, 'woodDark', 'woodDark', 0.05),
  outdoor_table: (w, d) => [cylinder(0, 0, 0.04, 0, 0.72, 'steelDark', 1, 0.04, 6),
    cylinder(0, 0, Math.min(w, d) / 2, 0.72, 0.75, 'steel', 0, Math.min(w, d) / 2, 12)],
  lecture_seating_row: lectureRow,
  lectern: (w, d) => [box(-w / 2, -d / 2 + 0.05, w / 2, d / 2, 0, 1.05, 'woodDark', 0),
    box(-w / 2, -d / 2, w / 2, d / 2, 1.05, 1.12, 'wood', 0)],
  reception_desk: reception,
  // storage
  wardrobe: (w, d, ctx) => cabinet(w, d, Math.min(2.0, (ctx.ceiling ?? 3) - 0.3), 'woodLight', Math.max(2, Math.round(w / 0.5))),
  built_in_wardrobe: (w, d, ctx) => cabinet(w, d, Math.min(2.3, (ctx.ceiling ?? 3) - 0.1), 'porcelain', Math.max(2, Math.round(w / 0.5))),
  shelf: (w, d) => shelves(w, d, 1.8, 'steel', 4, ['cardboard', 'rackBlue', 'paper']),
  bookshelf: (w, d) => shelves(w, d, 1.9, 'wood', 5, ['books1', 'books2', 'books3', 'paper']),
  paper_shelf: (w, d) => shelves(w, d, 1.8, 'steel', 5, ['paper']),
  filing_cabinet: (w, d) => drawers(w, d, 1.3, 'steel', 4),
  tool_cabinet: (w, d) => drawers(w, d, 1.0, 'rackBlue', 5),
  shoe_cabinet: (w, d) => cabinet(w, d, 1.0, 'woodLight', 2),
  chemical_cabinet: chemicalCabinet,
  locker,
  nightstand,
  tv_stand: tvStand,
  coat_rack: coatRack,
  // home
  bed,
  single_bed: bed,
  plant,
  waste_basket: (w, d) => [cylinder(0, 0, Math.min(w, d) * 0.4, 0, 0.45, 'plastic', 0, Math.min(w, d) * 0.4, 10),
    decal(ring(0, 0, Math.min(w, d) * 0.33, 10), 0.45, 'black', 2)],
  // kitchen
  fridge,
  stove,
  dishwasher: (w, d) => [...appliance(w, d, 0.85, 'steel'), faceY(-d / 2 + 0.02, rect(-w / 2 + 0.03, 0.74, w / 2 - 0.03, 0.82), 'black', FRONT, 2),
    box(-w / 2 + 0.1, -d / 2, w / 2 - 0.1, -d / 2 + 0.02, 0.68, 0.71, 'chrome', 2, { on: FRONT })],
  microwave: (w, d) => smallBox(w, d, 0.3, 'white', 'black'),
  kitchen_counter: (w, d) => counter(w, d, 'woodLight'),
  coffee_machine: coffeeMachine,
  serving_counter: counterWithGuard,
  water_dispenser: waterDispenser,
  vending_machine: vending,
  // bathroom
  toilet,
  sink,
  bathtub,
  shower,
  hand_dryer: (w, d) => hood(w, d, 1.0, 1.3, 'white'),
  washing_machine: washer,
  // office tech and lab
  whiteboard,
  display_screen: (w, d) => screen(w, d, 0.9, 1.75, 'screenOn'),
  projector_screen: (w, d, ctx) => [box(-w / 2, -d / 2, w / 2, d / 2, Math.min(2.3, (ctx.ceiling ?? 3) - 0.2), Math.min(2.4, (ctx.ceiling ?? 3) - 0.1), 'porcelain', 0),
    box(-w / 2 + 0.05, -d / 2 + 0.05, w / 2 - 0.05, d / 2 - 0.05, 1.0, Math.min(2.3, (ctx.ceiling ?? 3) - 0.2), 'porcelain', 0)],
  projector: (w, d, ctx) => hood(w, d, Math.min(2.4, (ctx.ceiling ?? 3) - 0.35), Math.min(2.55, (ctx.ceiling ?? 3) - 0.2), 'porcelain'),
  multifunction_printer: (w, d) => printerBox(w, d, 1.05),
  printer: (w, d) => printerBox(w, d, 0.32),
  server_rack: serverRack,
  ups_unit: (w, d) => smallBox(w, d, 1.0, 'black', 'screenOn'),
  lab_bench: (w, d) => workbench(w, d, 'lab'),
  fume_hood: fumeHood,
  microscope,
  oscilloscope_station: (w, d) => benchTop(w, d, 'scope'),
  soldering_station: (w, d) => benchTop(w, d, 'solder'),
  eyewash_station: eyewash,
  // factory
  forklift,
  pallet_jack: palletJack,
  pallet_rack: palletRack,
  conveyor,
  cnc_mill: (w, d, ctx) => enclosure(w, d, ctx, 2.4),
  cnc_lathe: (w, d, ctx) => enclosure(w, d, ctx, 2.0, 'machine'),
  milling_machine: millingMachine,
  drill_press: drillPress,
  press_brake: pressBrake,
  injection_moulding_machine: injectionMoulding,
  laser_cutter: laserCutter,
  waterjet_cutter: waterjet,
  welding_station: welding,
  robot_cell: robotCell,
  '3d_printer': printer3d,
  industrial_3d_printer: (w, d, ctx) => enclosure(w, d, ctx, 2.0, 'porcelain'),
  coordinate_measuring_machine: cmm,
  curing_oven: curingOven,
  powder_station: powderBooth,
  compressor,
  boiler,
  hvac_unit: hvac,
  electrical_panel: electricalPanel,
  assembly_station: (w, d) => workbench(w, d, 'assembly'),
  packing_station: (w, d) => workbench(w, d, 'packing'),
  workbench: (w, d) => workbench(w, d, 'plain'),
  inspection_bench: (w, d) => workbench(w, d, 'inspection'),
  forklift_charging_station: charger,
  // safety
  fire_extinguisher: extinguisher,
  defibrillator,
  internal_stairs: internalStairs,
  atm: (w, d) => [...smallBox(w, d, 1.6, 'steel'), faceY(-d / 2, rect(-w / 2 + 0.1, 1.1, w / 2 - 0.1, 1.4), 'screenOn', FRONT, 1)],
};

/** Kinds standing on something else (a counter, a desk, a bench): small appliances and instruments. */
export const SITS_ON_SURFACE = new Set(['coffee_machine', 'microwave', 'printer', 'microscope']);

/** The height of the surface a kind offers to things standing on it, when it has one. */
export function surfaceOf(type: string): number | null {
  switch (type) {
    case 'kitchen_counter': case 'serving_counter': case 'lab_bench': case 'workbench': case 'assembly_station':
    case 'packing_station': case 'inspection_bench': return 0.9;
    case 'desk': case 'meeting_table': case 'dining_table': case 'seminar_table': case 'canteen_table': case 'reading_table':
    case 'oscilloscope_station': case 'soldering_station': return 0.75;
    case 'sink': return 0.9;
    default: return null;
  }
}

export const MODELLED = Object.keys(MODELS);

export interface Model {
  key: string;
  parts: Part[];
  /** How tall it stands (metres). */
  height: number;
}

const built = new Map<string, Model>();

/** The model of a thing of this kind and size (shared between all the things of the same kind and size). */
export function modelOf(type: string, category: string | undefined, w: number, d: number, ctx: ModelContext = {}): Model {
  const key = `${type}|${w.toFixed(2)}|${d.toFixed(2)}|${ctx.room ?? ''}|${(ctx.ceiling ?? 0).toFixed(1)}`;
  let model = built.get(key);
  if (!model) {
    const raw = (MODELS[type] ?? fallback(category ?? ''))(w, d, ctx);
    const parts = raw.map((part) => clampToFootprint(part, w, d, ctx.ceiling));
    model = { key, parts, height: Math.max(0, ...parts.map((part) => part.z1)) };
    if (built.size > 5000) built.clear();
    built.set(key, model);
  }
  return model;
}

/** The raw parts of a kind, before they are made to fit (for the tests). */
export function rawParts(type: string, category: string | undefined, w: number, d: number, ctx: ModelContext = {}): Part[] {
  return (MODELS[type] ?? fallback(category ?? ''))(w, d, ctx);
}

/** Every part kept inside the real footprint and under the ceiling, outlines counter-clockwise. */
function clampToFootprint(part: Part, w: number, d: number, ceiling?: number): Part {
  const [hw, hd] = [w / 2, d / 2];
  const clampX = (x: number) => Math.max(-hw, Math.min(hw, x));
  const clampY = (y: number) => Math.max(-hd, Math.min(hd, y));
  const top = ceiling ? ceiling - 0.05 : Infinity;
  let base = part.base.map(([x, y]) => [clampX(x), clampY(y)] as Point);
  let area = 0;
  for (let i = 0; i < base.length; i += 1) {
    const [x1, y1] = base[i];
    const [x2, y2] = base[(i + 1) % base.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) base = [...base].reverse();
  const upright = part.upright && {
    ...part.upright,
    at: part.upright.axis === 'y' ? clampY(part.upright.at) : clampX(part.upright.at),
    outline: part.upright.outline.map(([u, z]) => [part.upright!.axis === 'y' ? clampX(u) : clampY(u), Math.min(top, z)] as Point),
  };
  return { ...part, base, z0: Math.min(part.z0, top), z1: Math.min(part.z1, top), upright };
}

