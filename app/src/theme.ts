/** Minimal white map with one accent colour: orange is "you" and "your way". */
export const colours = {
  background: '#FFFFFF',
  block: '#F4F4F4',
  blockTop: '#FFFFFF',
  blockEdge: '#D8D8D8',
  room: '#FAFAFA',
  corridor: '#F1F1F1',
  hall: '#F6F6F6',
  shaft: '#ECECEC',
  outdoor: '#F3F7F1',
  wall: '#CFCFCF',
  label: '#9A9A9A',
  text: '#1F1F1F',
  muted: '#8A8A8A',
  chip: '#F3F3F3',
  chipText: '#2A2A2A',
  accent: '#FF7A00',
  accentSoft: 'rgba(255, 122, 0, 0.35)',
  accentFaint: 'rgba(255, 122, 0, 0.12)',
  error: '#C62828',
  closed: '#E53935', // building edits: closed doors, lifts and rooms
  closedFaint: 'rgba(229, 57, 53, 0.16)',
  added: '#2E9E44', // new doors
  moved: '#2F6FED', // things moved to a new place
} as const;

/** The map canvas: a dark "digital twin". Rooms are tinted by what they're for, with a brighter edge; orange
 * stays for you and your way, red for closed, green and blue for new and moved things. */
export const map = {
  background: '#0B1016',
  slabTop: '#111922',
  slabSide: '#0A0E13',
  slabEdge: '#24303E',
  wallDark: [24, 33, 45], // rgb of a wall facing away from the light
  wallLit: [46, 62, 82], // and one facing it
  wallTop: 'rgba(132, 186, 255, 0.55)',
  wall2d: '#2B3A4C', // walls seen from above
  label: '#8EA2B8',
  shadow: 'rgba(0, 0, 0, 0.45)',
  chrome: 'rgba(17, 25, 34, 0.88)', // buttons and pills floating over the map
  chromeEdge: '#2A3746',
  chromeText: '#D6E1EC',
  chromeMuted: '#7D8FA3',
  block: '#1F2C3B',
  blockDark: '#17212D',
  blockTop: '#283749',
  blockEdge: 'rgba(79, 195, 247, 0.8)',
  window: 'rgba(150, 215, 255, 0.6)',
  closedFaint: 'rgba(229, 57, 53, 0.28)',
  // the OpenStreetMap neighbourhood: dimmer than the building, so it stays the subject
  near: '#161E29', // neighbouring buildings' walls
  nearDark: '#111821',
  nearTop: '#1B2531',
  nearEdge: 'rgba(120, 150, 190, 0.35)',
  road: '#1D2632',
  roadEdge: 'rgba(110, 140, 175, 0.35)',
  rail: '#262B36',
  green: '#0F2018',
  water: '#0D1D2D',
} as const;

export interface RoomStyle {
  fill: string;
  edge: string;
}

const room = (fill: string, edge: string): RoomStyle => ({ fill, edge });
const WORK = room('#13243C', '#4C8DFF');
const LAB = room('#0D2D33', '#2FD4D9');
const PRODUCTION = room('#211A3B', '#9A7CFF');
const LOGISTICS = room('#13291D', '#3FCB7A');
const AMENITY = room('#271731', '#D27BE8'); // orchid, so it never reads as closed (red)
const HOME = room('#29231A', '#CDAE72');
const CORRIDOR = room('#151C26', '#34465B');
const LOBBY = room('#19212E', '#5A6E88');
const SHAFT = room('#1D2839', '#8FB3FF');
const OUTDOOR = room('#0F2219', '#2E7D5B');
const GENERIC = room('#182029', '#475466');

const byRoomType: Record<string, RoomStyle> = {
  office: WORK, meeting_room: WORK, seminar_room: WORK, lecture_hall: WORK, library: WORK, print_room: WORK,
  lab: LAB, quality_lab: LAB, makerspace: LAB, server_room: LAB, technical_room: LAB,
  production_zone: PRODUCTION, assembly_zone: PRODUCTION, additive_zone: PRODUCTION,
  warehouse_zone: LOGISTICS, logistics_zone: LOGISTICS, storage: LOGISTICS,
  kitchen: AMENITY, canteen: AMENITY, toilet: AMENITY, bathroom: AMENITY, locker_room: AMENITY, shop: AMENITY,
  bedroom: HOME, living_room: HOME,
  corridor: CORRIDOR, lobby: LOBBY, stairwell: SHAFT, lift: SHAFT, balcony: OUTDOOR,
};
const byType: Record<string, RoomStyle> = {
  corridor: CORRIDOR, hall: LOBBY, stair: SHAFT, lift: SHAFT, outdoor: OUTDOOR,
};

/** How a space is drawn: by its room type (lab, office, …), else by its kind (corridor, stair, …). */
export function roomStyle(space: { type: string; room_type?: string }): RoomStyle {
  return byRoomType[space.room_type ?? ''] ?? byType[space.type] ?? GENERIC;
}

export interface AssetStyle {
  top: string;
  edge: string;
  height_m: number; // 0 = drawn flat on the floor
}

/** Things in the rooms: machines stand tall and bright, furniture lies flat and dim. */
export function assetStyle(category: string): AssetStyle {
  switch (category) {
    case 'machine': return { top: '#A9BED6', edge: '#DCE9F8', height_m: 1.6 };
    case 'equipment': return { top: '#6F9CCB', edge: '#A9CBEE', height_m: 1.0 };
    case 'fixture': return { top: '#56667A', edge: '#7C8DA1', height_m: 0.4 };
    default: return { top: '#2A3544', edge: '#3D4B5D', height_m: 0 };
  }
}

/** A colour darker (factor < 1) or lighter (> 1), for the sides of boxes. */
export function shade(hex: string, factor: number): string {
  const v = parseInt(hex.slice(1), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.max(0, Math.min(255, Math.round(x * factor))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Screens at least this wide get the chat as a panel beside the map (desktop); narrower ones the phone layout. */
export const WIDE_PX = 900;
export const isWide = (width: number) => width >= WIDE_PX;
