/** The route as the map draws it: straight down the middle of a corridor, like a map app, instead of the
 * shortest walk that cuts across it from door to door (15 cm off the walls, the judges' model). Only the drawing
 * changes: the metres, the time and the steps come from the real route. */
import type { BuildingDetail, MapView, Point, Space } from './api';
import { orientedBox, pointInPolygon } from './geometry';

const MAX_WIDTH_M = 6; // wider than this is a hall, not a corridor: its middle means nothing
const MIN_RUN_M = 1; // a run shorter than this along the corridor is just crossing it: left as it is
const NEAR_M = 0.25; // a point this close to the middle line already is on it
const SAMPLES = 16; // the middle line is checked to stay inside the corridor (an L-shaped one doesn't)

interface Corridor {
  polygon: Point[];
  centre: Point;
  u: Point; // along it
}

function corridorsOf(spaces: Pick<Space, 'type' | 'room_type' | 'polygon'>[]): Corridor[] {
  return spaces.flatMap((space) => {
    if (space.type !== 'corridor' && space.room_type !== 'corridor') return [];
    const box = orientedBox(space.polygon);
    if (box.width > MAX_WIDTH_M || box.length < 2 * box.width) return [];
    return [{ polygon: space.polygon, centre: box.centre, u: box.u }];
  });
}

const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function inside(polygon: Point[], a: Point, b: Point): boolean {
  for (let k = 0; k <= SAMPLES; k += 1) {
    const t = k / SAMPLES;
    if (!pointInPolygon([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], polygon)) return false;
  }
  return true;
}

/** One floor's route line, run down the middle of each corridor it walks along. */
export function straightRoute(points: Point[], spaces: Pick<Space, 'type' | 'room_type' | 'polygon'>[]): Point[] {
  if (points.length < 2) return points;
  const corridors = corridorsOf(spaces);
  if (!corridors.length) return points;
  const corridorOf = (a: Point, b: Point) => corridors.find((corridor) => pointInPolygon(mid(a, b), corridor.polygon));
  const out: Point[] = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    const corridor = corridorOf(points[i], points[i + 1]);
    let j = i + 1;
    while (corridor && j < points.length - 1 && corridorOf(points[j], points[j + 1]) === corridor) j += 1;
    const run = points.slice(i + 1, j + 1);
    if (!corridor) {
      out.push(...run);
      i = j;
      continue;
    }
    const { centre, u, polygon } = corridor;
    const along = (p: Point) => (p[0] - centre[0]) * u[0] + (p[1] - centre[1]) * u[1];
    const foot = (p: Point): Point => [centre[0] + along(p) * u[0], centre[1] + along(p) * u[1]];
    const [a, b] = [points[i], points[j]];
    const [fa, fb] = [foot(a), foot(b)];
    if (Math.abs(along(b) - along(a)) < MIN_RUN_M || !inside(polygon, fa, fb) || !inside(polygon, a, fa) || !inside(polygon, fb, b)) {
      out.push(...run);
    } else {
      if (dist(a, fa) > NEAR_M) out.push(fa);
      if (dist(b, fb) > NEAR_M) out.push(fb);
      out.push(b);
    }
    i = j;
  }
  return out;
}

/** The map with its route drawn straight (see straightRoute); everything else as it is. */
export function straightenMap(map: MapView | null, detail: BuildingDetail | null): MapView | null {
  if (!map?.route || !detail) return map;
  const byFloor = new Map<string, Space[]>();
  for (const space of detail.spaces) byFloor.set(space.floor_id, [...(byFloor.get(space.floor_id) ?? []), space]);
  const pieces = map.route.pieces.map((piece) => ({ ...piece, points: straightRoute(piece.points, byFloor.get(piece.floor_id) ?? []) }));
  return { ...map, route: { ...map.route, pieces } };
}
