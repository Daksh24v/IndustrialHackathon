/** What the building's edits (map.changes: closed doors, lifts and rooms, new doors, moved things) look like on
 * one floor, in plan metres, for both floor views to draw: closed in red, new doors in green, moved things as
 * a small marker. */
import type { BuildingDetail, MapView, Point } from './api';

export interface DoorMark {
  id: string;
  a: Point; // the two ends of the mark, along the wall
  b: Point;
  kind: 'closed' | 'new';
}

export interface FloorChanges {
  closedSpaces: Set<string>;
  doors: DoorMark[];
  labels: { id: string; at: Point; text: string }[]; // closed lifts and stairs
  moved: { id: string; at: Point; label: string }[];
}

export const NO_CHANGES: FloorChanges = { closedSpaces: new Set(), doors: [], labels: [], moved: [] };

/** The direction of the wall nearest to a point (a unit vector), from the floor's room outlines. */
export function wallDirection(polygons: Point[][], [px, py]: Point): Point {
  let best = Infinity;
  let direction: Point = [1, 0];
  for (const polygon of polygons) {
    polygon.forEach(([ax, ay], i) => {
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const dx = bx - ax;
      const dy = by - ay;
      const length2 = dx * dx + dy * dy;
      if (length2 === 0) return;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d < best) {
        best = d;
        const length = Math.sqrt(length2);
        direction = [dx / length, dy / length];
      }
    });
  }
  return direction;
}

function mark(id: string, at: Point, width: number, kind: DoorMark['kind'], polygons: Point[][]): DoorMark {
  const [dx, dy] = wallDirection(polygons, at);
  const half = Math.max(width, 0.6) / 2;
  return { id, kind, a: [at[0] - dx * half, at[1] - dy * half], b: [at[0] + dx * half, at[1] + dy * half] };
}

export function changesOn(detail: BuildingDetail, map: MapView | null, floorId: string): FloorChanges {
  const changes = map?.changes;
  if (!changes) return NO_CHANGES;
  const spaces = detail.spaces.filter((space) => space.floor_id === floorId);
  const polygons = spaces.map((space) => space.polygon);
  const closed = new Set(changes.closed ?? []);
  const result: FloorChanges = { closedSpaces: new Set(), doors: [], labels: [], moved: [] };

  for (const space of spaces) if (closed.has(space.id)) result.closedSpaces.add(space.id);
  for (const opening of detail.openings) {
    if (opening.floor_id === floorId && closed.has(opening.id)) {
      result.doors.push(mark(opening.id, opening.position, opening.width_m ?? 0.9, 'closed', polygons));
    }
  }
  for (const connector of detail.vertical_connectors) {
    if (!closed.has(connector.id)) continue;
    for (const space of spaces) {
      if (!connector.space_ids.includes(space.id)) continue;
      result.closedSpaces.add(space.id);
      result.labels.push({ id: `${connector.id}-${space.id}`, at: space.anchor, text: `${connector.name} closed` });
    }
  }
  for (const door of changes.new_doors ?? []) {
    if (door.floor_id !== floorId) continue;
    const kind = closed.has(door.id) ? 'closed' : 'new'; // a new door can be closed again
    result.doors.push(mark(door.id, door.position, door.width_m, kind, polygons));
  }
  for (const thing of changes.moved ?? []) {
    if (thing.floor_id === floorId) result.moved.push({ id: thing.asset_id, at: thing.position, label: thing.label });
  }
  return result;
}
