import { assetRect, boundsOf, centre, fit, grow, linePath, lineLength, polygonPath, signedArea as area, toScreen, toWorld } from '../geometry';
import type { Point } from '../api';

describe('fit', () => {
  it('keeps the aspect ratio and centres the shorter side', () => {
    const t = fit({ minX: 0, minY: 0, maxX: 20, maxY: 10 }, 220, 220, 10);
    expect(t.scale).toBeCloseTo(10); // 200 px for 20 m
    const [x0, y0] = toScreen(t, [0, 10]);
    const [x1, y1] = toScreen(t, [20, 0]);
    expect([x0, x1]).toEqual([10, 210]);
    expect(y1 - y0).toBeCloseTo(100);
    expect((y0 + y1) / 2).toBeCloseTo(110); // centred vertically
  });

  it('flips y: north (larger y) is up on screen', () => {
    const t = fit({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 100, 100, 0);
    expect(toScreen(t, [0, 10])[1]).toBeLessThan(toScreen(t, [0, 0])[1]);
  });

  it('round-trips between world and screen', () => {
    const t = fit({ minX: -43.5, minY: -12, maxX: 12, maxY: 73.5 }, 390, 700);
    const p: Point = [3.25, -7.5];
    const back = toWorld(t, toScreen(t, p));
    expect(back[0]).toBeCloseTo(p[0]);
    expect(back[1]).toBeCloseTo(p[1]);
  });
});

describe('paths', () => {
  const t = fit({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 100, 100, 0);

  it('draws closed polygons and open lines', () => {
    expect(polygonPath(t, [[0, 0], [10, 0], [10, 10]])).toBe('M0 100 L100 100 L100 0 Z');
    expect(linePath(t, [[0, 0], [5, 5]])).toBe('M0 100 L50 50');
    expect(polygonPath(t, [])).toBe('');
  });

  it('measures lines and finds centres and bounds', () => {
    expect(lineLength([[0, 0], [3, 4], [3, 10]])).toBeCloseTo(11);
    expect(centre([[0, 0], [4, 0], [4, 2], [0, 2]])).toEqual([2, 1]);
    expect(grow(boundsOf([[1, 1], [2, 3]]), 1)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 4 });
  });
});

describe('isometric view', () => {
  const { isoProject, isoDepth, signedArea } = require('../geometry');
  const iso = { angle: 0, centre: [0, 0] };

  it('draws higher things higher up the screen and keeps the centre in place', () => {
    expect(isoProject(iso, [0, 0], 0)).toEqual([0, -0]);
    expect(isoProject(iso, [0, 0], 10)[1]).toBeLessThan(isoProject(iso, [0, 0], 0)[1]);
  });

  it('puts the near corner (-x, -y) lower on the screen and in front', () => {
    expect(isoProject(iso, [-5, -5], 0)[1]).toBeGreaterThan(isoProject(iso, [5, 5], 0)[1]);
    expect(isoDepth(iso, [-5, -5])).toBeGreaterThan(isoDepth(iso, [5, 5]));
  });

  it('knows the winding of a ring', () => {
    expect(signedArea([[0, 0], [4, 0], [4, 2], [0, 2]])).toBe(8);
    expect(signedArea([[0, 0], [0, 2], [4, 2], [4, 0]])).toBe(-8);
  });
});

describe('assetRect', () => {
  it('turns the footprint about its centre, counter-clockwise', () => {
    const flat = assetRect([10, 5], { width_m: 4, depth_m: 2, rotation_deg: 0 });
    expect(flat).toEqual([[8, 4], [12, 4], [12, 6], [8, 6]]);
    const turned = assetRect([0, 0], { width_m: 4, depth_m: 2, rotation_deg: 90 });
    expect(turned[1][0]).toBeCloseTo(1); // the +x end of the width now points up
    expect(turned[1][1]).toBeCloseTo(2);
    expect(Math.abs(area(turned))).toBeCloseTo(8);
  });
});
