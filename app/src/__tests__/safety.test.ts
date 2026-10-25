/** Safety mode and reports on the map, on the real factory. */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { BuildingDetail, MapView, Report } from '../api';
import { changesOn, clock, withReports } from '../changes';
import { safetyButtons, safetyMarks } from '../safety';

const detail: BuildingDetail = JSON.parse(
  readFileSync(join(__dirname, '../../../data/dev/proc-factory-dev-003/building.json'), 'utf-8'));
const F0 = 'proc-factory-dev-003-F0';
const F1 = 'proc-factory-dev-003-F1';
const LIFT = 'proc-factory-dev-003-V02';
const report: Report = {
  element_id: LIFT, kind: 'lift', label: 'Office lift (Ground floor ↔ Floor 1)', floor_ids: [F0, F1],
  problem: 'the lift is broken', reported_at: new Date(2026, 9, 25, 10, 42).getTime() / 1000,
};

describe('safety mode', () => {
  it('offers only what the building has', () => {
    const kinds = safetyButtons(detail).map((button) => button.kind);
    expect(kinds).toContain('fire_extinguisher');
    expect(kinds).toContain('exit');
    expect(safetyButtons({ ...detail, assets: [], openings: [] })).toEqual([]);
    expect(safetyButtons(null)).toEqual([]);
  });

  it('lights up extinguishers, exits and the stairs on a floor, never the lifts', () => {
    const marks = safetyMarks(detail, F0);
    expect(marks.filter((mark) => mark.kind === 'fire_extinguisher').length).toBeGreaterThan(0);
    expect(marks.some((mark) => mark.kind === 'exit')).toBe(true);
    expect(marks.some((mark) => mark.kind === 'stairs' && mark.label === 'Office staircase')).toBe(true);
    expect(marks.some((mark) => mark.label === 'Office lift')).toBe(false);
  });
});

describe('reports on the map', () => {
  it('adds what is broken to the map, even without a route', () => {
    expect(withReports(null, [])).toBeNull();
    const map = withReports(null, [report]) as MapView;
    expect(map.changes?.closed).toEqual([LIFT]);
    const route: MapView = { you_are_here: null, target: null, route: null, focus_floor_id: F0,
                             changes: { closed: ['D1'], new_doors: [], moved: [] } };
    expect(withReports(route, [report])?.changes?.closed).toEqual(['D1', LIFT]);
  });

  it('labels a reported lift as out of service, with the time', () => {
    const changes = changesOn(detail, withReports(null, [report]), F0);
    expect(changes.labels[0].text).toBe(`Office lift out of service · ${clock(report.reported_at)}`);
    expect(clock(report.reported_at)).toBe('10:42');
  });
});

describe('stairs and lifts between the floors', () => {
  it('joins the floors each one serves, where it stands on each', () => {
    const { shaftStops } = require('../components/BuildingBlocks');
    const shafts = shaftStops(detail, [F0, F1]);
    const lift = shafts.find((shaft: { id: string }) => shaft.id === LIFT);
    expect(lift.kind).toBe('lift');
    expect(lift.stops.map((stop: { floorId: string }) => stop.floorId)).toEqual([F0, F1]);
    expect(shafts.some((shaft: { kind: string; name: string }) => shaft.kind === 'stairs' && shaft.name === 'Office staircase')).toBe(true);
  });

  it('draws stairs as a zig-zag and measures the distance to a shaft', () => {
    const { zigzag, segmentDistance } = require('../geometry');
    const points = zigzag([0, 0], [0, 60], 6, 5);
    expect(points).toHaveLength(7);
    expect(points[0]).toEqual([0, 0]);
    expect(points[6]).toEqual([0, 60]);
    expect(Math.abs(points[1][0])).toBeCloseTo(5);
    expect(segmentDistance([3, 30], [0, 0], [0, 60])).toBeCloseTo(3);
    expect(segmentDistance([0, 70], [0, 0], [0, 60])).toBeCloseTo(10);
  });
});
