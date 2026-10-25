/** Directions people can follow, from the route on the map: one step per door into another space and per stair
 * or lift, with the metres walked before it, the turn and a rare thing by the door. The same rules as the agent's
 * directions (navagent/tools.py `directions`), but each step also knows where on the map it is, so the list can
 * point at it and "Start" can walk through it. */
import { type BuildingDetail, type MapView, type Point, type RoutePiece } from './api';
import { pointInPolygon } from './geometry';

const TURN_REACH_M = 2; // a turn is judged over the 2 m before and after a door
const STRAIGHT_DEG = 30;
const AROUND_DEG = 150;
const LANDMARK_MAX_PER_FLOOR = 2; // a kind of thing at most this often on a floor is a landmark
const LANDMARK_NEAR_DOOR_M = 3;
const WALK_M_PER_S = 1.2;
const LIFT_S = 15;

export type StepKind = 'turn' | 'stairs' | 'lift' | 'arrive';

export interface Step {
  kind: StepKind;
  action: string; // "Turn right into Office corridor 0.16"
  near?: string; // "by the Coordinate measuring machine 0.21"
  walk_m: number; // walked before the action
  floorId: string;
  path: Point[]; // the stretch walked for this step, ending where the action happens
  toFloorId?: string;
}

export interface Summary {
  length_m: number;
  minutes: number;
  floors: number; // floors changed
  up: boolean;
  stepFree: boolean;
}

/** The label without its floor: "Office 1.04 (Floor 1)" -> "Office 1.04". */
export const bare = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, '');

const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Which way someone walks over the last (atEnd) or first TURN_REACH_M of a path; null if it has no length. */
export function heading(points: Point[], atEnd: boolean): Point | null {
  const path = atEnd ? [...points].reverse() : points;
  if (path.length < 2) return null;
  let walked = 0;
  let far = path[1];
  for (let i = 1; i < path.length; i++) {
    walked += dist(path[i - 1], path[i]);
    far = path[i];
    if (walked >= TURN_REACH_M) break;
  }
  const v: Point = atEnd ? [path[0][0] - far[0], path[0][1] - far[1]] : [far[0] - path[0][0], far[1] - path[0][1]];
  return Math.hypot(v[0], v[1]) > 1e-6 ? v : null;
}

/** "Turn left", "Turn right", "Go straight" or "Turn around" (x east, y north: counter-clockwise is left). */
export function turnWord(incoming: Point | null, outgoing: Point | null): string {
  if (!incoming || !outgoing) return 'Go';
  const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
  const dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
  const angle = (Math.atan2(cross, dot) * 180) / Math.PI;
  if (Math.abs(angle) < STRAIGHT_DEG) return 'Go straight';
  if (Math.abs(angle) > AROUND_DEG) return 'Turn around';
  return angle > 0 ? 'Turn left' : 'Turn right';
}

export function routeSteps(map: MapView | null, detail: BuildingDetail | null): Step[] {
  const route = map?.route;
  if (!route || !detail) return [];
  const steps: Step[] = [];
  const floorName = (id: string) => detail.floors.find((floor) => floor.id === id)?.name ?? id;
  const level = (id: string) => detail.floors.find((floor) => floor.id === id)?.level ?? 0;
  route.pieces.forEach((piece, index) => {
    steps.push(...floorSteps(piece, detail));
    if (piece.then?.to_floor_id) {
      const to = piece.then.to_floor_id;
      const lift = piece.then.kind === 'lift';
      const way = level(to) > level(piece.floor_id) ? 'up' : 'down';
      const last = piece.points[piece.points.length - 1];
      steps.push({ kind: lift ? 'lift' : 'stairs', action: `Take ${piece.then.name ?? (lift ? 'the lift' : 'the stairs')} ${way} to ${floorName(to)}`,
                   walk_m: 0, floorId: piece.floor_id, path: [last], toFloorId: to });
    } else if (index === route.pieces.length - 1) {
      const target = map?.target ? bare(map.target.label) : 'your destination';
      const tail = steps.length ? tailOf(piece, steps) : piece.points;
      steps.push({ kind: 'arrive', action: `Arrive at ${target}`, walk_m: round(lengthOf(tail)), floorId: piece.floor_id,
                   path: tail });
    }
  });
  return steps;
}

/** The doors on one floor's stretch of the route: wherever the walk passes into another space. */
function floorSteps(piece: RoutePiece, detail: BuildingDetail): Step[] {
  const spaces = detail.spaces.filter((space) => space.floor_id === piece.floor_id);
  const spaceOf = (a: Point, b: Point) => {
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return spaces.find((space) => pointInPolygon(mid, space.polygon)) ?? null;
  };
  const points = piece.points;
  const steps: Step[] = [];
  let current = null as (typeof spaces)[number] | null;
  let from = 0; // where the stretch for the next step begins
  for (let i = 0; i + 1 < points.length; i++) {
    if (dist(points[i], points[i + 1]) < 1e-3) continue;
    const space = spaceOf(points[i], points[i + 1]);
    if (!space) continue;
    if (current && space.id !== current.id) {
      const before = points.slice(from, i + 1);
      const after = points.slice(i);
      const near = landmark(detail, piece.floor_id, points[i], [current.id, space.id]);
      steps.push({ kind: 'turn', action: `${turnWord(heading(before, true), heading(after, false))} into ${space.name}`,
                   near: near ? `by the ${near}` : undefined, walk_m: round(lengthOf(before)), floorId: piece.floor_id,
                   path: before });
      from = i;
    }
    current = space;
  }
  return steps;
}

/** The rare thing (at most 2 of its kind on the floor) closest to a door, within 3 m, in a space the door joins. */
function landmark(detail: BuildingDetail, floorId: string, door: Point, spaceIds: string[]): string | null {
  const kinds = new Map<string, number>();
  for (const asset of detail.assets) {
    if (asset.floor_id === floorId) kinds.set(asset.type, (kinds.get(asset.type) ?? 0) + 1);
  }
  let best: { d: number; name: string } | null = null;
  for (const asset of detail.assets) {
    if (asset.floor_id !== floorId || (kinds.get(asset.type) ?? 0) > LANDMARK_MAX_PER_FLOOR) continue;
    if (!spaceIds.includes(asset.space_id)) continue;
    const d = dist(asset.position, door);
    if (d <= LANDMARK_NEAR_DOOR_M && (!best || d < best.d)) best = { d, name: asset.name };
  }
  return best?.name ?? null;
}

/** The last floor's walk after its last door. */
function tailOf(piece: RoutePiece, steps: Step[]): Point[] {
  const last = [...steps].reverse().find((step) => step.floorId === piece.floor_id && step.kind === 'turn');
  if (!last) return piece.points;
  const end = last.path[last.path.length - 1];
  const index = piece.points.findIndex((p) => p[0] === end[0] && p[1] === end[1]);
  return index >= 0 ? piece.points.slice(index) : piece.points;
}

function lengthOf(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Whole metres, halves to even like the agent's text ("about 2 m" for 2.5 m). */
const round = (metres: number) => {
  const whole = Math.round(metres);
  return Math.abs((metres % 1) - 0.5) < 0.01 && whole % 2 ? whole - 1 : whole;
};

/** "30 m · about 1 min · 1 floor up", and whether it is step-free (no stairs, no door with a step). */
export function summary(map: MapView | null, detail: BuildingDetail | null): Summary | null {
  const route = map?.route;
  if (!route) return null;
  const changes = route.pieces.filter((piece) => piece.then?.to_floor_id);
  const lifts = changes.filter((piece) => piece.then?.kind === 'lift').length;
  const level = (id: string | undefined) => detail?.floors.find((floor) => floor.id === id)?.level ?? 0;
  const first = route.pieces[0]?.floor_id;
  const last = route.pieces[route.pieces.length - 1]?.floor_id;
  const stepped = (detail?.openings ?? []).some((opening) => opening.step_free === false && route.pieces.some(
    (piece) => piece.floor_id === opening.floor_id && piece.points.some((p) => dist(p, opening.position) < 0.5)));
  return {
    length_m: Math.round(route.length_m),
    minutes: Math.max(1, Math.round((route.length_m / WALK_M_PER_S + lifts * LIFT_S) / 60)),
    floors: changes.length,
    up: level(last) >= level(first),
    stepFree: !changes.some((piece) => piece.then?.kind === 'stairs') && !stepped,
  };
}
