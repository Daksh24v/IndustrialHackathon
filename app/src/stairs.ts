/** A staircase as it really is, worked out from the stairwell in the data: its rectangle, the door you come in by,
 * the storey height and whether the stairs go on up and down. Wide stairwells get a U-shaped (dog-leg) stair: one
 * flight up along one side to a half landing at the far end, the next back along the other side; narrow ones a
 * straight flight. Risers are about 17.5 cm, as building codes ask, and the treads what fits.
 *
 * On a floor you see what an architect's plan shows: the flight going up in solid steps as far as the cut height,
 * then as a light outline the rest of the way (a break line marks the cut), and beside it the flight coming up
 * from the floor below, going down into an opening in the floor. UP and DN arrows say which way each goes. */
import type { BuildingDetail, Point, Space } from './api';
import { orientedBox, signedArea } from './geometry';
import { box, type Part } from './models/kit';

export type Point3 = [number, number, number];

export const RISER_M = 0.175;
export const CUT_M = 1.2; // plans are cut at this height: below solid, above an outline
const GHOST_RISE = 0.35; // above the cut the outline rises this much slower, so it stays over its own stairwell
const TREAD_MIN = 0.22;
const TREAD_MAX = 0.3;
const U_MIN_WIDTH = 2.2; // narrower than this: a straight flight
const FLIGHT_MAX = 1.7; // a flight is at most this wide, whatever the stairwell
const WELL = 0.1; // the gap between the two flights of a U stair
const ENTRY_MIN = 0.9; // the landing at the door is at least this deep
const RECTANGLE = 0.8; // stairwells that fill less of their box than this are not drawn as flights

export interface StairInput {
  polygon: Point[];
  doors: Point[];
  /** Rise to the floor above (null: no stairs up from here). */
  up: number | null;
  /** Fall to the floor below (null: no stairs down from here). */
  down: number | null;
}

export interface Stairs {
  kind: 'u' | 'straight';
  key: string;
  centre: Point; // the model's middle and its turn (radians): x runs from the door end, y across
  angle: number;
  parts: Part[]; // the solid steps and landings, in the model's own frame
  ghosts: Point3[][]; // outlines of what rises above the cut (closed rings, world metres)
  rails: Point3[][]; // handrails (open lines)
  arrows: { points: Point3[]; up: boolean }[];
  breaks: Point3[][]; // the zig-zag where the cut goes across a flight
  voids: Point[][]; // the opening in the floor the down flight goes through
  risers: number; // risers in one storey
  riser: number; // their height
  tread: number; // the treads' depth
}

interface Flight {
  y0: number;
  y1: number;
  x0: number; // where it starts (at the door end)
  tread: number;
  steps: number; // treads drawn
  riser: number;
}

/** The stairs in a stairwell, or null when it isn't a rectangle a flight can be drawn in. */
export function layoutStairs({ polygon, doors, up, down }: StairInput): Stairs | null {
  if (polygon.length < 3 || (!up && !down)) return null;
  const ob = orientedBox(polygon);
  if (ob.fill < RECTANGLE || ob.length < 1 || ob.width < 0.6) return null;
  let u = ob.u;
  const local = ([x, y]: Point): Point => {
    const dx = x - ob.centre[0];
    const dy = y - ob.centre[1];
    return [dx * u[0] + dy * u[1], -dx * u[1] + dy * u[0]];
  };
  // Walk in from the door: the door end is at -x.
  if (doors.length && doors.reduce((sum, door) => sum + local(door)[0], 0) / doors.length > 0) u = [-u[0], -u[1]];
  const angle = Math.atan2(u[1], u[0]);
  const [hl, hw] = [ob.length / 2, ob.width / 2];
  const doorY = doors.length ? doors.reduce((sum, door) => sum + local(door)[1], 0) / doors.length : 0;
  const rise = up ?? down ?? 3;
  const risers = Math.max(2, Math.round(rise / RISER_M));
  const riser = rise / risers;
  const toWorld = ([x, y]: Point): Point => [ob.centre[0] + x * u[0] - y * u[1], ob.centre[1] + x * u[1] + y * u[0]];
  const w3 = ([x, y]: Point, z: number): Point3 => [...toWorld([x, y]), z];

  const parts: Part[] = [];
  let tread = 0;
  const ghosts: Point3[][] = [];
  const rails: Point3[][] = [];
  const arrows: Stairs['arrows'] = [];
  const breaks: Point3[][] = [];
  const voids: Point[][] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number, z: number): Point3[] =>
    [w3([x0, y0], z), w3([x1, y0], z), w3([x1, y1], z), w3([x0, y1], z)];
  const shown = (z: number) => (z <= CUT_M ? z : CUT_M + (z - CUT_M) * GHOST_RISE);

  /** Treads that fit between from and to along x, for this many risers. */
  const fit = (from: number, to: number, count: number): { tread: number; steps: number; riser: number; run: number } => {
    const room = Math.max(0, to - from);
    let steps = count - 1;
    let tread = steps > 0 ? Math.min(TREAD_MAX, room / steps) : TREAD_MAX;
    if (tread < TREAD_MIN) {
      steps = Math.max(1, Math.floor(room / TREAD_MIN));
      tread = room / steps;
    }
    return { tread, steps, riser: (count * riser) / (steps + 1), run: steps * tread };
  };

  /** A flight going up from (x0) along +x, on y0..y1: solid to the cut, an outline above. */
  const rising = (flight: Flight, base: number, ghostOnly = false) => {
    let solidUntil = flight.x0;
    for (let i = 1; i <= flight.steps; i += 1) {
      const x0 = flight.x0 + (i - 1) * flight.tread;
      const x1 = x0 + flight.tread;
      const top = base + i * flight.riser;
      if (!ghostOnly && top <= CUT_M + 1e-6) {
        parts.push(box(x0, flight.y0, x1, flight.y1, Math.max(0, base), top, 'stair', 0));
        solidUntil = x1;
      } else {
        ghosts.push(quad(x0, flight.y0, x1, flight.y1, shown(top)));
      }
    }
    return solidUntil;
  };

  /** A flight going down from the floor (x0) along +x, into the opening: one riser tall each, darker. */
  const sinking = (flight: Flight) => {
    for (let i = 1; i <= flight.steps; i += 1) {
      const x0 = flight.x0 + (i - 1) * flight.tread;
      const top = -i * flight.riser;
      parts.push(box(x0, flight.y0, x0 + flight.tread, flight.y1, top - flight.riser, top, 'stairDeep', 0));
    }
  };

  const arrow = (flight: Flight, upward: boolean, until: number) => {
    const y = (flight.y0 + flight.y1) / 2;
    const end = Math.min(until, flight.x0 + flight.steps * flight.tread);
    const points: Point3[] = [];
    const count = 6;
    for (let k = 0; k <= count; k += 1) {
      const x = flight.x0 - 0.35 + ((end - flight.x0 + 0.25) * k) / count;
      const along = Math.max(0, Math.min(flight.steps, Math.ceil((x - flight.x0) / flight.tread)));
      points.push(w3([x, y], (upward ? along : -along) * flight.riser + 0.02));
    }
    arrows.push({ points, up: upward });
  };

  /** A handrail from (x0, z0) to (x1, z1) along y, on posts about a metre apart. */
  const rail = (y: number, x0: number, z0: number, x1: number, z1: number) => {
    rails.push([w3([x0, y], z0 + 0.9), w3([x1, y], z1 + 0.9)]);
    const posts = Math.max(1, Math.round((x1 - x0) / 1));
    for (let k = 0; k <= posts; k += 1) {
      const x = x0 + ((x1 - x0) * k) / posts;
      const z = z0 + ((z1 - z0) * k) / posts;
      rails.push([w3([x, y], z), w3([x, y], z + 0.9)]);
    }
  };

  /** The zig-zag across a flight where it is cut. */
  const breakAt = (x: number, y0: number, y1: number, z: number) => {
    const teeth = 4;
    const line: Point3[] = [];
    for (let k = 0; k <= teeth; k += 1) line.push(w3([x + (k % 2 ? 0.12 : -0.12), y0 + ((y1 - y0) * k) / teeth], z));
    breaks.push(line);
  };

  if (ob.width >= U_MIN_WIDTH) {
    // Two flights side by side; the up flight on the door's side.
    const flight = Math.min(FLIGHT_MAX, (ob.width - WELL) / 2);
    const total = 2 * flight + WELL;
    const middle = Math.max(-hw + total / 2, Math.min(hw - total / 2, doorY * 0.5));
    const [a0, a1] = doorY >= 0 ? [middle + WELL / 2, middle + total / 2] : [middle - total / 2, middle - WELL / 2];
    const [b0, b1] = doorY >= 0 ? [middle - total / 2, middle - WELL / 2] : [middle + WELL / 2, middle + total / 2];
    const landing = Math.min(flight, 1.5);
    const first = Math.ceil(risers / 2);
    const second = risers - first;
    const sized = fit(-hl + ENTRY_MIN, hl - landing, first);
    const x0 = Math.max(-hl + ENTRY_MIN, hl - landing - sized.run);
    const half = first * riser;
    tread = sized.tread;
    if (up) {
      const a: Flight = { y0: a0, y1: a1, x0, tread: sized.tread, steps: sized.steps, riser: sized.riser };
      const solid = rising(a, 0);
      // the half landing and the second flight, back towards the door, above the cut
      ghosts.push(quad(x0 + sized.run, Math.min(a0, b0), hl, Math.max(a1, b1), shown(half)));
      if (!down) { // over the flight going down it would only be in the way
        const back = fit(-hl + ENTRY_MIN, hl - landing, second);
        for (let i = 1; i <= back.steps; i += 1) {
          const x1 = x0 + sized.run - (i - 1) * back.tread;
          ghosts.push(quad(x1 - back.tread, b0, x1, b1, shown(half + i * back.riser)));
        }
      }
      if (solid < x0 + sized.run) breakAt(solid, a0, a1, CUT_M);
      const railEnd = Math.max(x0, solid);
      rail(doorY >= 0 ? a0 : a1, x0 + sized.tread / 2, sized.riser, railEnd - sized.tread / 2,
           ((railEnd - x0) / Math.max(sized.tread, 1e-6)) * sized.riser);
      arrow(a, true, solid);
    }
    if (down) {
      const sizedDown = fit(-hl + ENTRY_MIN, hl - landing, second || first);
      const b: Flight = { y0: b0, y1: b1, x0, tread: sizedDown.tread, steps: sizedDown.steps, riser: sizedDown.riser };
      voids.push([toWorld([x0, b0]), toWorld([hl, b0]), toWorld([hl, b1]), toWorld([x0, b1])]);
      sinking(b);
      parts.push(box(x0 + sizedDown.run, b0, hl, b1, -(sizedDown.steps + 1) * sizedDown.riser - 0.05,
                     -(sizedDown.steps + 1) * sizedDown.riser, 'stairDeep', 1));
      arrow(b, false, hl);
      if (!up) { // the top floor: a guard rail along the opening
        rail(doorY >= 0 ? b1 : b0, x0, 0, hl, 0);
      }
    }
  } else {
    // One straight flight across the whole width, up if it goes up, else down.
    const y0 = -hw + 0.05;
    const y1 = hw - 0.05;
    const entry = Math.min(ENTRY_MIN, ob.length * 0.25);
    const sized = fit(-hl + entry, hl, risers);
    const x0 = -hl + entry;
    const flight: Flight = { y0, y1, x0, tread: sized.tread, steps: sized.steps, riser: sized.riser };
    tread = sized.tread;
    if (up) {
      const solid = rising(flight, 0);
      if (solid < x0 + sized.run) breakAt(solid, y0, y1, CUT_M);
      const railEnd = Math.max(x0, solid);
      rail(y1, x0 + sized.tread / 2, sized.riser, railEnd - sized.tread / 2, ((railEnd - x0) / sized.tread) * sized.riser);
      arrow(flight, true, solid);
    } else {
      voids.push([toWorld([x0, y0]), toWorld([hl, y0]), toWorld([hl, y1]), toWorld([x0, y1])]);
      sinking(flight);
      arrow(flight, false, hl);
      rail(y1, x0, 0, hl, 0);
    }
  }

  const key = `stairs|${ob.length.toFixed(2)}|${ob.width.toFixed(2)}|${riser.toFixed(3)}|${up ? 1 : 0}${down ? 1 : 0}|${doorY >= 0 ? 1 : 0}`;
  return { kind: ob.width >= U_MIN_WIDTH ? 'u' : 'straight', key, centre: ob.centre, angle, parts, ghosts, rails, arrows,
           breaks, voids, risers, riser, tread };
}

/** What the stairs in a stair space do on its floor: the rise to the floor above and the fall to the one below,
 * from the staircase that serves it (else from the floors there are). */
export function stairInput(detail: BuildingDetail, space: Space): StairInput {
  const floors = [...detail.floors].sort((a, b) => a.elevation_m - b.elevation_m);
  const here = floors.findIndex((floor) => floor.id === space.floor_id);
  const connector = detail.vertical_connectors.find((item) => item.space_ids.includes(space.id));
  const serves = (floorId: string | undefined) => !!floorId && (!connector || connector.floor_ids.includes(floorId));
  const above = floors[here + 1];
  const below = floors[here - 1];
  const floor = floors[here];
  const storey = floor?.height_m ?? 3;
  const doors = detail.openings.filter((opening) => opening.space_ids.includes(space.id)).map((opening) => opening.position);
  const polygon = signedArea(space.polygon) >= 0 ? space.polygon : [...space.polygon].reverse();
  return {
    polygon,
    doors,
    up: above && serves(above.id) ? Math.max(2, above.elevation_m - floor.elevation_m) || storey : null,
    down: below && serves(below.id) ? Math.max(2, floor.elevation_m - below.elevation_m) || storey : null,
  };
}

/** A whole storey of stairs as one solid model, for the building view: from the floor below (z = 0) to the one
 * above (z = height, the drawing's own height for a storey), with the real layout (U-shaped or straight, from the
 * door) and the real number of steps for the real rise. */
export function storeyStairs(polygon: Point[], doors: Point[], rise: number, height: number):
  { key: string; centre: Point; angle: number; parts: Part[] } | null {
  const ob = orientedBox(polygon);
  if (polygon.length < 3 || ob.fill < RECTANGLE || ob.length < 1 || ob.width < 0.6 || height <= 0) return null;
  let u = ob.u;
  const along = ([x, y]: Point) => (x - ob.centre[0]) * u[0] + (y - ob.centre[1]) * u[1];
  if (doors.length && doors.reduce((sum, door) => sum + along(door), 0) / doors.length > 0) u = [-u[0], -u[1]];
  const across = ([x, y]: Point) => -(x - ob.centre[0]) * u[1] + (y - ob.centre[1]) * u[0];
  const doorY = doors.length ? doors.reduce((sum, door) => sum + across(door), 0) / doors.length : 0;
  const [hl, hw] = [ob.length / 2, ob.width / 2];
  const risers = Math.max(2, Math.round(rise / RISER_M));
  const riser = height / risers;
  const parts: Part[] = [];
  const thick = Math.max(riser * 3, height * 0.08);
  /** A flight of n risers along +x (or -x) from x0, starting at height z, on y0..y1; solid down to the floor
   * when grounded, else a slab of steps. */
  const flight = (x0: number, dir: 1 | -1, room: number, n: number, z: number, y0: number, y1: number, grounded: boolean) => {
    const steps = Math.max(1, Math.min(n - 1, Math.floor(room / TREAD_MIN)));
    const tread = Math.min(TREAD_MAX, room / steps);
    const up = (n * riser) / (steps + 1);
    for (let i = 1; i <= steps; i += 1) {
      const a = x0 + dir * (i - 1) * tread;
      const b = a + dir * tread;
      const top = z + i * up;
      parts.push(box(Math.min(a, b), y0, Math.max(a, b), y1, grounded ? 0 : Math.max(0, top - thick), top, i % 2 ? 'stair' : 'stairDeep', 0));
    }
    return steps * tread;
  };
  if (ob.width >= U_MIN_WIDTH) {
    const width = Math.min(FLIGHT_MAX, (ob.width - WELL) / 2);
    const total = 2 * width + WELL;
    const middle = Math.max(-hw + total / 2, Math.min(hw - total / 2, doorY * 0.5));
    const [a0, a1] = doorY >= 0 ? [middle + WELL / 2, middle + total / 2] : [middle - total / 2, middle - WELL / 2];
    const [b0, b1] = doorY >= 0 ? [middle - total / 2, middle - WELL / 2] : [middle + WELL / 2, middle + total / 2];
    const landing = Math.min(width, 1.5);
    const first = Math.ceil(risers / 2);
    const room = Math.max(TREAD_MIN, ob.length - ENTRY_MIN - landing);
    const x0 = Math.max(-hl + ENTRY_MIN, hl - landing - Math.min(room, (first - 1) * TREAD_MAX));
    const run = flight(x0, 1, hl - landing - x0, first, 0, a0, a1, true);
    const half = first * riser;
    parts.push(box(x0 + run, Math.min(a0, b0), hl, Math.max(a1, b1), Math.max(0, half - thick), half, 'stair', 0));
    flight(x0 + run, -1, run, risers - first, half, b0, b1, false);
  } else {
    flight(-hl + Math.min(ENTRY_MIN, ob.length * 0.25), 1, ob.length - Math.min(ENTRY_MIN, ob.length * 0.25), risers, 0,
           -hw + 0.05, hw - 0.05, true);
  }
  const key = `storey|${ob.length.toFixed(2)}|${ob.width.toFixed(2)}|${risers}|${height.toFixed(2)}|${doorY >= 0 ? 1 : 0}`;
  return { key, centre: ob.centre, angle: Math.atan2(u[1], u[0]), parts };
}
