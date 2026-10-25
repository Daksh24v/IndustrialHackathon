import type { Point } from '../api';
import {
  chooseCamera, clipNear, depthOf, fitCamera, pixelsPerMetre, project3d, ribbon, unproject3d, wallSegments,
  type Camera,
} from '../geometry';

const cam: Camera = { target: [0, 0], yaw: 0, tilt: (55 * Math.PI) / 180, distance: 40, scale: 10, ox: 200, oy: 300 };

describe('3D camera', () => {
  it('puts the target at (ox, oy)', () => {
    expect(project3d(cam, [0, 0])).toEqual([200, 300]);
  });

  it('draws farther floor points higher up the screen and smaller', () => {
    const near = project3d(cam, [0, -10]);
    const far = project3d(cam, [0, 10]);
    expect(far[1]).toBeLessThan(near[1]);
    expect(depthOf(cam, [0, 10])).toBeGreaterThan(depthOf(cam, [0, -10]));
    expect(pixelsPerMetre(cam, [0, 10])).toBeLessThan(pixelsPerMetre(cam, [0, -10]));
  });

  it('draws higher things higher up and keeps left and right', () => {
    expect(project3d(cam, [0, 0], 2)[1]).toBeLessThan(project3d(cam, [0, 0], 0)[1]);
    expect(project3d(cam, [5, 0])[0]).toBeGreaterThan(project3d(cam, [-5, 0])[0]);
  });

  it('turns with yaw: a quarter turn puts east where north was', () => {
    const turned = { ...cam, yaw: Math.PI / 2 };
    const east = project3d(turned, [10, 0]);
    const north = project3d(cam, [0, 10]);
    expect(east[0]).toBeCloseTo(north[0]);
    expect(east[1]).toBeCloseTo(north[1]);
  });

  it('finds the floor point under a screen point', () => {
    const turned = { ...cam, yaw: 0.7, target: [3, -4] as Point };
    for (const p of [[3, -4], [10, 2], [-6, -12]] as Point[]) {
      const back = unproject3d(turned, project3d(turned, p));
      expect(back[0]).toBeCloseTo(p[0]);
      expect(back[1]).toBeCloseTo(p[1]);
    }
  });

  it('cuts away what is behind the camera', () => {
    const square: Point[] = [[-5, -200], [5, -200], [5, 5], [-5, 5]];
    const clipped = clipNear(cam, square);
    expect(clipped.length).toBe(4);
    for (const p of clipped) expect(depthOf(cam, p)).toBeGreaterThanOrEqual(cam.distance * 0.25 - 1e-9);
    expect(clipNear(cam, [[0, 0], [1, 0], [1, 1]])).toHaveLength(3); // fully in front: unchanged
  });

  it('fits points into the screen', () => {
    const points: [number, number, number][] = [[0, 0, 0], [30, 0, 0], [30, 12, 0], [0, 12, 2.5]];
    const fitted = fitCamera(points, 390, 600, 0.3, cam.tilt);
    for (const [x, y, z] of points) {
      const [sx, sy] = project3d(fitted, [x, y], z);
      expect(sx).toBeGreaterThanOrEqual(31.9);
      expect(sx).toBeLessThanOrEqual(358.1);
      expect(sy).toBeGreaterThanOrEqual(31.9);
      expect(sy).toBeLessThanOrEqual(568.1);
    }
  });

  it('chooses a view where the walk goes into the picture', () => {
    const start: Point = [0, 0];
    const end: Point = [0, 30];
    const fitted = chooseCamera([[0, 0, 0], [0, 30, 0]], 390, 600, cam.tilt, start, end);
    expect(project3d(fitted, start)[1]).toBeGreaterThan(project3d(fitted, end)[1]);
    const back = chooseCamera([[0, 0, 0], [0, 30, 0]], 390, 600, cam.tilt, end, start);
    expect(project3d(back, end)[1]).toBeGreaterThan(project3d(back, start)[1]);
  });
});

describe('walls', () => {
  const left: Point[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const right: Point[] = [[4, 0], [8, 0], [8, 4], [4, 4]];

  it('draws a shared wall once', () => {
    expect(wallSegments([left, right], [])).toHaveLength(7);
  });

  it('leaves a gap for a door', () => {
    const walls = wallSegments([left], [{ position: [2, 0.1], width_m: 1 }]);
    expect(walls).toHaveLength(5);
    const bottom = walls.filter(([a, b]) => a[1] === 0 && b[1] === 0);
    expect(bottom.map(([a, b]) => [a[0], b[0]])).toEqual([[0, 1.5], [2.5, 4]]);
  });

  it('ignores doors that are not on the wall', () => {
    expect(wallSegments([left], [{ position: [2, 2], width_m: 1 }])).toHaveLength(4);
  });
});

describe('ribbon', () => {
  it('is a band around the line', () => {
    const band = ribbon([[0, 0], [10, 0]], 0.5);
    expect(band).toEqual([[0, 0.5], [10, 0.5], [10, -0.5], [0, -0.5]]);
  });

  it('keeps its width around a corner', () => {
    const band = ribbon([[0, 0], [10, 0], [10, 10]], 0.5);
    expect(band).toHaveLength(6);
    expect(band[1][0]).toBeCloseTo(9.5);
    expect(band[1][1]).toBeCloseTo(0.5);
  });

  it('needs two different points', () => {
    expect(ribbon([[1, 1], [1, 1]], 0.5)).toEqual([]);
  });
});

describe('moving the camera', () => {
  const { rotateAbout, moveCamera, moveTransform, fit, toScreen } = require('../geometry');

  it('turns about a point that stays put on screen', () => {
    const pivot: Point = [7, -3];
    const before = project3d(cam, pivot);
    const turned = rotateAbout(cam, pivot, Math.PI / 2);
    const after = project3d(turned, pivot);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
    expect(turned.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('zooms about the screen centre and shifts', () => {
    const centre = unproject3d(cam, [200, 300]);
    const zoomed = moveCamera(cam, 2, 10, -5, 400, 600);
    const [x, y] = project3d(zoomed, centre);
    expect(x).toBeCloseTo(210);
    expect(y).toBeCloseTo(295);
    expect(pixelsPerMetre(zoomed, [0, 0])).toBeCloseTo(2 * pixelsPerMetre(cam, [0, 0]));
  });

  it('does the same for the flat view', () => {
    const t = fit({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 100, 100, 0);
    const moved = moveTransform(t, 2, 5, 0, 100, 100);
    expect(toScreen(moved, [5, 5])).toEqual([55, 50]);
    expect(toScreen(moved, [10, 5])[0] - toScreen(moved, [5, 5])[0]).toBeCloseTo(100);
  });
});

describe('the building turning', () => {
  const { fitScale } = require('../components/BuildingBlocks');
  const floors = [
    { elevation_m: 0, height_m: 4, footprints: [[[0, 0], [40, 0], [40, 10], [0, 10]]] },
    { elevation_m: 4, height_m: 4, footprints: [[[0, 0], [40, 0], [40, 10], [0, 10]]] },
  ];

  it('is sized so that it fits at every angle (no jumping while it turns)', () => {
    const { isoProject } = require('../geometry');
    const scale = fitScale(floors, [20, 5], 800, 600);
    for (let step = 0; step < 36; step += 1) {
      const iso = { angle: (step / 36) * 2 * Math.PI, centre: [20, 5] };
      for (const floor of floors) {
        for (const p of floor.footprints[0]) {
          const [x] = isoProject(iso, p, floor.elevation_m);
          expect(Math.abs(x) * scale).toBeLessThanOrEqual(800 * 0.82);
        }
      }
    }
    expect(scale).toBeGreaterThan(0);
  });
});

describe('the compass', () => {
  const { wrapAngle } = require('../components/FloorScene');

  it('turns back to north the short way', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(wrapAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(-5 * Math.PI)).toBeCloseTo(Math.PI);
  });
});
