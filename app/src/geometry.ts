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
