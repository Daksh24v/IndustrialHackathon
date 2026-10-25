/** Drawing the parts of a thing (models/kit.ts) in any of the views: the 3D floor's perspective camera or the
 * building stack's isometric view. A View3D says where a point lands on the screen, which way the viewer is and
 * where the light comes from; the parts are placed (turned and moved to where the thing stands), the faces turned
 * away are dropped, the rest are shaded by the light and put in the order they must be painted (far to near, what
 * stands on something after it). */
import type { Point } from '../api';
import { type Camera, depthOf, project3d } from '../geometry';
import { isoDepth, isoProject, type Iso } from '../geometry';
import { shade } from '../theme';
import type { Part } from './kit';
import { alphaOf, colourOf, type Mat } from './materials';

export interface View3D {
  project(p: Point, z: number): Point;
  /** Bigger = farther from the viewer. */
  depth(p: Point, z: number): number;
  /** The way to the viewer along the floor, from p (not normalised). */
  toViewer(p: Point): Point;
  /** How lit an upright face is, from its outward normal: 0 (away from the light) to 1 (facing it). */
  shine(normal: Point): number;
  /** Whether the viewer is above height z (tops at z are seen). */
  above(z: number): boolean;
}

const LIGHT: Point = [0.6, -0.8]; // in the view: from the upper left, as on the walls
const SHADES = 6; // the light comes in this many steps: few colours, so faces can be drawn together

function lit(angle: number, [nx, ny]: Point): number {
  const l = Math.hypot(nx, ny) || 1;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rx = (nx * c - ny * s) / l;
  const ry = (nx * s + ny * c) / l;
  return Math.round((0.5 + 0.5 * (rx * LIGHT[0] + ry * LIGHT[1])) * SHADES) / SHADES;
}

/** The 3D floor's camera as a View3D. The camera stands behind and above its target (see geometry.ts). */
export function cameraView(cam: Camera): View3D {
  const back = cam.distance * Math.sin(cam.tilt);
  const eye: Point = [cam.target[0] - back * Math.sin(cam.yaw), cam.target[1] - back * Math.cos(cam.yaw)];
  const height = cam.distance * Math.cos(cam.tilt);
  return {
    project: (p, z) => project3d(cam, p, z),
    depth: (p, z) => depthOf(cam, p, z),
    toViewer: ([x, y]) => [eye[0] - x, eye[1] - y],
    shine: (normal) => lit(cam.yaw, normal),
    above: (z) => height > z,
  };
}

/** The building stack's isometric view as a View3D; toScreen maps the isometric drawing onto the screen. */
export function isoView(iso: Iso, toScreen: (p: Point) => Point): View3D {
  const [c, s] = [Math.cos(iso.angle), Math.sin(iso.angle)];
  const towards: Point = [-c - s, s - c]; // the viewer looks from -x, -y of the turned plan
  return {
    project: (p, z) => toScreen(isoProject(iso, p, z)),
    depth: (p, z) => -isoDepth(iso, p) - z * 1e-3,
    toViewer: () => towards,
    shine: (normal) => lit(iso.angle, normal),
    above: () => true,
  };
}

export interface Placement {
  at: Point; // where the thing's middle stands (metres)
  angle: number; // radians, counter-clockwise
  z?: number; // stands this high (on a counter, on a desk)
}

export interface Face {
  d: string;
  fill: string;
  stroke: string;
  opacity: number;
}

const n = (value: number) => (Math.round(value * 10) / 10).toString();

function path(points: Point[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join(' ') + ' Z';
}

function bounds(part: Part) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of part.base) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1, z0: part.z0, z1: part.z1 };
}

const EPS = 1e-6;

/** Whether part a must be painted before part b, seen from far away in direction v (the thing's own frame, the
 * viewer above): yes when a plane parts them and b is on the viewer's side; null when nothing parts them. */
export function paintsBefore(a: Part, b: Part, [vx, vy]: Point): boolean | null {
  const p = bounds(a);
  const q = bounds(b);
  if (p.z1 <= q.z0 + EPS && overlaps(p, q)) return true; // b stands on a
  if (q.z1 <= p.z0 + EPS && overlaps(p, q)) return false;
  if (p.x1 <= q.x0 + EPS && Math.abs(vx) > EPS) return vx > 0;
  if (q.x1 <= p.x0 + EPS && Math.abs(vx) > EPS) return vx < 0;
  if (p.y1 <= q.y0 + EPS && Math.abs(vy) > EPS) return vy > 0;
  if (q.y1 <= p.y0 + EPS && Math.abs(vy) > EPS) return vy < 0;
  if (p.z1 <= q.z0 + EPS) return true;
  if (q.z1 <= p.z0 + EPS) return false;
  return null;
}

function overlaps(p: ReturnType<typeof bounds>, q: ReturnType<typeof bounds>): boolean {
  return p.x0 < q.x1 - EPS && q.x0 < p.x1 - EPS && p.y0 < q.y1 - EPS && q.y0 < p.y1 - EPS;
}

/** The painting order of a model's parts seen from direction v (its own frame): a topological order of
 * paintsBefore, ties broken far to near; parts sitting on a face come after the rest. */
export function paintOrder(parts: Part[], v: Point): number[] {
  const count = parts.length;
  const far = parts.map((part) => {
    const b = bounds(part);
    return -(((b.x0 + b.x1) / 2) * v[0] + ((b.y0 + b.y1) / 2) * v[1]) - (b.z0 + b.z1) * 0.01; // bigger = farther
  });
  const after: number[][] = parts.map(() => []);
  const waiting = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      let first = paintsBefore(parts[i], parts[j], v);
      if (first === null) {
        if (!!parts[i].on !== !!parts[j].on) first = !parts[i].on;
        else continue;
      }
      const [a, b] = first ? [i, j] : [j, i];
      after[a].push(b);
      waiting[b] += 1;
    }
  }
  const done = new Array<boolean>(count).fill(false);
  const order: number[] = [];
  while (order.length < count) {
    let pick = -1;
    for (let i = 0; i < count; i += 1) {
      if (done[i] || waiting[i] > 0) continue;
      if (pick < 0 || far[i] > far[pick]) pick = i;
    }
    if (pick < 0) { // a cycle (parts that cross): take the farthest left
      for (let i = 0; i < count; i += 1) if (!done[i] && (pick < 0 || far[i] > far[pick])) pick = i;
    }
    done[pick] = true;
    order.push(pick);
    for (const next of after[pick]) waiting[next] -= 1;
  }
  return order;
}

const BUCKETS = 32;
const orders = new Map<string, number[]>();

/** paintOrder, kept for each model and each of 32 directions it is seen from (identical chairs share it). The
 * number of parts is part of the name: two views may give one model (a staircase) a different set of parts, and an
 * order kept for the other set would point at parts that aren't there. */
export function cachedOrder(key: string, parts: Part[], v: Point): number[] {
  const bucket = Math.round(((Math.atan2(v[1], v[0]) + Math.PI) / (2 * Math.PI)) * BUCKETS) % BUCKETS;
  const id = `${key}#${parts.length}#${bucket}`;
  let order = orders.get(id);
  if (!order) {
    const a = (bucket / BUCKETS) * 2 * Math.PI - Math.PI;
    order = paintOrder(parts, [Math.cos(a), Math.sin(a)]);
    if (orders.size > 20000) orders.clear();
    orders.set(id, order);
  }
  return order;
}

export interface Look {
  /** 1 = as is; below 1 the whole model is lighter or darker (the target, things off the route). */
  tint?: (mat: Mat) => string;
}

/** The faces of a model placed in a view, in painting order, showing parts up to the given detail. */
export function modelFaces(key: string, parts: Part[], place: Placement, view: View3D, detail: number,
                           look: Look = {}): Face[] {
  const [c, s] = [Math.cos(place.angle), Math.sin(place.angle)];
  const lift = place.z ?? 0;
  const toWorld = ([x, y]: Point): Point => [place.at[0] + x * c - y * s, place.at[1] + x * s + y * c];
  const [wx, wy] = view.toViewer(place.at);
  const v: Point = [wx * c + wy * s, -wx * s + wy * c]; // the viewer's way in the thing's own frame
  const faces: Face[] = [];
  for (const index of cachedOrder(key, parts, v)) {
    const part = parts[index];
    if (!part || part.detail > detail) continue;
    if (part.on && part.on[0] * v[0] + part.on[1] * v[1] <= 0) continue; // on a face turned away
    const colour = look.tint ? look.tint(part.mat) : colourOf(part.mat);
    const opacity = alphaOf(part.mat);
    const z0 = part.z0 + lift;
    const z1 = part.z1 + lift;
    if (part.upright) {
      const { axis, at, outline } = part.upright;
      const screen = outline.map(([u, z]) => view.project(toWorld(axis === 'y' ? [u, at] : [at, u]), z + lift));
      const normal = part.on ?? [0, -1];
      const fill = shade(colour, 0.7 + 0.3 * view.shine([normal[0] * c - normal[1] * s, normal[0] * s + normal[1] * c]));
      faces.push({ d: path(screen), fill, stroke: shade(colour, 0.5), opacity });
      continue;
    }
    const ring = part.base.map(toWorld);
    if (z1 > z0) {
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const outward: Point = [b[1] - a[1], -(b[0] - a[0])];
        const [tx, ty] = view.toViewer([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        if (outward[0] * tx + outward[1] * ty <= 0) return; // turned away
        const quad = [view.project(a, z0), view.project(b, z0), view.project(b, z1), view.project(a, z1)];
        const fill = shade(colour, 0.6 + 0.3 * view.shine(outward));
        faces.push({ d: path(quad), fill, stroke: shade(colour, 0.45), opacity });
      });
    }
    if (view.above(z1)) {
      const top = look.tint && part.top ? look.tint(part.top) : part.top ? colourOf(part.top) : colour;
      faces.push({ d: path(ring.map((p) => view.project(p, z1))), fill: shade(top, 1), stroke: shade(top, 0.62), opacity });
    }
  }
  return faces;
}
