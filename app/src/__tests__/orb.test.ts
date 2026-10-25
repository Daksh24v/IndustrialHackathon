/** FINNI's dotted sphere (search bar and voice) and the opening. */
import { COLORS, DX, DY, DZ, N, RINGS } from '../orb/motion';
import { placeFrom } from '../orb/GoogleIntro';
import { wantIntro } from '../orb/Intro';

describe('dotted sphere', () => {
  it('puts every dot on the unit sphere, ring by ring', () => {
    expect(N).toBeGreaterThan(RINGS * 4);
    for (let n = 0; n < N; n++) expect(Math.hypot(DX[n], DY[n], DZ[n])).toBeCloseTo(1, 5);
    expect(COLORS[0]).toBe('rgba(255,122,0,0.000)'); // Finni orange
    expect(COLORS[COLORS.length - 1]).toBe('rgba(52,211,153,1.000)'); // green when done
  });
});

describe('the opening', () => {
  it('shows once per visit, never with ?intro=0, always with ?intro=1', () => {
    expect(wantIntro('', null)).toBe(true);
    expect(wantIntro('', '1')).toBe(false);
    expect(wantIntro('?code=abc&intro=0', null)).toBe(false);
    expect(wantIntro('?intro=1', '1')).toBe(true);
  });

  it('reads the venue from "lat,lng" and ignores anything else', () => {
    expect(placeFrom('48.1568, 11.5518')).toEqual({ lat: 48.1568, lng: 11.5518 });
    expect(placeFrom(undefined)).toBeNull();
    expect(placeFrom('')).toBeNull();
    expect(placeFrom('Munich')).toBeNull();
    expect(placeFrom('120,11')).toBeNull();
  });
});
