import type { BuildingDetail, MapView } from '../api';
import { changesOn } from '../changes';

const square = (x: number): [number, number][] => [[x, 0], [x + 4, 0], [x + 4, 4], [x, 4]];
const detail = {
  building: { id: 'b', name: 'B' },
  floors: [{ id: 'F0', level: 0, name: 'Ground floor', elevation_m: 0 }],
  spaces: [
    { id: 'A', floor_id: 'F0', type: 'room', room_type: 'office', name: 'A', ref: null, polygon: square(0), area_m2: 16, anchor: [2, 2] },
    { id: 'B', floor_id: 'F0', type: 'room', room_type: 'office', name: 'B', ref: null, polygon: square(4), area_m2: 16, anchor: [6, 2] },
  ],
  openings: [],
  vertical_connectors: [],
  assets: [],
} as unknown as BuildingDetail;

test('a new door that was closed again shows as closed', () => {
  const door = { id: 'F0-O-new1', floor_id: 'F0', position: [4, 2] as [number, number], width_m: 0.9 };
  const open = { changes: { closed: [], new_doors: [door], moved: [] } } as unknown as MapView;
  const closedAgain = { changes: { closed: [door.id], new_doors: [door], moved: [] } } as unknown as MapView;
  expect(changesOn(detail, open, 'F0').doors.map((d) => d.kind)).toEqual(['new']);
  expect(changesOn(detail, closedAgain, 'F0').doors.map((d) => d.kind)).toEqual(['closed']);
});
