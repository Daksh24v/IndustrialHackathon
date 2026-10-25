/** The walls of a floor as an architect draws them: with thickness (outside walls thicker), standing full height
 * where they are the far side of the building (you see their inside face, with windows), cut down to the plan's
 * cut height everywhere else so you can see into the rooms, and with the cut drawn as a solid cap. Doors get an
 * open leaf and the arc it swings through, into the room rather than the corridor. */
import type { Opening, Point, Space } from './api';
import { pointInPolygon, wallSegments } from './geometry';
import { box, faceY, type Part, rect } from './models/kit';
import { CUT_M } from './stairs';

export const OUTER_M = 0.3;
export const INNER_M = 0.12;
const SHADOW_M = 0.18; // the soft shadow along the foot of a wall, on each side it shows
export const FULL_M = 2.7; // a full wall, as far as the ceiling of a floor allows
export const LOW_M = 0.4;
export type WallMode = 'cutaway' | 'low' | 'full';

export interface Wall {
  key: string;
  a: Point;
  b: Point;
  centre: Point;
  angle: number; // along a → b
  length: number;
  outer: boolean;
  /** For outside walls: the unit normal pointing into the building. */
  inward: Point | null;
  /** Windows along it (from the middle, metres), for the outside walls of rooms that have them. */
  windows: [number, number][];
}

const WINDOW_W = 1.2;
const WINDOW_EVERY = 2.6;
const NO_WINDOWS = new Set(['toilet', 'bathroom', 'stairwell', 'lift', 'server_room', 'storage', 'technical_room', 'corridor']);

/** The walls of the rooms, each once, with gaps at the openings; which are outside walls, and their windows. */
export function floorWalls(spaces: Space[], openings: { position: Point; width_m?: number }[], footprints: Point[][]): Wall[] {
  const inBuilding = (p: Point) => footprints.some((ring) => pointInPolygon(p, ring));
  const roomAt = (p: Point) => spaces.find((space) => pointInPolygon(p, space.polygon));
  return wallSegments(spaces.map((space) => space.polygon), openings).flatMap(([a, b], i) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 0.05) return [];
    const along: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const left: Point = [-along[1], along[0]];
    const centre: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const probe = (side: number): Point => [centre[0] + left[0] * 0.35 * side, centre[1] + left[1] * 0.35 * side];
    const [inLeft, inRight] = [inBuilding(probe(1)), inBuilding(probe(-1))];
    const outer = footprints.length > 0 && inLeft !== inRight;
    const inward: Point | null = outer ? (inLeft ? left : [-left[0], -left[1]]) : null;
    const windows: [number, number][] = [];
    if (outer && inward && length >= WINDOW_W + 0.4) {
      const room = roomAt([centre[0] + inward[0] * 0.35, centre[1] + inward[1] * 0.35]);
      if (room && room.type !== 'stair' && room.type !== 'lift' && !NO_WINDOWS.has(room.room_type)) {
        const count = Math.max(1, Math.floor((length + WINDOW_EVERY - WINDOW_W - 0.4) / WINDOW_EVERY));
        const span = (count - 1) * WINDOW_EVERY;
        for (let k = 0; k < count; k += 1) {
          const mid = -span / 2 + k * WINDOW_EVERY;
          windows.push([mid - WINDOW_W / 2, mid + WINDOW_W / 2]);
        }
      }
    }
    return [{ key: `w${i}`, a, b, centre, angle: Math.atan2(along[1], along[0]), length, outer, inward, windows }];
  });
}

/** How tall a wall stands seen from where the viewer is: the far outside walls full height, the rest cut. */
export function wallHeight(wall: Wall, toViewer: Point, mode: WallMode, storey: number): number {
  const full = Math.min(FULL_M, storey - 0.1);
  if (mode === 'low') return LOW_M;
  if (mode === 'full') return full;
  if (!wall.inward) return Math.min(CUT_M, full);
  const facing = wall.inward[0] * toViewer[0] + wall.inward[1] * toViewer[1];
  return facing > 0 ? full : Math.min(CUT_M, full); // its inside face turned to you: it is the far side
}

/** A wall as parts, in its own frame (x along it from its middle, y across, +y into the building for outside walls),
 * with its windows on the inside face. */
export function wallParts(wall: Wall, height: number): Part[] {
  const t = (wall.outer ? OUTER_M : INNER_M) / 2;
  const half = wall.length / 2;
  const cap = height < FULL_M - 0.2 ? 'wallCap' : 'wall';
  const parts: Part[] = [box(-half, -t, half, t, 0, height, 'wall', 0, { top: cap })];
  if (!wall.inward || height < 2.2) return parts;
  // which local side is inside: +y is the wall's left of a → b
  const [c, s] = [Math.cos(wall.angle), Math.sin(wall.angle)];
  const insideLeft = -s * wall.inward[0] + c * wall.inward[1] > 0;
  const y = insideLeft ? t : -t;
  const on: Point = [0, insideLeft ? 1 : -1];
  for (const [w0, w1] of wall.windows) {
    parts.push(faceY(y, rect(w0, 0.9, w1, Math.min(2.1, height - 0.15)), 'glass', on, 1));
    parts.push(faceY(y, rect((w0 + w1) / 2 - 0.025, 0.9, (w0 + w1) / 2 + 0.025, Math.min(2.1, height - 0.15)), 'steel', on, 2));
  }
  return parts;
}

export interface DoorLeaf {
  key: string;
  centre: Point; // the hinge
  angle: number; // the leaf's direction (into the room), radians
  width: number;
  /** The swing on the floor: from the closed leaf to the open one (world points). */
  arc: Point[];
}

/** The direction of the wall an opening is cut into: the wall whose end is nearest the gap's side. */
function gapDirection(opening: { position: Point }, width: number, walls: Wall[]): Point | null {
  let best: { along: Point; d: number } | null = null;
  for (const wall of walls) {
    const along: Point = [Math.cos(wall.angle), Math.sin(wall.angle)];
    for (const end of [wall.a, wall.b]) {
      const d = Math.hypot(end[0] - opening.position[0], end[1] - opening.position[1]);
      const off = Math.abs((opening.position[0] - end[0]) * along[1] - (opening.position[1] - end[1]) * along[0]);
      if (off < 0.15 && Math.abs(d - width / 2) < 0.12 && (!best || Math.abs(d - width / 2) < best.d)) best = { along, d: Math.abs(d - width / 2) };
    }
  }
  return best?.along ?? null;
}

/** The open leaf of each door (not of plain openings or entrances), hinged at one side of its gap and swung into
 * the room that isn't a corridor. */
export function doorLeaves(openings: Opening[], spaces: Space[], walls: Wall[]): DoorLeaf[] {
  const byId = new Map(spaces.map((space) => [space.id, space]));
  return openings.flatMap((opening) => {
    if (opening.kind !== 'door') return [];
    const width = opening.width_m ?? 0.9;
    const along = gapDirection(opening, width, walls);
    if (!along) return [];
    const normal: Point = [-along[1], along[0]];
    const rooms = opening.space_ids.map((id) => byId.get(id)).filter((space): space is Space => !!space);
    if (rooms.some((space) => space.type === 'lift')) return []; // a lift has sliding doors of its own (stairs.ts liftCar)
    const room = rooms.find((space) => space.type === 'room') ?? rooms.find((space) => space.type !== 'corridor') ?? rooms[0];
    let side = 1;
    if (room) {
      const probe: Point = [opening.position[0] + normal[0] * 0.4, opening.position[1] + normal[1] * 0.4];
      side = pointInPolygon(probe, room.polygon) ? 1 : -1;
    }
    const into: Point = [normal[0] * side, normal[1] * side];
    const hinge: Point = [opening.position[0] - (along[0] * width) / 2, opening.position[1] - (along[1] * width) / 2];
    const arc: Point[] = [];
    for (let k = 0; k <= 8; k += 1) {
      const a = (k / 8) * (Math.PI / 2);
      arc.push([hinge[0] + width * (Math.cos(a) * along[0] + Math.sin(a) * into[0]),
                hinge[1] + width * (Math.cos(a) * along[1] + Math.sin(a) * into[1])]);
    }
    return [{ key: `door|${opening.id}`, centre: hinge, angle: Math.atan2(into[1], into[0]), width, arc }];
  });
}

/** The leaf as parts in its own frame: x from the hinge into the room. */
export function leafParts(leaf: DoorLeaf, height: number): Part[] {
  return [box(0.02, -0.02, leaf.width - 0.02, 0.02, 0, height, 'woodLight', 1, { top: height < FULL_M - 0.2 ? 'wallCap' : 'woodLight' })];
}

export interface EntranceMark {
  key: string;
  /** The doormat just inside, on the floor. */
  mat: Point[];
  /** Where the step-free tick stands, just outside (null when there is a step). */
  tick: Point | null;
}

/** The building's entrances: a doormat just inside each, and a tick outside the step-free ones. */
export function entranceMarks(openings: Opening[], spaces: Space[], walls: Wall[]): EntranceMark[] {
  const byId = new Map(spaces.map((space) => [space.id, space]));
  return openings.flatMap((opening) => {
    if (opening.kind !== 'entrance') return [];
    const width = opening.width_m ?? 1.8;
    const along = gapDirection(opening, width, walls);
    if (!along) return [];
    const room = opening.space_ids.map((id) => byId.get(id)).find((space): space is Space => !!space);
    const normal: Point = [-along[1], along[0]];
    const probe: Point = [opening.position[0] + normal[0] * 0.5, opening.position[1] + normal[1] * 0.5];
    const side = room && !pointInPolygon(probe, room.polygon) ? -1 : 1;
    const inward: Point = [normal[0] * side, normal[1] * side];
    const [p, half] = [opening.position, Math.min(width, 3) * 0.4];
    const at = (u: number, v: number): Point => [p[0] + along[0] * u + inward[0] * v, p[1] + along[1] * u + inward[1] * v];
    const mat = [at(-half, OUTER_M / 2 + 0.05), at(half, OUTER_M / 2 + 0.05), at(half, OUTER_M / 2 + 0.75), at(-half, OUTER_M / 2 + 0.75)];
    return [{ key: `entrance|${opening.id}`, mat, tick: opening.step_free ? at(0, -1.1) : null }];
  });
}

/** The soft shadow along the foot of a wall: a band on the floor beside it (inside only, for outside walls). */
export function wallShadow(wall: Wall): Point[] {
  const t = (wall.outer ? OUTER_M : INNER_M) / 2;
  const [nx, ny] = [-Math.sin(wall.angle), Math.cos(wall.angle)];
  const inwardSide = wall.inward ? Math.sign(wall.inward[0] * nx + wall.inward[1] * ny) : 0;
  const [left, right] = inwardSide > 0 ? [t + SHADOW_M, -t] : inwardSide < 0 ? [t, -t - SHADOW_M] : [t + SHADOW_M, -t - SHADOW_M];
  const [a, b] = [wall.a, wall.b];
  return [[a[0] + nx * left, a[1] + ny * left], [b[0] + nx * left, b[1] + ny * left],
          [b[0] + nx * right, b[1] + ny * right], [a[0] + nx * right, a[1] + ny * right]];
}
