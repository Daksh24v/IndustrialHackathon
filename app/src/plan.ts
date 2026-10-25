/** The 2D plan drawn as an architect's plan, from the same shapes as the 3D floor: each thing as its parts seen
 * from straight above (higher parts over lower ones, what hangs overhead as a dashed outline), stairs as their
 * treads with UP and DN arrows and a break line where the plan's cut crosses the flight, doors as an open leaf with
 * the arc it swings through, and walls as filled bands with their real thickness. Everything here is in plan metres;
 * the view only has to put it on the screen. */
import type { Point } from './api';
import type { Part } from './models/kit';
import { colourOf, type Mat } from './models/materials';
import type { Stairs } from './stairs';
import { type DoorLeaf, INNER_M, OUTER_M, type Wall } from './walls';

/** Parts starting this high hang overhead (wall cupboards, hoods, shelves above a desk): drawn dashed, unfilled. */
export const OVERHEAD_M = 1.5;
const Z_BAND = 0.05; // parts within this much height of each other are drawn together

export interface PlanShape {
  ring: Point[];
  z: number; // the height of its top: higher shapes are drawn over lower ones
  mat: Mat;
}

export interface PlanSymbol {
  shapes: PlanShape[]; // filled, low to high
  overhead: Point[][]; // dashed outlines
}

/** A placed model seen from above: every part up to `detail`, turned and moved to where the thing stands. Parts on
 * a face (handles, dials) and upright panels (screens, portholes) are edge-on from above and left out. */
export function partsFromAbove(parts: Part[], at: Point, angle: number, detail: number, lift = 0): PlanSymbol {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const toWorld = ([x, y]: Point): Point => [at[0] + x * c - y * s, at[1] + x * s + y * c];
  const shapes: PlanShape[] = [];
  const overhead: Point[][] = [];
  for (const part of parts) {
    if (part.detail > detail || part.upright || part.on) continue;
    const ring = part.base.map(toWorld);
    if (part.z0 >= OVERHEAD_M && part.z1 > part.z0) overhead.push(ring);
    else shapes.push({ ring, z: part.z1 + lift, mat: part.top ?? part.mat });
  }
  shapes.sort((a, b) => a.z - b.z);
  return { shapes, overhead };
}

export interface PlanLayer {
  key: string;
  rings: Point[][];
  fill: string;
}

/** Shapes from many things in drawing order: one layer per height band and colour, low to high, so a whole floor is
 * a few hundred paths and a coffee machine still lands on its counter. */
export function layered(shapes: PlanShape[]): PlanLayer[] {
  const sorted = [...shapes].sort((a, b) => a.z - b.z);
  const bands = new Map<string, PlanLayer>();
  for (const shape of sorted) {
    const band = Math.floor(shape.z / Z_BAND);
    const fill = colourOf(shape.mat);
    const key = `${band}|${fill}`;
    const layer = bands.get(key);
    if (layer) layer.rings.push(shape.ring);
    else bands.set(key, { key, rings: [shape.ring], fill });
  }
  return [...bands.values()]; // a Map keeps the order layers were made in: low to high
}

export interface StairPlan {
  treads: PlanShape[]; // the solid steps below the cut, and the flight going down
  above: Point[][]; // the steps above the cut (dashed)
  breaks: Point[][];
  arrows: { line: Point[]; head: Point[]; up: boolean; tag: Point }[];
  voids: Point[][];
}

/** Stairs as a plan shows them: treads below the cut solid, those above dashed, the cut as a zig-zag, and arrows
 * from the door end saying UP or DN. */
export function stairPlan(stairs: Stairs): StairPlan {
  const treads = partsFromAbove(stairs.parts, stairs.centre, stairs.angle, 2).shapes;
  const flat = (points: [number, number, number][]): Point[] => points.map(([x, y]) => [x, y]);
  const arrows = stairs.arrows.map(({ points, up }) => {
    const line = flat(points);
    const [a, b] = line.slice(-2);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [ux, uy] = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const size = Math.min(0.3, Math.max(0.15, stairs.tread));
    const head: Point[] = [[b[0] - ux * size - uy * size * 0.6, b[1] - uy * size + ux * size * 0.6], b,
                           [b[0] - ux * size + uy * size * 0.6, b[1] - uy * size - ux * size * 0.6]];
    return { line, head, up, tag: line[0] };
  });
  return { treads, above: stairs.ghosts.map(flat), breaks: stairs.breaks.map(flat), arrows, voids: stairs.voids };
}

/** A wall as the band it covers on the plan: its length, its real thickness. */
export function wallBand(wall: Wall): Point[] {
  const t = (wall.outer ? OUTER_M : INNER_M) / 2;
  const [c, s] = [Math.cos(wall.angle), Math.sin(wall.angle)];
  const [nx, ny] = [-s * t, c * t];
  const [a, b] = [wall.a, wall.b];
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

/** A door as a plan shows it: the open leaf (a line from the hinge into the room) and its swing. */
export function doorSymbol(leaf: DoorLeaf): { leaf: Point[]; swing: Point[] } {
  const tip: Point = [leaf.centre[0] + Math.cos(leaf.angle) * leaf.width, leaf.centre[1] + Math.sin(leaf.angle) * leaf.width];
  return { leaf: [leaf.centre, tip], swing: leaf.arc };
}
