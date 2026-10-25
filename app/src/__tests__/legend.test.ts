/** The map key lists what the colours mean, only for what the open building has. */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { BuildingDetail } from '../api';
import { mapKey } from '../legend';
import { roomStyle, setTheme } from '../theme';

const detail: BuildingDetail = JSON.parse(
  readFileSync(join(__dirname, '../../../data/dev/proc-factory-dev-003/building.json'), 'utf8'));

describe('the map key', () => {
  it('names the room colours this factory has, with the colours the map draws', () => {
    const key = mapKey(detail)!;
    const labels = key.rooms.map((line) => line.label);
    expect(labels).toEqual(expect.arrayContaining(['Offices, meeting rooms, lecture halls', 'Production and assembly',
                                                   'Kitchens, toilets, lockers, shops', 'Corridors']));
    expect(labels).not.toContain('Bedrooms and living rooms'); // no homes in a factory
    const kitchen = detail.spaces.find((space) => space.room_type === 'kitchen')!;
    expect(key.rooms.find((line) => line.id === 'amenity')?.fill).toBe(roomStyle(kitchen).fill);
  });

  it('lists the signs and floor patterns, and orange and red', () => {
    const key = mapKey(detail)!;
    expect(key.signs.map((line) => line.label)).toEqual(expect.arrayContaining(['Toilets', 'Kitchen, canteen', 'Stairs']));
    expect(key.floors).toContain('Checkerboard floor: kitchen, canteen');
    expect(key.marks.map((line) => line.id)).toEqual(['route', 'closed']);
  });

  it('follows the look', () => {
    setTheme('light');
    const light = mapKey(detail)!.rooms[0].fill;
    setTheme('dark');
    expect(mapKey(detail)!.rooms[0].fill).not.toBe(light);
    expect(mapKey(null)).toBeNull();
  });
});
