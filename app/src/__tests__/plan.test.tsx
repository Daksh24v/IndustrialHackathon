import { render, screen } from '@testing-library/react-native';

import type { BuildingDetail, Point, Space } from '../api';
import { FloorPlan } from '../components/FloorPlan';
import { drawSolids, limitMove, limitZoom, placeThings, roomAt, ZOOM_IN, ZOOM_OUT } from '../components/FloorScene';
import { box } from '../models/kit';
import { doorSymbol, layered, OVERHEAD_M, partsFromAbove, stairPlan, wallBand } from '../plan';
import { layoutStairs } from '../stairs';
import { CUT_M } from '../stairs';
import { doorLeaves, floorWalls, FULL_M, INNER_M, LOW_M, OUTER_M, wallHeight, wallParts } from '../walls';

const room = (id: string, x: number, roomType: string, w = 8): Space => ({
  id, floor_id: 'F0', type: 'room', room_type: roomType, name: id, ref: null, area_m2: w * 5, anchor: [x + w / 2, 2.5],
  polygon: [[x, 0], [x + w, 0], [x + w, 5], [x, 5]],
} as Space);
// Two rooms side by side in a 16 x 5 m building, a door between them: an office and a toilet.
const spaces = [room('A', 0, 'office'), room('B', 8, 'toilet')];
const door = { id: 'O1', floor_id: 'F0', space_ids: ['A', 'B'], kind: 'door', position: [8, 2.5] as Point, width_m: 1 };
const footprint: Point[][] = [[[0, 0], [16, 0], [16, 5], [0, 5]]];

describe('walls', () => {
  const walls = floorWalls(spaces, [door], footprint);

  it('tells the outside walls from the one between the rooms', () => {
    const between = walls.filter((wall) => Math.abs(wall.centre[0] - 8) < 1e-6);
    expect(between.length).toBeGreaterThan(0);
    for (const wall of between) expect(wall.outer).toBe(false);
    const outside = walls.filter((wall) => wall.outer);
    expect(outside.length).toBeGreaterThan(0);
    for (const wall of outside) expect(wall.inward).not.toBeNull();
  });

  it('cuts a gap for the door', () => {
    const between = walls.filter((wall) => Math.abs(wall.centre[0] - 8) < 1e-6);
    const length = between.reduce((sum, wall) => sum + wall.length, 0);
    expect(length).toBeCloseTo(5 - 1, 1);
  });

  it('gives windows to the office but not to the toilet', () => {
    const office = walls.filter((wall) => wall.outer && wall.centre[0] < 8);
    const toilet = walls.filter((wall) => wall.outer && wall.centre[0] > 8);
    expect(office.some((wall) => wall.windows.length > 0)).toBe(true);
    for (const wall of toilet) expect(wall.windows).toEqual([]);
    for (const wall of walls.filter((item) => !item.outer)) expect(wall.windows).toEqual([]);
  });

  it('stands the far outside walls full height and cuts the rest at the plan cut', () => {
    const south = walls.find((wall) => wall.outer && Math.abs(wall.centre[1]) < 1e-6 && wall.centre[0] < 8)!;
    const inner = walls.find((wall) => !wall.outer)!;
    const fromNorth: Point = [0, 100]; // the viewer north of the building sees the inside of the south wall
    const fromSouth: Point = [0, -100];
    expect(wallHeight(south, fromNorth, 'cutaway', 3)).toBeCloseTo(FULL_M);
    expect(wallHeight(south, fromSouth, 'cutaway', 3)).toBeCloseTo(CUT_M);
    expect(wallHeight(inner, fromNorth, 'cutaway', 3)).toBeCloseTo(CUT_M);
    expect(wallHeight(south, fromNorth, 'low', 3)).toBe(LOW_M);
    expect(wallHeight(inner, fromNorth, 'full', 3)).toBeCloseTo(FULL_M);
    expect(wallHeight(inner, fromNorth, 'full', 2.4)).toBeCloseTo(2.3); // never through a low ceiling
  });

  it('puts glass in a full-height outside wall, none in a cut one', () => {
    const south = walls.find((wall) => wall.outer && wall.windows.length > 0)!;
    expect(wallParts(south, FULL_M).some((part) => part.mat === 'glass')).toBe(true);
    expect(wallParts(south, CUT_M).some((part) => part.mat === 'glass')).toBe(false);
  });
});

describe('things in place', () => {
  const thing = (id: string, type: string, position: Point, w: number, d: number, space = 'A') =>
    ({ id, type, space_id: space, position, footprint: { width_m: w, depth_m: d, rotation_deg: 0 } });

  it('turns a chair to face its table', () => {
    const placed = placeThings([thing('t', 'desk', [2, 3.2], 1.4, 0.7), thing('c', 'office_chair', [2, 2], 0.5, 0.5)]);
    const angle = placed.get('c')!.angle;
    // the chair's front is -y; turned by angle it must point at the desk (+y)
    const front: Point = [Math.sin(angle), -Math.cos(angle)];
    expect(front[0]).toBeCloseTo(0);
    expect(front[1]).toBeCloseTo(1);
  });

  it('leaves a chair with no table near it as it is', () => {
    const placed = placeThings([thing('t', 'desk', [2, 3.2], 1.4, 0.7, 'B'), thing('c', 'office_chair', [2, 2], 0.5, 0.5)]);
    expect(placed.get('c')!.angle).toBe(0);
  });

  it('lifts a coffee machine onto the counter it stands on', () => {
    const placed = placeThings([thing('k', 'kitchen_counter', [3, 4.6], 3, 0.6), thing('m', 'coffee_machine', [3.5, 4.6], 0.3, 0.4)]);
    expect(placed.get('m')!.z).toBeCloseTo(0.9);
    expect(placed.get('k')!.z).toBe(0);
  });
});

describe('drawing solids', () => {
  const solid = (depth: number, fills: string[]) => ({ depth, faces: fills.map((fill, i) => ({ d: `M${depth} ${i}`, fill, stroke: '#000' })) });

  it('draws face by face, joining neighbours of one colour, under the budget', () => {
    const drawn = drawSolids([solid(2, ['#a', '#a', '#b']), solid(1, ['#a'])], 100);
    expect(drawn.map((face) => face.fill)).toEqual(['#a', '#b', '#a']);
    expect(drawn[0].d).toBe('M2 0 M2 1');
  });

  it('groups by colour past the budget, so a big floor is a few paths', () => {
    const solids = Array.from({ length: 200 }, (_, i) => solid(200 - i, ['#a', '#b', '#c']));
    const drawn = drawSolids(solids, 100);
    expect(drawn.length).toBeLessThanOrEqual(24 * 3); // bands x colours
    expect(drawn.length).toBeLessThan(600);
    const total = drawn.reduce((sum, face) => sum + face.d.split('M').length - 1, 0);
    expect(total).toBe(600); // nothing lost
  });
});

describe('the camera', () => {
  it('keeps zoom between the limits', () => {
    expect(limitZoom(2, 10, 10)).toBe(2);
    expect(10 * limitZoom(100, 10, 10)).toBeCloseTo(10 * ZOOM_IN);
    expect(10 * limitZoom(0.01, 10, 10)).toBeCloseTo(10 * ZOOM_OUT);
    expect(limitZoom(1.5, 10 * ZOOM_IN, 10)).toBeCloseTo(1); // at the limit, zooming in does nothing
  });

  it('stops a wheel zoom at the limit instead of sliding the map away', () => {
    const wheel = { k: 0.5, tx: 60, ty: -30 }; // zoom out about a point off the middle
    expect(limitMove(wheel, 10, 10)).toEqual(wheel); // room to zoom: as it is
    const stuck = limitMove(wheel, 10 * ZOOM_OUT, 10);
    expect(stuck.k).toBeCloseTo(1);
    expect(stuck.tx).toBeCloseTo(0);
    expect(stuck.ty).toBeCloseTo(0);
    const drag = { k: 1, tx: 40, ty: 5 };
    expect(limitMove(drag, 10 * ZOOM_OUT, 10)).toEqual(drag); // a plain drag still moves
  });

  it('finds the room under a point, the smallest when one is inside another', () => {
    const hall = { ...room('H', 0, 'hall', 16), area_m2: 80 };
    const booth = { ...room('S', 2, 'office', 2), area_m2: 10 };
    expect(roomAt([hall, booth], [3, 2])?.id).toBe('S');
    expect(roomAt([hall, booth], [12, 2])?.id).toBe('H');
    expect(roomAt([hall, booth], [30, 2])).toBeNull();
  });
});

describe('the plan', () => {
  it('draws a thing from above: higher parts over lower ones, what hangs overhead dashed', () => {
    const parts = [box(-0.5, -0.3, 0.5, 0.3, 0, 0.9, 'woodLight', 0), box(-0.2, -0.2, 0.2, 0.2, 0.9, 0.95, 'steel', 2),
                   box(-0.5, 0.1, 0.5, 0.3, OVERHEAD_M, 2.1, 'woodLight', 1)];
    const near = partsFromAbove(parts, [10, 10], Math.PI / 2, 2);
    expect(near.shapes.map((shape) => shape.mat)).toEqual(['woodLight', 'steel']);
    expect(near.overhead).toHaveLength(1);
    // turned a quarter: x runs along world y
    const xs = near.shapes[0].ring.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.6);
    expect(partsFromAbove(parts, [0, 0], 0, 0).shapes).toHaveLength(1); // the details only from close up
  });

  it('layers many things low to high, one path per colour and height', () => {
    const low = partsFromAbove([box(0, 0, 1, 1, 0, 0.75, 'woodLight', 0)], [0, 0], 0, 2).shapes;
    const high = partsFromAbove([box(0, 0, 0.3, 0.3, 0, 0.3, 'steel', 0)], [0, 0], 0, 2, 0.75).shapes;
    const layers = layered([...high, ...low, ...low]);
    expect(layers).toHaveLength(2);
    expect(layers[0].rings).toHaveLength(2); // the two tables first
  });

  it('draws stairs with treads, arrows going up and down, and the cut', () => {
    const stairs = layoutStairs({ polygon: [[10, 0], [14, 0], [14, 6], [10, 6]], doors: [[12, 6]], up: 3.5, down: 3.5 })!;
    const plan = stairPlan(stairs);
    expect(plan.treads.length).toBeGreaterThan(10);
    expect(plan.arrows.map((arrow) => arrow.up).sort()).toEqual([false, true]);
    for (const arrow of plan.arrows) expect(arrow.head).toHaveLength(3);
    expect(plan.breaks.length).toBeGreaterThan(0);
    expect(plan.voids).toHaveLength(1);
  });

  it('draws walls as bands of their thickness and doors with their swing', () => {
    const walls = floorWalls(spaces, [door], footprint);
    const outer = walls.find((wall) => wall.outer)!;
    const inner = walls.find((wall) => !wall.outer)!;
    const width = (band: Point[]) => Math.hypot(band[0][0] - band[3][0], band[0][1] - band[3][1]);
    expect(width(wallBand(outer))).toBeCloseTo(OUTER_M);
    expect(width(wallBand(inner))).toBeCloseTo(INNER_M);
    const [leaf] = doorLeaves([door], spaces, walls);
    const symbol = doorSymbol(leaf);
    const [hinge, tip] = symbol.leaf;
    expect(Math.hypot(tip[0] - hinge[0], tip[1] - hinge[1])).toBeCloseTo(1);
    expect(symbol.swing[symbol.swing.length - 1][0]).toBeCloseTo(tip[0]);
    expect(symbol.swing[symbol.swing.length - 1][1]).toBeCloseTo(tip[1]);
  });

  it('shows walls, doors, stairs and things on the 2D floor', async () => {
    const stair: Space = { ...room('S', 16, 'stairwell', 4), type: 'stair', polygon: [[16, 0], [20, 0], [20, 6], [16, 6]] } as Space;
    const detail: BuildingDetail = {
      building: { id: 'b', name: 'B' },
      floors: [{ id: 'F0', level: 0, name: 'Ground', elevation_m: 0 }, { id: 'F1', level: 1, name: 'First', elevation_m: 3.5 }],
      spaces: [...spaces, stair],
      openings: [door, { id: 'O2', floor_id: 'F0', space_ids: ['B', 'S'], kind: 'door', position: [16, 3], width_m: 1 }],
      vertical_connectors: [],
      assets: [{ id: 'd1', name: 'Desk', type: 'desk', category: 'furniture', space_id: 'A', floor_id: 'F0', position: [3, 3],
                 footprint: { width_m: 1.4, depth_m: 0.7, rotation_deg: 0 } }],
    } as BuildingDetail;
    await render(<FloorPlan detail={detail} floorId="F0" map={null} footprints={[[[0, 0], [20, 0], [20, 6], [0, 6]]]} width={390} height={500} />);
    expect(screen.getByTestId('plan-walls')).toBeTruthy();
    expect(screen.getByTestId('plan-doors')).toBeTruthy();
    expect(screen.getByTestId('plan-stairs')).toBeTruthy();
    expect(screen.getByTestId('plan-things')).toBeTruthy();
  });
});
