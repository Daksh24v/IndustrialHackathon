import type { BuildingDetail, Point } from '../api';
import { pointInPolygon } from '../geometry';
import { CUT_M, flatStairs, layoutStairs, liftCar, RISER_M, stairClimb, stairInput } from '../stairs';

// A 4 x 6 m stairwell with its door in the middle of the short side at y = 6 (as in the procedural buildings).
const well: Point[] = [[10, 0], [14, 0], [14, 6], [10, 6]];
const door: Point = [12, 6];

const inside = (p: Point, polygon: Point[]) => {
  const [x, y] = p;
  const xs = polygon.map((q) => q[0]);
  const ys = polygon.map((q) => q[1]);
  return pointInPolygon(p, polygon) || (x >= Math.min(...xs) - 1e-6 && x <= Math.max(...xs) + 1e-6 &&
    y >= Math.min(...ys) - 1e-6 && y <= Math.max(...ys) + 1e-6);
};

describe('stairs', () => {
  it('lays out a U-shaped stair with code-sized risers for the storey height', () => {
    const stairs = layoutStairs({ polygon: well, doors: [door], up: 3.8, down: 3.8 })!;
    expect(stairs.kind).toBe('u');
    expect(stairs.risers).toBe(Math.round(3.8 / RISER_M));
    expect(stairs.riser * stairs.risers).toBeCloseTo(3.8);
    expect(stairs.tread).toBeGreaterThanOrEqual(0.22);
    expect(stairs.tread).toBeLessThanOrEqual(0.3);
  });

  it('keeps every step inside the stairwell', () => {
    const stairs = layoutStairs({ polygon: well, doors: [door], up: 3.8, down: 3.8 })!;
    const [c, s] = [Math.cos(stairs.angle), Math.sin(stairs.angle)];
    for (const part of stairs.parts) {
      for (const [x, y] of part.base) {
        const world: Point = [stairs.centre[0] + x * c - y * s, stairs.centre[1] + x * s + y * c];
        expect(inside(world, well)).toBe(true);
      }
    }
    for (const ring of stairs.ghosts) for (const [x, y] of ring) expect(inside([x, y], well)).toBe(true);
  });

  it('starts at the door: the flight goes away from it, solid up to the cut and an outline above', () => {
    const stairs = layoutStairs({ polygon: well, doors: [door], up: 3.8, down: null })!;
    // walking in from the door at y = 6 goes towards y = 0
    expect(Math.sin(stairs.angle)).toBeCloseTo(-1);
    const tops = stairs.parts.map((part) => part.z1);
    expect(Math.max(...tops)).toBeLessThanOrEqual(CUT_M + 1e-6);
    expect(stairs.ghosts.length).toBeGreaterThan(0);
    // the outline climbs on above the cut (drawn with its height eased, so it stays over its stairwell)
    const ghostTop = Math.max(...stairs.ghosts.map((ring) => ring[0][2]));
    expect(ghostTop).toBeGreaterThan(CUT_M + 0.5);
    expect(ghostTop).toBeLessThan(3.8);
    expect(stairs.arrows.map((arrow) => arrow.up)).toEqual([true]);
    expect(stairs.voids).toHaveLength(0);
  });

  it('goes down into an opening on the top floor, and only up on the ground floor', () => {
    const top = layoutStairs({ polygon: well, doors: [door], up: null, down: 3.8 })!;
    expect(top.arrows.map((arrow) => arrow.up)).toEqual([false]);
    expect(top.voids).toHaveLength(1);
    expect(Math.min(...top.parts.map((part) => part.z0))).toBeLessThan(-1);
    const ground = layoutStairs({ polygon: well, doors: [door], up: 3.8, down: null })!;
    expect(Math.min(...ground.parts.map((part) => part.z0))).toBeGreaterThanOrEqual(0);
  });

  it('is a straight flight in a narrow stairwell, and nothing in an odd shape or with nowhere to go', () => {
    const narrow = layoutStairs({ polygon: [[0, 0], [5, 0], [5, 1.2], [0, 1.2]], doors: [[0, 0.6]], up: 2.8, down: null })!;
    expect(narrow.kind).toBe('straight');
    expect(Math.cos(narrow.angle)).toBeCloseTo(1); // from the door at x = 0
    const ell: Point[] = [[0, 0], [6, 0], [6, 1], [1, 1], [1, 6], [0, 6]];
    expect(layoutStairs({ polygon: ell, doors: [], up: 3, down: null })).toBeNull();
    expect(layoutStairs({ polygon: well, doors: [door], up: null, down: null })).toBeNull();
  });

  it('reads up and down from the staircase and the floors', () => {
    const space = { id: 'S1', floor_id: 'F1', type: 'stair', room_type: 'stairwell', name: 'Stairs', ref: null,
                    polygon: well, area_m2: 24, anchor: [12, 3] as Point };
    const detail = {
      building: { id: 'b', name: 'B' },
      floors: [{ id: 'F0', level: 0, name: 'G', elevation_m: 0, height_m: 4 }, { id: 'F1', level: 1, name: '1', elevation_m: 4, height_m: 3.5 },
               { id: 'F2', level: 2, name: '2', elevation_m: 7.5, height_m: 3.5 }],
      spaces: [space], assets: [],
      openings: [{ id: 'O', floor_id: 'F1', space_ids: ['S1', 'C'], kind: 'door', position: door }],
      vertical_connectors: [{ id: 'V', kind: 'stairs', name: 'Stairs', floor_ids: ['F0', 'F1'], space_ids: ['S0', 'S1'] }],
    } as BuildingDetail;
    const input = stairInput(detail, space);
    expect(input.down).toBeCloseTo(4);
    expect(input.up).toBeNull(); // the staircase stops here
    expect(input.doors).toEqual([door]);
  });

  it('puts a lift car in its shaft, its doors at the lift door, whichever side the door is on', () => {
    const shaft: Point[] = [[0, 0], [2.5, 0], [2.5, 6], [0, 6]];
    for (const door of [[1.25, 6], [2.5, 1.5]] as Point[]) {
      const car = liftCar(shaft, [door])!;
      const [c, s] = [Math.cos(car.angle), Math.sin(car.angle)];
      const world = ([x, y]: Point): Point => [car.centre[0] + x * c - y * s, car.centre[1] + x * s + y * c];
      for (const part of car.parts) for (const p of part.base) expect(inside(world(p), shaft)).toBe(true);
      const panels = car.parts.filter((part) => part.mat === 'chrome').flatMap((part) => part.base.map(world));
      const mid: Point = [panels.reduce((sum, p) => sum + p[0], 0) / panels.length, panels.reduce((sum, p) => sum + p[1], 0) / panels.length];
      expect(Math.hypot(mid[0] - door[0], mid[1] - door[1])).toBeLessThan(0.6);
      for (const part of car.parts) expect(part.z1).toBeLessThanOrEqual(CUT_M); // cut like the walls
    }
  });
});

describe('irregular stairwells', () => {
  // a curved Swiss-style stairwell: a half disc, the door on its flat side
  const curve: Point[] = Array.from({ length: 13 }, (_, i) => [3 * Math.cos((i / 12) * Math.PI), 3 * Math.sin((i / 12) * Math.PI)] as Point);

  it('draws flat treads clipped to the outline and an arrow from the door', () => {
    const flat = flatStairs({ polygon: curve, doors: [[0, 0]], up: 3, down: null })!;
    expect(flat.treads.length).toBeGreaterThan(5);
    for (const [a, b] of flat.treads) for (const p of [a, b]) expect(Math.hypot(p[0], p[1])).toBeLessThanOrEqual(3 + 1e-6);
    expect(flat.arrow.up).toBe(true);
    expect(layoutStairs({ polygon: curve, doors: [[0, 0]], up: 3, down: null })).toBeNull(); // no made-up flights
  });

  it('says DN on the top floor and draws nothing with nowhere to go', () => {
    expect(flatStairs({ polygon: curve, doors: [], up: null, down: 3 })!.arrow.up).toBe(false);
    expect(flatStairs({ polygon: curve, doors: [], up: null, down: null })).toBeNull();
  });
});

describe('the route on the stairs', () => {
  const stairs = layoutStairs({ polygon: well, doors: [door], up: 3.5, down: 3.5 })!;
  const up = stairs.arrows.find((arrow) => arrow.up)!;
  const down = stairs.arrows.find((arrow) => !arrow.up)!;
  const corridor: Point[] = [[12, 9], [12, 6.5], [12, 6], [12, 3]]; // in through the door to the middle of the stairwell

  it('stops the flat line at the stairwell and climbs the steps from there', () => {
    const way = stairClimb(corridor, well, up.points, true);
    for (const p of way.flat.slice(0, -1)) expect(inside(p, well) && p[1] < 6 - 1e-6).toBe(false);
    expect(way.flat[way.flat.length - 1]).toEqual([up.points[0][0], up.points[0][1]]);
    const heights = way.climb.map(([, , z]) => z);
    expect(heights[heights.length - 1]).toBeGreaterThan(heights[0]); // it goes up
    for (let i = 1; i < heights.length; i += 1) expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1] - 1e-9);
    expect(Math.max(...heights)).toBeLessThanOrEqual(CUT_M + 0.05); // only the solid steps
  });

  it('comes up out of the opening when the route arrives from below', () => {
    const way = stairClimb([...corridor].reverse(), well, down.points, false);
    expect(way.climb[0][2]).toBeLessThan(0); // starts below the floor
    expect(way.flat[0]).toEqual([down.points[0][0], down.points[0][1]]);
  });

  it('leaves a route that never enters the stairwell as it is', () => {
    const past: Point[] = [[0, 9], [20, 9]];
    expect(stairClimb(past, well, up.points, true)).toEqual({ flat: past, climb: [] });
  });
});
