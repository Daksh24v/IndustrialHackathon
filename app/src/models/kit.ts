/** The building blocks of the 3D things in the rooms: upright prisms (a box, a cylinder, a thin panel) and flat
 * decals, in the thing's own metres. Its footprint spans x from -w/2 to w/2 and y from -d/2 to d/2, with +y the back
 * (the side against the wall, as in the data) and the front facing -y; z is the height above the floor. */
import type { Point } from '../api';
import type { Mat } from './materials';

/** How close you must be to see a part: 0 the shape (always), 1 the model, 2 the small details. */
export type Detail = 0 | 1 | 2;

export interface Part {
  base: Point[]; // the outline, counter-clockwise
  z0: number;
  z1: number; // z0 === z1: a flat decal
  mat: Mat;
  top?: Mat; // a different colour on top (a worktop, a mattress)
  detail: Detail;
  /** Sits on one face of the thing (a handle, a dial): shown only when that face is turned to you. */
  on?: Point;
  /** A flat shape standing upright on a face (a porthole, an oven window, a screen): its outline in (across, z)
   * on the plane y = at (axis y) or x = at (axis x); base, z0 and z1 then only bound it. */
  upright?: { axis: 'x' | 'y'; at: number; outline: Point[] };
}

export const FRONT: Point = [0, -1];
export const BACK: Point = [0, 1];

export function box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, mat: Mat,
                    detail: Detail = 1, extra: Partial<Part> = {}): Part {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  return { base: [[ax, ay], [bx, ay], [bx, by], [ax, by]], z0, z1, mat, detail, ...extra };
}

/** An upright cylinder (an n-sided prism): legs, pots, bins, bowls, gas bottles. */
export function cylinder(cx: number, cy: number, rx: number, z0: number, z1: number, mat: Mat, detail: Detail = 1,
                         ry = rx, sides = 10, extra: Partial<Part> = {}): Part {
  const base: Point[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * 2 * Math.PI;
    base.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return { base, z0, z1, mat, detail, ...extra };
}

/** A flat shape lying on a surface at height z (burners on a stove, a basin, a mat). */
export function decal(base: Point[], z: number, mat: Mat, detail: Detail = 2, extra: Partial<Part> = {}): Part {
  return { base, z0: z, z1: z, mat, detail, ...extra };
}

export function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export function ring(cx: number, cy: number, r: number, sides = 10, ry = r): Point[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + ry * Math.sin(a)] as Point;
  });
}

/** Something on the front face (y = -d/2): a panel standing a few millimetres proud of it, from x0 to x1 and z0 to z1. */
export function onFront(d: number, x0: number, x1: number, z0: number, z1: number, mat: Mat, detail: Detail = 2,
                        proud = 0.02): Part {
  return box(x0, -d / 2, x1, -d / 2 + proud, z0, z1, mat, detail, { on: FRONT });
}

/** A flat shape on the plane y = at, seen from the side `on` points to; outline in (x, z). */
export function faceY(at: number, outline: Point[], mat: Mat, on: Point = FRONT, detail: Detail = 2): Part {
  return flatUpright('y', at, outline, mat, on, detail);
}

/** A flat shape on the plane x = at; outline in (y, z). */
export function faceX(at: number, outline: Point[], mat: Mat, on: Point, detail: Detail = 2): Part {
  return flatUpright('x', at, outline, mat, on, detail);
}

function flatUpright(axis: 'x' | 'y', at: number, outline: Point[], mat: Mat, on: Point, detail: Detail): Part {
  const us = outline.map(([u]) => u);
  const zs = outline.map(([, z]) => z);
  const [u0, u1] = [Math.min(...us), Math.max(...us)];
  const base: Point[] = axis === 'y' ? [[u0, at], [u1, at], [u1, at], [u0, at]] : [[at, u0], [at, u0], [at, u1], [at, u1]];
  return { base, z0: Math.min(...zs), z1: Math.max(...zs), mat, detail, on, upright: { axis, at, outline } };
}

/** A circle standing upright (in (across, z)), e.g. a washing machine's door. */
export function disc(cu: number, cz: number, r: number, sides = 12): Point[] {
  return ring(cu, cz, r, sides);
}
