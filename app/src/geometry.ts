/** Pure geometry for drawing: metres (x right, y up) to screen pixels (x right, y down). */
import type { Point } from './api';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Transform {
  scale: number; // pixels per metre
  offsetX: number;
  offsetY: number;
  bounds: Bounds;
}

export function boundsOf(points: Point[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function grow(bounds: Bounds, margin: number): Bounds {
  return { minX: bounds.minX - margin, minY: bounds.minY - margin, maxX: bounds.maxX + margin, maxY: bounds.maxY + margin };
}

/** Fit bounds into a width x height viewport, keeping the aspect ratio and centring. */
export function fit(bounds: Bounds, width: number, height: number, padding = 16): Transform {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);
  const offsetX = (width - spanX * scale) / 2 - bounds.minX * scale;
  const offsetY = (height - spanY * scale) / 2 + bounds.maxY * scale;
  return { scale, offsetX, offsetY, bounds };
}

export function toScreen(t: Transform, [x, y]: Point): Point {
  return [t.offsetX + x * t.scale, t.offsetY - y * t.scale];
}

export function toWorld(t: Transform, [sx, sy]: Point): Point {
  return [(sx - t.offsetX) / t.scale, (t.offsetY - sy) / t.scale];
}

const n = (value: number) => (Math.round(value * 100) / 100).toString();

/** SVG path for a closed polygon. */
export function polygonPath(t: Transform, polygon: Point[]): string {
  if (polygon.length === 0) return '';
  return (
    polygon.map((p, i) => {
      const [x, y] = toScreen(t, p);
      return `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`;
    }).join(' ') + ' Z'
  );
}

/** SVG path for an open line (a route piece). */
export function linePath(t: Transform, points: Point[]): string {
  return points
    .map((p, i) => {
      const [x, y] = toScreen(t, p);
      return `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`;
    })
    .join(' ');
}

export function lineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** Centre of a polygon's bounding box (for labels). */
export function centre(polygon: Point[]): Point {
  const b = boundsOf(polygon);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/** Isometric drawing of plan coordinates (metres) at a height z: the "block" look of the outside view.
 * The building is turned by `angle` (radians) about its centre before projecting. */
export interface Iso {
  angle: number;
  centre: Point;
}

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

export function isoProject(iso: Iso, [x, y]: Point, z: number): Point {
  const dx = x - iso.centre[0];
  const dy = y - iso.centre[1];
  const rx = dx * Math.cos(iso.angle) - dy * Math.sin(iso.angle);
  const ry = dx * Math.sin(iso.angle) + dy * Math.cos(iso.angle);
  return [(rx - ry) * COS30, -(rx + ry) * SIN30 - z]; // screen: right, down
}

/** How far a wall is from the viewer (bigger = nearer, drawn later). */
export function isoDepth(iso: Iso, [x, y]: Point): number {
  const dx = x - iso.centre[0];
  const dy = y - iso.centre[1];
  const rx = dx * Math.cos(iso.angle) - dy * Math.sin(iso.angle);
  const ry = dx * Math.sin(iso.angle) + dy * Math.cos(iso.angle);
  return -(rx + ry);
}

/** The rectangle a thing stands on: width along x and depth along y, turned counter-clockwise about its centre. */
export function assetRect([x, y]: Point, { width_m, depth_m, rotation_deg }: { width_m: number; depth_m: number; rotation_deg: number }): Point[] {
  const a = (rotation_deg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Point[]).map(([u, v]) => {
    const [dx, dy] = [(u * width_m) / 2, (v * depth_m) / 2];
    return [x + dx * c - dy * s, y + dx * s + dy * c];
  });
}

/** Signed area (positive = counter-clockwise in plan coordinates). */
export function signedArea(polygon: Point[]): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/** A camera looking down at a floor at an angle, with perspective: the 3D floor view.
 * Screen = (ox, oy) + scale * (perspective projection of the plan point turned by yaw). */
export interface Camera {
  target: Point; // the plan point the camera looks at (metres)
  yaw: number; // radians the plan is turned (0 = north up)
  tilt: number; // radians from looking straight down
  distance: number; // metres from the target; smaller = stronger perspective
  scale: number; // pixels per metre at the target
  ox: number; // where the target is on screen
  oy: number;
}

const NEAR = 0.25; // nothing is drawn closer than this fraction of the camera distance

function cameraView(cam: Camera, [x, y]: Point, z: number) {
  const dx = x - cam.target[0];
  const dy = y - cam.target[1];
  const c = Math.cos(cam.yaw);
  const s = Math.sin(cam.yaw);
  const rx = dx * c - dy * s;
  const ry = dx * s + dy * c; // forward, away from the viewer
  return {
    rx,
    up: ry * Math.cos(cam.tilt) + z * Math.sin(cam.tilt),
    depth: cam.distance + ry * Math.sin(cam.tilt) - z * Math.cos(cam.tilt),
  };
}

/** Distance from the camera (bigger = farther away, drawn first). */
export function depthOf(cam: Camera, p: Point, z = 0): number {
  return cameraView(cam, p, z).depth;
}

/** Pixels per metre at a point (things farther away are smaller). */
export function pixelsPerMetre(cam: Camera, p: Point, z = 0): number {
  return (cam.scale * cam.distance) / Math.max(depthOf(cam, p, z), cam.distance * NEAR);
}

export function project3d(cam: Camera, p: Point, z = 0): Point {
  const { rx, up, depth } = cameraView(cam, p, z);
  const k = (cam.scale * cam.distance) / Math.max(depth, cam.distance * NEAR);
  return [cam.ox + rx * k, cam.oy - up * k];
}

/** The floor point (z = 0) under a screen point. */
export function unproject3d(cam: Camera, [sx, sy]: Point): Point {
  const px = (sx - cam.ox) / cam.scale;
  const py = (sy - cam.oy) / cam.scale;
  const D = cam.distance;
  const ry = (-py * D) / (D * Math.cos(cam.tilt) + py * Math.sin(cam.tilt));
  const rx = (px * (D + ry * Math.sin(cam.tilt))) / D;
  const c = Math.cos(cam.yaw);
  const s = Math.sin(cam.yaw);
  return [cam.target[0] + rx * c + ry * s, cam.target[1] - rx * s + ry * c];
}

/** The part of a floor polygon (at height z) in front of the camera's near plane. */
export function clipNear(cam: Camera, polygon: Point[], z = 0): Point[] {
  const limit = cam.distance * NEAR;
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const da = depthOf(cam, a, z) - limit;
    const db = depthOf(cam, b, z) - limit;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export type Point3 = [number, number, number];

const PERSPECTIVE = 1.8; // camera distance as a multiple of what is shown

/** Look at these points from a tilted camera turned by yaw, fitted into width x height. */
export function fitCamera(points: Point3[], width: number, height: number, yaw: number, tilt: number,
                          padding = 32): Camera {
  const plan = boundsOf(points.map(([x, y]) => [x, y] as Point));
  const span = Math.max(plan.maxX - plan.minX, plan.maxY - plan.minY, 8);
  const base: Camera = {
    target: [(plan.minX + plan.maxX) / 2, (plan.minY + plan.maxY) / 2], yaw, tilt,
    distance: span * PERSPECTIVE, scale: 1, ox: 0, oy: 0,
  };
  const box = boundsOf(points.map(([x, y, z]) => project3d(base, [x, y], z)));
  const scale = Math.min((width - 2 * padding) / Math.max(box.maxX - box.minX, 1e-6),
                         (height - 2 * padding) / Math.max(box.maxY - box.minY, 1e-6));
  return { ...base, scale, ox: width / 2 - scale * (box.minX + box.maxX) / 2,
           oy: height / 2 - scale * (box.minY + box.maxY) / 2 };
}

/** The camera that shows the points biggest, preferring one where the walk goes away from the viewer
 * (start low on the screen, destination higher up), like walking into the picture. */
export function chooseCamera(points: Point3[], width: number, height: number, tilt: number,
                             start?: Point | null, end?: Point | null): Camera {
  let best: Camera | null = null;
  let bestScore = -Infinity;
  for (let quarter = 0; quarter < 4; quarter += 1) {
    for (const turn of [-0.35, 0.35]) {
      const cam = fitCamera(points, width, height, quarter * (Math.PI / 2) + turn, tilt);
      let score = cam.scale;
      if (start && end && project3d(cam, start)[1] < project3d(cam, end)[1]) score *= 0.85;
      if (score > bestScore + 1e-9) {
        best = cam;
        bestScore = score;
      }
    }
  }
  return best!;
}

/** The walls of a floor: every polygon edge once, with gaps where the doors and openings are. */
export function wallSegments(polygons: Point[][], openings: { position: Point; width_m?: number }[],
                             reach = 0.4): [Point, Point][] {
  const seen = new Set<string>();
  const out: [Point, Point][] = [];
  const key = ([x, y]: Point) => `${Math.round(x * 20)},${Math.round(y * 20)}`;
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const edge = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const gaps: [number, number][] = [];
      for (const opening of openings) {
        const [px, py] = opening.position;
        const t = ((px - a[0]) * (b[0] - a[0]) + (py - a[1]) * (b[1] - a[1])) / (length * length);
        if (t < 0 || t > 1) continue;
        const off = Math.hypot(a[0] + (b[0] - a[0]) * t - px, a[1] + (b[1] - a[1]) * t - py);
        if (off > reach) continue;
        const half = (opening.width_m ?? 0.9) / 2 / length;
        gaps.push([Math.max(0, t - half), Math.min(1, t + half)]);
      }
      gaps.sort((g, h) => g[0] - h[0]);
      let from = 0;
      const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (const [g0, g1] of gaps) {
        if (g0 > from + 1e-6) out.push([at(from), at(g0)]);
        from = Math.max(from, g1);
      }
      if (from < 1 - 1e-6) out.push([at(from), at(1)]);
    }
  }
  return out;
}

/** A flat band of the given half width along a line (the route on the floor), as a polygon. */
export function ribbon(points: Point[], halfWidth: number): Point[] {
  const line = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
  if (line.length < 2) return [];
  const normals = line.slice(1).map((p, i) => {
    const dx = p[0] - line[i][0];
    const dy = p[1] - line[i][1];
    const l = Math.hypot(dx, dy);
    return [-dy / l, dx / l] as Point;
  });
  const left: Point[] = [];
  const right: Point[] = [];
  line.forEach((p, i) => {
    const n1 = normals[Math.max(0, i - 1)];
    const n2 = normals[Math.min(normals.length - 1, i)];
    let nx = n1[0] + n2[0];
    let ny = n1[1] + n2[1];
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) {
      nx = n2[0];
      ny = n2[1];
    } else {
      nx /= l;
      ny /= l;
    }
    const miter = halfWidth / Math.max(nx * n2[0] + ny * n2[1], 0.4); // keep sharp corners from spiking
    left.push([p[0] + nx * miter, p[1] + ny * miter]);
    right.push([p[0] - nx * miter, p[1] - ny * miter]);
  });
  return [...left, ...right.reverse()];
}

/** The camera after the world was turned by angle about a plan point: that point stays where it is on screen. */
export function rotateAbout(cam: Camera, pivot: Point, angle: number): Camera {
  const dx = pivot[0] - cam.target[0];
  const dy = pivot[1] - cam.target[1];
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  return { ...cam, yaw: cam.yaw + angle, target: [pivot[0] - (dx * c - dy * s), pivot[1] - (dx * s + dy * c)] };
}

/** The camera after zooming by k about the screen centre and shifting by (tx, ty) pixels. */
export function moveCamera(cam: Camera, k: number, tx: number, ty: number, width: number, height: number): Camera {
  return { ...cam, scale: cam.scale * k, ox: width / 2 + k * (cam.ox - width / 2) + tx,
           oy: height / 2 + k * (cam.oy - height / 2) + ty };
}

/** The same for the flat 2D view. */
export function moveTransform(t: Transform, k: number, tx: number, ty: number, width: number, height: number): Transform {
  return { ...t, scale: t.scale * k, offsetX: width / 2 + k * (t.offsetX - width / 2) + tx,
           offsetY: height / 2 + k * (t.offsetY - height / 2) + ty };
}

/** Whether a point is inside a polygon (even-odd rule). */
export function pointInPolygon([px, py]: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
