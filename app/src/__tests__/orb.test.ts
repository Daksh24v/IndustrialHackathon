import {
  ASSEMBLE, COLORS, CONDENSE, cubicBezier, DX, DY, DZ, E, INIT, launchTracks, N, RINGS, sampleAt, unfoldTracks,
  valueAt, type Sample,
} from '../orb/motion';

describe('easing', () => {
  it('starts at 0, ends at 1 and never goes backwards (no overshoot curve)', () => {
    for (const ease of [E.out, E.io, E.in, E.fly, E.card]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      let last = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        expect(ease(t)).toBeGreaterThanOrEqual(last - 1e-9);
        last = ease(t);
      }
    }
  });

  it('matches the CSS curve: ease-in-out is symmetric', () => {
    const io = cubicBezier(0.65, 0, 0.35, 1);
    expect(io(0.5)).toBeCloseTo(0.5, 3);
    expect(io(0.25) + io(0.75)).toBeCloseTo(1, 3);
  });

  it('springs past 1 and settles', () => {
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => E.spring(i / 50)));
    expect(peak).toBeGreaterThan(1);
    expect(E.spring(1)).toBe(1);
  });
});

describe('timelines', () => {
  const geo = { pw: 560, cw: 440, ch: 180, H: 300, dir: 1 };

  it('the pill becomes a ball that lands as the orb, and the resting orb gives way', () => {
    const launch = launchTracks(geo);
    expect(valueAt(launch, 'w', 0, geo.pw)).toBe(geo.pw);
    expect(valueAt(launch, 'w', 600, geo.pw)).toBeCloseTo(60);
    expect(valueAt(launch, 'w', 1500, geo.pw)).toBeCloseTo(132);
    expect(valueAt(launch, 'u', 1500, 0)).toBe(1); // flown up to the centre
    expect(valueAt(launch, 'rest', 1000, 1)).toBe(1);
    expect(valueAt(launch, 'rest', 1500, 1)).toBe(0);
    expect(valueAt(launch, 'oPill', 1500, 1)).toBe(0);
  });

  it('the orb appears, condenses into the green disc, and the card unfolds to the measured size', () => {
    expect(valueAt(ASSEMBLE, 'orb.alpha', 800, 0)).toBe(1);
    expect(valueAt(CONDENSE, 'oGreen', 700, 0)).toBe(1);
    expect(valueAt(CONDENSE, 'orb.alpha', 800, 1)).toBe(0);
    const unfold = unfoldTracks(geo, 500);
    expect(valueAt(unfold, 'w', 700, 132)).toBe(geo.cw);
    expect(valueAt(unfold, 'h', 700, 132)).toBe(geo.ch);
    expect(valueAt(unfold, 'oCard', 600, 0)).toBe(1);
  });

  it('starts from a resting state with the pill showing', () => {
    expect(INIT.oPill).toBe(1);
    expect(INIT.rest).toBe(1);
    expect(INIT['orb.alpha']).toBe(0);
  });
});

describe('dotted sphere', () => {
  it('puts every dot on the unit sphere, ring by ring', () => {
    expect(N).toBeGreaterThan(RINGS * 4);
    for (let n = 0; n < N; n++) expect(Math.hypot(DX[n], DY[n], DZ[n])).toBeCloseTo(1, 5);
    expect(COLORS[0]).toBe('rgba(235,235,235,0.000)');
  });
});

describe('comet trail', () => {
  const history: Sample[] = [{ t: 0, x: 0, y: 0, d: 60 }, { t: 100, x: 10, y: -20, d: 80 }];

  it('interpolates between samples and clamps at the ends', () => {
    const out: Sample = { t: 0, x: 0, y: 0, d: 0 };
    sampleAt(history, 50, out);
    expect([out.x, out.y, out.d]).toEqual([5, -10, 70]);
    sampleAt(history, -10, out);
    expect(out.x).toBe(0);
    sampleAt(history, 500, out);
    expect(out.y).toBe(-20);
    sampleAt([], 5, out);
    expect(out.d).toBe(0);
  });
});
