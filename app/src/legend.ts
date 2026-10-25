/** The map key: what the colours, signs and floor patterns on the map mean, for the building that is open (only
 * what it has, so the key stays short and every line in it can be found on the map). */
import type { BuildingDetail } from './api';
import { type SignKind, signOf, SIGN_COLOURS } from './components/FloorScene';
import { finishOf, type FinishKind } from './finishes';
import { kindStyle, ROOM_KEY, roomKind } from './theme';

export interface KeyLine {
  id: string;
  label: string;
  fill: string;
  edge: string;
}

const SIGN_KEY: { kind: SignKind; label: string }[] = [
  { kind: 'wc', label: 'Toilets' },
  { kind: 'kitchen', label: 'Kitchen, canteen' },
  { kind: 'meeting', label: 'Meeting, seminar room' },
  { kind: 'stairs', label: 'Stairs' },
  { kind: 'lift', label: 'Lift' },
  { kind: 'exit', label: 'Room with a way out' },
];

const FINISH_KEY: { kind: FinishKind; label: string }[] = [
  { kind: 'checker', label: 'Checkerboard floor: kitchen, canteen' },
  { kind: 'tiles', label: 'Small tiles: toilets, bathrooms' },
  { kind: 'planks', label: 'Planks: homes, library' },
  { kind: 'panels', label: 'Concrete panels: halls' },
  { kind: 'vinyl', label: 'Vinyl stripes: labs' },
];

export interface MapKey {
  rooms: KeyLine[];
  signs: KeyLine[];
  floors: string[];
  marks: KeyLine[];
}

export function mapKey(detail: BuildingDetail | null): MapKey | null {
  if (!detail) return null;
  const spaces = detail.spaces.filter((space) => space.type !== 'outdoor' || space.room_type);
  const kinds = new Set(spaces.map(roomKind));
  const exits = new Set(detail.openings.filter((opening) => opening.space_ids.includes('outside'))
    .flatMap((opening) => opening.space_ids));
  const signs = new Set(spaces.map((space) => signOf(space, exits)));
  const finishes = new Set(spaces.map((space) => finishOf(space)?.kind));
  return {
    rooms: ROOM_KEY.filter((line) => kinds.has(line.kind)).map((line) => ({ id: line.kind, label: line.label, ...kindStyle(line.kind) })),
    signs: SIGN_KEY.filter((line) => signs.has(line.kind))
      .map((line) => ({ id: line.kind, label: line.label, fill: SIGN_COLOURS[line.kind], edge: SIGN_COLOURS[line.kind] })),
    floors: FINISH_KEY.filter((line) => finishes.has(line.kind)).map((line) => line.label),
    marks: [
      { id: 'route', label: 'You, your route and where you go', fill: '#FF7A00', edge: '#FF7A00' },
      { id: 'closed', label: 'Closed or reported broken', fill: '#E53935', edge: '#E53935' },
    ],
  };
}
