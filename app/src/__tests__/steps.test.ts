/** Directions from the route geometry, on the real factory and the route the e2e uses. */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { BuildingDetail, MapView, Point } from '../api';
import { categories } from '../categories';
import { bare, heading, routeSteps, sayDuration, summary, turnWord, whyThisWay } from '../steps';

const detail: BuildingDetail = JSON.parse(
  readFileSync(join(__dirname, '../../../data/dev/proc-factory-dev-003/building.json'), 'utf-8'));
const F0 = 'proc-factory-dev-003-F0';
const F1 = 'proc-factory-dev-003-F1';
// POST /buildings/proc-factory-dev-003/route, Quality lab 0.21 -> Office 1.04 (kit 1.1.0 rules)
const map: MapView = {
  you_are_here: { space_id: `${F0}-S021`, label: 'Quality lab 0.21 (Ground floor)', floor_id: F0, position: [2.5, 12.3] },
  target: { space_id: `${F1}-S004`, label: 'Office 1.04 (Floor 1)', floor_id: F1, position: [2.5, 2.715] },
  focus_floor_id: F0,
  route: {
    length_m: 30.16,
    pieces: [
      { floor_id: F0, points: [[2.5, 12.3], [4.7, 12.3], [5.0, 12.3], [5.3, 12.3], [6.7, 2.003], [7.0, 2.003], [7.3, 2.003], [9.5, 2.0]],
        then: { kind: 'stairs', via: 'proc-factory-dev-003-V01', name: 'Office staircase', to_floor_id: F1 } },
      { floor_id: F1, points: [[9.5, 2.0], [7.3, 2.003], [7.0, 2.003], [6.7, 2.003], [5.3, 2.718], [5.0, 2.718], [4.7, 2.718], [2.5, 2.715]],
        then: null },
    ],
  },
};

describe('turns', () => {
  it('reads left and right with y north, like the agent', () => {
    expect(turnWord([1, 0], [0, 1])).toBe('Turn left');
    expect(turnWord([1, 0], [0, -1])).toBe('Turn right');
    expect(turnWord([1, 0], [1, 0.1])).toBe('Go straight');
    expect(turnWord([1, 0], [-1, 0.01])).toBe('Turn around');
    expect(turnWord(null, [1, 0])).toBe('Go');
  });

  it('judges the heading over the 2 m next to the door', () => {
    const path: Point[] = [[0, 0], [10, 0], [10, 1]];
    expect(heading(path, true)).toEqual([10, 1]); // over the last 2 m: the corridor and the step north
    expect(heading(path, false)).toEqual([10, 0]);
    expect(heading([[1, 1]], false)).toBeNull();
  });
});

describe('route steps', () => {
  const steps = routeSteps(map, detail);

  it('says what the agent says, step by step', () => {
    expect(steps.map((step) => [step.action, step.walk_m])).toEqual([
      ['Turn right into Office corridor 0.16', 2],
      ['Turn left into Staircase 0.17', 11],
      ['Take Office staircase up to Floor 1', 0],
      ['Go straight into Office corridor 1.01', 2],
      ['Go straight into Office 1.04', 2],
      ['Arrive at Office 1.04', 2],
    ]);
    expect(steps[0].near).toBe('by the Coordinate measuring machine 0.21');
  });

  it('knows where each step is', () => {
    expect(steps[0].floorId).toBe(F0);
    expect(steps[0].path[steps[0].path.length - 1]).toEqual([5.0, 12.3]); // the door
    expect(steps[2]).toMatchObject({ kind: 'stairs', toFloorId: F1 });
    expect(steps[5].floorId).toBe(F1);
    expect(steps[5].path[steps[5].path.length - 1]).toEqual([2.5, 2.715]);
  });

  it('is empty without a route', () => {
    expect(routeSteps(null, detail)).toEqual([]);
    expect(routeSteps({ ...map, route: null }, detail)).toEqual([]);
  });

  it('sums it up', () => {
    expect(summary(map, detail)).toEqual({ length_m: 30, time_s: 23, time: 'about 23 s', floors: 1, up: true,
                                          stepFree: false }); // 30 m at 1.3 m/s
    const lift = { ...map, route: { ...map.route!, pieces: [
      { ...map.route!.pieces[0], then: { kind: 'lift', name: 'Office lift', to_floor_id: F1 } }, map.route!.pieces[1]] } };
    expect(summary(lift, detail)?.stepFree).toBe(true);
    expect(routeSteps(lift, detail)[2]).toMatchObject({ kind: 'lift', action: 'Take Office lift up to Floor 1' });
    expect(bare('Office 1.04 (Floor 1)')).toBe('Office 1.04');
  });
});

describe('how long it takes', () => {
  it('says seconds, then minutes, then hours', () => {
    expect(sayDuration(52)).toBe('about 52 s');
    expect(sayDuration(0.4)).toBe('about 1 s');
    expect(sayDuration(95)).toBe('about 2 min');
    expect(sayDuration(1500)).toBe('about 25 min');
    expect(sayDuration(3900)).toBe('about 1 h 5 min');
  });
});

describe('quick searches', () => {
  it('offers only what the building has', () => {
    const labels = categories(detail).map((category) => category.label);
    expect(labels.length).toBeGreaterThan(2);
    expect(labels.length).toBeLessThanOrEqual(6);
    expect(labels).toContain('Toilets');
    expect(categories({ ...detail, assets: [], spaces: [], openings: [] })).toEqual([]);
    expect(categories(null)).toEqual([]);
  });
});

describe('the rooms along a route', () => {
  it('lists where the route starts, passes and ends', () => {
    const { routeSpaces, landmarkNames } = require('../steps');
    const spaces: Set<string> = routeSpaces(map, detail);
    const names = [...spaces].map((id) => detail.spaces.find((space) => space.id === id)?.name);
    expect(names).toEqual(expect.arrayContaining(['Quality lab 0.21', 'Office corridor 0.16', 'Staircase 0.17',
                                                  'Office corridor 1.01', 'Office 1.04']));
    expect(names).not.toContain('Toilet 0.22');
    expect(routeSpaces(null, detail).size).toBe(0);
    expect([...landmarkNames(routeSteps(map, detail))]).toEqual(['Coordinate measuring machine 0.21']);
  });
});

describe('profiles', () => {
  it('says why a forklift goes round, how much longer and how long', () => {
    const route = { ...map.route!, profile: 'Forklift', why_detour: ['Main aisle H-B2 (Ground floor) is closed'],
      extra_m: 20.2, time_s: 54 };
    expect(whyThisWay(route)).toBe('Why this way: Main aisle H-B2 (Ground floor) is closed · 20 m longer · about 54 s');
    const sum = summary({ ...map, route }, detail);
    expect(sum).toMatchObject({ profile: 'Forklift', time_s: 54, time: 'about 54 s' });
    expect(whyThisWay({ ...route, why_detour: [], extra_m: 0, time_s: 300 })).toBe('The direct way fits a forklift · about 5 min');
    expect(summary(map, detail)?.why).toBeUndefined(); // on foot: nothing new
  });

  it('puts the forklift quick searches first when driving one', () => {
    const labels = categories(detail, 'forklift').map((category) => category.label);
    expect(labels.slice(0, 2)).toEqual(['Loading dock', 'Forklift charger']);
    expect(categories(detail).map((category) => category.label)).not.toContain('Loading dock');
  });
});
