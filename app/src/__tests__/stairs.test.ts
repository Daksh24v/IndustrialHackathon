import type { BuildingDetail, Point } from '../api';
import { pointInPolygon } from '../geometry';
import { CUT_M, layoutStairs, RISER_M, stairInput } from '../stairs';

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
});
