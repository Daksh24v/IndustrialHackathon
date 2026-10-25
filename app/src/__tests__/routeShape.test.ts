/** The route is drawn straight down the middle of a corridor; the real route (its metres) is not touched. */
import type { Point } from '../api';
import { straightRoute } from '../routeShape';

// A corridor 2 m wide and 20 m long (x 0..20, y 0..2), an office above it and an L-shaped corridor elsewhere.
const corridor = { type: 'corridor', room_type: 'corridor', polygon: [[0, 0], [20, 0], [20, 2], [0, 2]] as Point[] };
const office = { type: 'room', room_type: 'office', polygon: [[0, 2], [6, 2], [6, 6], [0, 6]] as Point[] };

describe('the route drawn straight', () => {
  it('runs along the middle of the corridor, with short straight bits in and out of the doors', () => {
    // from the office door landing (near the top wall) diagonally to a landing near the bottom wall far down
    const real: Point[] = [[3, 4], [3, 1.7], [17, 0.3], [17, -1]];
    expect(straightRoute(real, [corridor, office])).toEqual([[3, 4], [3, 1.7], [3, 1], [17, 1], [17, 0.3], [17, -1]]);
  });

  it('leaves a crossing, a hall and an L-shaped corridor as they are', () => {
    const across: Point[] = [[5, -1], [5.3, 0.3], [5.6, 1.7], [5.6, 3]];
    expect(straightRoute(across, [corridor])).toEqual(across);
    const hall = { type: 'hall', room_type: 'production_zone', polygon: corridor.polygon };
    const diagonal: Point[] = [[1, 0.3], [19, 1.7]];
    expect(straightRoute(diagonal, [hall])).toEqual(diagonal);
    const ell = { type: 'corridor', room_type: 'corridor', polygon: [[0, 0], [20, 0], [20, 2], [2, 2], [2, 20], [0, 20]] as Point[] };
    const round: Point[] = [[1, 18], [1.2, 1.2], [18, 1]];
    expect(straightRoute(round, [ell])).toEqual(round);
  });

  it('keeps where it starts and ends', () => {
    const real: Point[] = [[0.5, 0.4], [19.5, 1.6]];
    const drawn = straightRoute(real, [corridor]);
    expect(drawn[0]).toEqual(real[0]);
    expect(drawn[drawn.length - 1]).toEqual(real[1]);
    expect(drawn).toEqual([[0.5, 0.4], [0.5, 1], [19.5, 1], [19.5, 1.6]]);
  });
});
