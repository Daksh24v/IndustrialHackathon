import { fireEvent, render, screen } from '@testing-library/react-native';

import type { BuildingDetail, MapView } from '../api';
import { FloorPlan } from '../components/FloorPlan';
import { FloorScene } from '../components/FloorScene';

const room = (id: string, x: number, name: string) => ({
  id, floor_id: 'F0', type: 'room', room_type: 'office', name, ref: null, area_m2: 40, anchor: [x + 4, 2.5] as [number, number],
  polygon: [[x, 0], [x + 8, 0], [x + 8, 5], [x, 5]] as [number, number][],
});
const detail: BuildingDetail = {
  building: { id: 'b', name: 'B' },
  floors: [{ id: 'F0', level: 0, name: 'Ground floor', elevation_m: 0 }],
  spaces: [room('A', 0, 'Lab'), room('B', 8, 'Office')],
  openings: [{ id: 'O1', floor_id: 'F0', space_ids: ['A', 'B'], kind: 'door', position: [8, 2.5], width_m: 1 }],
  vertical_connectors: [],
  assets: [],
};
const map: MapView = {
  you_are_here: { label: 'Lab', floor_id: 'F0', position: [4, 2.5], space_id: 'A' },
  target: { label: 'Office', floor_id: 'F0', position: [12, 2.5], space_id: 'B' },
  route: { length_m: 8, pieces: [{ floor_id: 'F0', points: [[4, 2.5], [8, 2.5], [12, 2.5]], then: null }] },
  focus_floor_id: 'F0',
};
const footprint: [number, number][][] = [[[0, 0], [16, 0], [16, 5], [0, 5]]];

describe('floor views', () => {
  it('draws the 3D floor with the route, you and the target, and turns and zooms', async () => {
    await render(<FloorScene detail={detail} floorId="F0" map={map} footprints={footprint} width={390} height={500} />);
    expect(screen.getByTestId('you-are-here')).toBeTruthy();
    expect(screen.getByTestId('target-pin')).toBeTruthy();
    expect(screen.getAllByTestId('route-line')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('zoom-in'));
    await fireEvent.press(screen.getByTestId('turn'));
    expect(screen.getByTestId('floor-scene')).toBeTruthy();
  });

  it('draws the floor without a route', async () => {
    await render(<FloorScene detail={detail} floorId="F0" map={null} footprints={footprint} width={390} height={500} />);
    expect(screen.queryByTestId('you-are-here')).toBeNull();
  });

  it('draws the 2D floor too', async () => {
    await render(<FloorPlan detail={detail} floorId="F0" map={map} width={390} height={500} />);
    expect(screen.getByTestId('you-are-here')).toBeTruthy();
    expect(screen.getByTestId('target-pin')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('zoom-out'));
  });
});
