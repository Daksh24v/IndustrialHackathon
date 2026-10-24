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
