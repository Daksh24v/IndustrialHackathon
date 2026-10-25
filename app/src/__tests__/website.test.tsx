/** The website additions: building picker, wide layout helper, wheel zoom, building edits, session recovery. */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError, buildingFromUrl, pickBuilding, type BuildingDetail, type MapView } from '../api';
import { changesOn } from '../changes';
import { BuildingPicker, groupBuildings } from '../components/BuildingPicker';
import { floorAt } from '../components/BuildingBlocks';
import { FloorPlan } from '../components/FloorPlan';
import { FloorScene } from '../components/FloorScene';
import { compose, moved, wheelMove } from '../gestures';
import { chatTurn } from '../session';
import { reduce, initial } from '../state';
import { isWide } from '../theme';

const rows = [
  { id: 'resplan-1', split: 'dev', name: 'Residence 1', source: 'resplan' },
  { id: 'proc-factory-dev-003', split: 'dev', name: 'Fertigung Ost 27', source: 'procedural' },
  { id: 'new-1', split: 'sunday', name: 'Sunday hall', source: 'procedural' },
];

describe('building picker', () => {
  it('groups by source with Sunday buildings first, and searches name or id', () => {
    expect(groupBuildings(rows, '').map((group) => group.title)).toEqual(
      ['New buildings', 'Factories and campuses', 'ResPlan homes']);
    expect(groupBuildings(rows, 'fertigung')[0].rows.map((row) => row.id)).toEqual(['proc-factory-dev-003']);
    expect(groupBuildings(rows, 'resplan-1')[0].rows[0].name).toBe('Residence 1');
    expect(groupBuildings(rows, 'nothing')).toEqual([]);
  });

  it('opens, searches and picks', async () => {
    const onPick = jest.fn();
    await render(<BuildingPicker buildings={rows} current={{ id: 'proc-factory-dev-003', name: 'Fertigung Ost 27' }}
                                 onPick={onPick} />);
    await fireEvent.press(screen.getByTestId('building-picker'));
    await fireEvent.changeText(screen.getByTestId('building-search'), 'sunday');
    expect(screen.queryByTestId('building-resplan-1')).toBeNull();
    await fireEvent.press(screen.getByTestId('building-new-1'));
    expect(onPick).toHaveBeenCalledWith('new-1');
    expect(screen.queryByTestId('building-menu')).toBeNull();
  });

  it('reads ?building= and falls back to the usual pick', () => {
    expect(buildingFromUrl('?building=resplan-1')).toBe('resplan-1');
    expect(buildingFromUrl('')).toBeUndefined();
    const ids = rows.map((row) => row.id);
    expect(pickBuilding(ids, buildingFromUrl('?building=resplan-1'))).toBe('resplan-1');
    expect(pickBuilding(ids, buildingFromUrl('?building=gone'))).toBe('proc-factory-dev-003');
  });
});

describe('layout and gestures', () => {
  it('uses the side panel from 900 px', () => {
    expect(isWide(899)).toBe(false);
    expect(isWide(900)).toBe(true);
  });

  it('wheel zoom keeps the point under the cursor in place', () => {
    const cursor: [number, number] = [100, 50];
    const zoomIn = wheelMove(-100, 0, cursor, 800, 600);
    expect(zoomIn.k).toBeGreaterThan(1);
    const [x, y] = moved(zoomIn, 800, 600, cursor);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(50);
    expect(wheelMove(3, 1, cursor, 800, 600).k).toBeLessThan(1); // lines, zoom out
    const other = wheelMove(-40, 0, [600, 400], 800, 600);
    const both = moved(compose(zoomIn, other), 800, 600, [10, 20]);
    const stepwise = moved(other, 800, 600, moved(zoomIn, 800, 600, [10, 20]));
    expect(both[0]).toBeCloseTo(stepwise[0]);
    expect(both[1]).toBeCloseTo(stepwise[1]);
  });

  it('finds the floor block under a click, the top one first', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
    const floors = [{ id: 'F0', faces: [{ points: square }] }, { id: 'F1', faces: [{ points: square.map(([x, y]) => [x, y - 5] as [number, number]) }] }];
    expect(floorAt(floors, [5, 2])).toBe('F1');
    expect(floorAt(floors, [5, 8])).toBe('F0');
    expect(floorAt(floors, [50, 50])).toBeNull();
  });
});

const room = (id: string, x: number, name: string, type = 'room') => ({
  id, floor_id: 'F0', type, room_type: 'office', name, ref: null, area_m2: 40, anchor: [x + 4, 2.5] as [number, number],
  polygon: [[x, 0], [x + 8, 0], [x + 8, 5], [x, 5]] as [number, number][],
});
const detail: BuildingDetail = {
  building: { id: 'b', name: 'B' },
  floors: [{ id: 'F0', level: 0, name: 'Ground floor', elevation_m: 0 }],
  spaces: [room('A', 0, 'Lab'), room('B', 8, 'Office'), room('L', 16, 'Lift', 'lift')],
  openings: [{ id: 'O1', floor_id: 'F0', space_ids: ['A', 'B'], kind: 'door', position: [8, 2.5], width_m: 1 }],
  vertical_connectors: [{ id: 'V1', kind: 'lift', name: 'Office lift', floor_ids: ['F0'], space_ids: ['L'] }],
  assets: [],
};
const map: MapView = {
  you_are_here: null, target: null, route: null, focus_floor_id: 'F0',
  changes: {
    closed: ['O1', 'V1', 'B'],
    new_doors: [{ id: 'N1', floor_id: 'F0', position: [4, 5], width_m: 1.2 }],
    moved: [{ asset_id: 'T1', label: 'Coffee machine', space_id: 'A', floor_id: 'F0', position: [2, 2] }],
  },
};

describe('building edits on the map', () => {
  it('works out what to draw on a floor', () => {
    const changes = changesOn(detail, map, 'F0');
    expect([...changes.closedSpaces].sort()).toEqual(['B', 'L']);
    const door = changes.doors.find((item) => item.id === 'O1')!;
    expect(door.kind).toBe('closed');
    expect(door.a[0]).toBeCloseTo(8); // along the wall at x = 8
    const added = changes.doors.find((item) => item.id === 'N1')!;
    expect(added.kind).toBe('new');
    expect(added.a[1]).toBeCloseTo(5); // along the wall at y = 5
    expect(changes.labels[0].text).toBe('Office lift closed');
    expect(changes.moved[0].label).toBe('Coffee machine');
    expect(changesOn(detail, { ...map, changes: undefined }, 'F0').doors).toEqual([]);
    expect(changesOn(detail, map, 'F1').doors).toEqual([]);
  });

  it('draws them in 2D and 3D', async () => {
    for (const view of [
      <FloorPlan key="2d" detail={detail} floorId="F0" map={map} width={390} height={500} />,
      <FloorScene key="3d" detail={detail} floorId="F0" map={map} footprints={[[[0, 0], [24, 0], [24, 5], [0, 5]]]}
                  width={390} height={500} />,
    ]) {
      await render(view);
      expect(screen.getAllByTestId('closed-space').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByTestId('closed-door')).toBeTruthy();
      expect(screen.getByTestId('new-door')).toBeTruthy();
      expect(screen.getByTestId('closed-label')).toBeTruthy();
      expect(screen.getByTestId('moved-thing')).toBeTruthy();
    }
  });
});

describe('session recovery', () => {
  const reply = { reply: 'Hi', question: null, map: null };

  it('starts a new conversation on a lost session, tells it where you are and asks again', async () => {
    const client = {
      chat: jest.fn().mockRejectedValueOnce(new ApiError('Unknown or expired session', 404)).mockResolvedValue(reply),
      startSession: jest.fn().mockResolvedValue({ session_id: 'new', building_name: 'B' }),
      setPositionAt: jest.fn().mockResolvedValue({}),
    };
    const here = { label: 'Lab', floor_id: 'F0', position: [1, 2] as [number, number], space_id: 'A' };
    const turn = await chatTurn({ sessionId: 'old', buildingId: 'b', text: 'hi', here }, client);
    expect(turn).toEqual({ reply, sessionId: 'new', renewed: true });
    expect(client.setPositionAt).toHaveBeenCalledWith('new', 'F0', [1, 2]);
    expect(client.chat).toHaveBeenLastCalledWith('new', 'hi', undefined, undefined);
  });

  it('passes other errors on and keeps a working session', async () => {
    const failing = { chat: jest.fn().mockRejectedValue(new ApiError('boom', 500)), startSession: jest.fn(),
                      setPositionAt: jest.fn() };
    await expect(chatTurn({ sessionId: 's', buildingId: 'b', text: 'hi' }, failing)).rejects.toMatchObject({ status: 500 });
    expect(failing.startSession).not.toHaveBeenCalled();
    const fine = { chat: jest.fn().mockResolvedValue(reply), startSession: jest.fn(), setPositionAt: jest.fn() };
    expect((await chatTurn({ sessionId: 's', buildingId: 'b', text: 'hi' }, fine)).renewed).toBe(false);
  });

  it('keeps the messages when renewed and shows a note until the next message', () => {
    let state = reduce(initial, { type: 'send', text: 'hi' });
    state = reduce(state, { type: 'renewed', sessionId: 'new', note: 'Started a new conversation.' });
    state = reduce(state, { type: 'reply', reply });
    expect(state.messages.map((message) => message.text)).toEqual(['hi', 'Hi']);
    expect(state.sessionId).toBe('new');
    expect(state.note).toBe('Started a new conversation.');
    expect(reduce(state, { type: 'send', text: 'again' }).note).toBeNull();
    expect(reduce(state, { type: 'switch' })).toEqual(initial);
  });
});
