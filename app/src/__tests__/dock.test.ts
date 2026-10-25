/** The map buttons swell near the mouse like a dock, and spread so they never overlap. */
import { dockLayout } from '../ui/dock';

const column = [0, 1, 2, 3, 4].map((i) => ({ top: i * 54, height: 44 })); // five 44 px buttons, 10 px apart

describe('the dock', () => {
  it('swells the button under the mouse most, its neighbours less, the far ones not at all', () => {
    const layout = dockLayout(column, 2 * 54 + 22); // on the middle one
    expect(layout[2].scale).toBeCloseTo(1.35);
    expect(layout[1].scale).toBeGreaterThan(1);
    expect(layout[1].scale).toBeLessThan(layout[2].scale);
    expect(layout[1].scale).toBeCloseTo(layout[3].scale);
    expect(dockLayout(column, 2000).every(({ scale, dy }) => scale === 1 && dy === 0)).toBe(true);
  });

  it('keeps what is under the mouse in place and spreads the rest so nothing overlaps', () => {
    const mouse = 2 * 54 + 22;
    const layout = dockLayout(column, mouse);
    expect(layout[2].dy).toBeCloseTo(0);
    const drawn = column.map(({ top, height }, i) => {
      const middle = top + height / 2 + layout[i].dy;
      const half = (height * layout[i].scale) / 2;
      return [middle - half, middle + half];
    });
    for (let i = 1; i < drawn.length; i += 1) expect(drawn[i][0]).toBeGreaterThanOrEqual(drawn[i - 1][1] + 9.9);
  });
});
