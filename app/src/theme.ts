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

export type ThemeName = 'dark' | 'light';
/** Which look the site opens with (main: the dark digital twin; the UI/UX-Design branch: light). The button on
 * the map switches, and the choice is remembered; ?theme=light / ?theme=dark in the address picks one too. */
export const DEFAULT_THEME: ThemeName = 'dark';

/** The map canvas: a dark "digital twin". Rooms are tinted by what they're for, with a brighter edge; orange
 * stays for you and your way, red for closed, green and blue for new and moved things. */
const DARK = {
  background: '#0B1016',
  slabTop: '#111922',
  slabSide: '#0A0E13',
  slabEdge: '#24303E',
  wallDark: [24, 33, 45] as [number, number, number], // rgb of a wall facing away from the light
  wallLit: [46, 62, 82] as [number, number, number], // and one facing it
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
  hoverTop: '#34465C', // a floor of the building under the cursor
  hoverWall: '#2B3A4C',
  window: 'rgba(150, 215, 255, 0.6)',
  closedFaint: 'rgba(229, 57, 53, 0.28)',
  // the OpenStreetMap neighbourhood: dimmer than the building, so it stays the subject
  near: '#161E29', // neighbouring buildings' walls
  nearDark: '#111821',
  nearTop: '#2A3444',
  nearEdge: 'rgba(120, 150, 190, 0.35)',
  road: '#1D2632',
  roadEdge: 'rgba(110, 140, 175, 0.35)',
  rail: '#262B36',
  green: '#16402A',
  water: '#123454',
  waterEdge: '#1E4466',
  tree: '#1F5C38',
  treeEdge: '#2E7D4F',
};
export type MapPalette = typeof DARK;

/** The light map: white floors, soft grey walls, the same tints as pastels, the neighbourhood like a paper map. */
const LIGHT: MapPalette = {
  background: '#F4F5F2',
  slabTop: '#FFFFFF',
  slabSide: '#E3E6EA',
  slabEdge: '#C9CED6',
  wallDark: [206, 211, 218],
  wallLit: [234, 237, 241],
  wallTop: 'rgba(120, 132, 150, 0.6)',
  wall2d: '#BCC4CE',
  label: '#6E7A89',
  shadow: 'rgba(0, 0, 0, 0.12)',
  chrome: 'rgba(255, 255, 255, 0.94)',
  chromeEdge: '#D8DCE2',
  chromeText: '#1F2933',
  chromeMuted: '#7A8594',
  block: '#EEF0F3',
  blockDark: '#E1E4E9',
  blockTop: '#FFFFFF',
  blockEdge: 'rgba(120, 135, 155, 0.75)',
  hoverTop: '#E4E4E8',
  hoverWall: '#D6D6DB',
  window: 'rgba(110, 160, 215, 0.5)',
  closedFaint: 'rgba(229, 57, 53, 0.16)',
  near: '#E2E5E9',
  nearDark: '#D7DBE0',
  nearTop: '#ECEEF1',
  nearEdge: 'rgba(150, 160, 175, 0.55)',
  road: '#FFFFFF',
  roadEdge: 'rgba(170, 178, 190, 0.8)',
  rail: '#D9DCE1',
  green: '#DCEFD6',
  water: '#CDE2F4',
  waterEdge: '#A9C9E6',
  tree: '#B7DCAD',
  treeEdge: '#8DC27F',
};

/** The colours in use now: the components read these when they draw. */
export const map: MapPalette = { ...DARK };
let current: ThemeName = 'dark';
export const themeName = () => current;

/** Switch the map's colours (the screen then redraws the map). */
export function setTheme(name: ThemeName): void {
  current = name;
  Object.assign(map, name === 'dark' ? DARK : LIGHT);
}

/** The look to open with: the address (?theme=), else the last choice on this device, else DEFAULT_THEME. */
export function startTheme(search: string, saved: string | null): ThemeName {
  const asked = /[?&]theme=(dark|light)\b/.exec(search)?.[1];
  if (asked === 'dark' || asked === 'light') return asked;
  return saved === 'dark' || saved === 'light' ? saved : DEFAULT_THEME;
}

/** The neighbourhood's land, by its use: dim, so the building stays the subject, but each kind its own hue. */
const AREA_FILL: Record<ThemeName, Record<string, string>> = {
  dark: {
    industrial: '#2E2752', commercial: '#1C3358', retail: '#40264A', residential: '#33302A', parking: '#2A303A',
    grass: '#17402A', park: '#1A4A2C', forest: '#11401F', farmland: '#3A3E1A', meadow: '#1F4428', sports: '#164640',
    construction: '#45391F', brownfield: '#3D3324', cemetery: '#203A2E', allotments: '#26422A', railway: '#272A33',
  },
  light: {
    industrial: '#ECE8F6', commercial: '#E4ECF7', retail: '#F5E7F0', residential: '#F1EDE6', parking: '#ECEEF1',
    grass: '#DCF0D6', park: '#D2EBCB', forest: '#C6E2BE', farmland: '#EEF0D6', meadow: '#DBEED4', sports: '#D4EEE7',
    construction: '#F1E9D9', brownfield: '#ECE5DA', cemetery: '#DAEAE0', allotments: '#DCEED6', railway: '#E5E7EB',
  },
};
export const areaFill = (kind: string) => AREA_FILL[current][kind] ?? map.green;

/** Next door's buildings, by what they are: a top and the two wall shades. */
const NEAR_TOP: Record<ThemeName, Record<string, string>> = {
  dark: {
    industrial: '#3C3366', commercial: '#264066', office: '#264066', retail: '#552E5C', residential: '#4A4232',
    public: '#21504A', religious: '#433D58', parking: '#343A46',
  },
  light: {
    industrial: '#E1DCF0', commercial: '#DAE5F2', office: '#DAE5F2', retail: '#EFDDE9', residential: '#E9E3D8',
    public: '#D6EAE4', religious: '#E2DEEA', parking: '#E1E4E9',
  },
};
export function nearStyle(kind?: string): { top: string; wall: string; wallDark: string } {
  const top = NEAR_TOP[current][kind ?? ''] ?? map.nearTop;
  const [lit, dim] = current === 'dark' ? [0.8, 0.62] : [0.86, 0.74];
  return { top, wall: shade(top, lit), wallDark: shade(top, dim) };
}

/** Roads by class: big roads warmer and wider-looking, paths thin and dim, rail dashed. */
export function roadStyle(kind: string): { fill: string; edge: string; dashed?: boolean } {
  const light = current === 'light';
  switch (kind) {
    case 'motorway': case 'trunk': case 'motorway_link': case 'trunk_link':
      return light ? { fill: '#FCE3AC', edge: 'rgba(210, 160, 70, 0.8)' } : { fill: '#4A3B22', edge: 'rgba(230, 180, 90, 0.5)' };
    case 'primary': case 'primary_link': case 'secondary': case 'secondary_link':
      return light ? { fill: '#FFF1CF', edge: 'rgba(210, 180, 115, 0.75)' } : { fill: '#3A3426', edge: 'rgba(215, 190, 130, 0.4)' };
    case 'tertiary': case 'residential': case 'unclassified': case 'living_street':
      return light ? { fill: '#FFFFFF', edge: 'rgba(165, 174, 188, 0.85)' } : { fill: '#252E3B', edge: 'rgba(130, 160, 195, 0.4)' };
    case 'footway': case 'path': case 'cycleway': case 'pedestrian': case 'steps': case 'track': case 'bridleway':
      return light ? { fill: '#F7F7F8', edge: 'rgba(180, 186, 196, 0.6)' } : { fill: '#1F2833', edge: 'rgba(120, 150, 180, 0.25)' };
    case 'rail': case 'tram': case 'light_rail': case 'subway': case 'narrow_gauge':
      return { fill: map.rail, edge: light ? 'rgba(110, 118, 130, 0.7)' : 'rgba(170, 180, 200, 0.55)', dashed: true };
    default: return { fill: map.road, edge: map.roadEdge };
  }
}

export interface RoomStyle {
  fill: string;
  edge: string;
}

const room = (fill: string, edge: string): RoomStyle => ({ fill, edge });
/** Rooms by what they're for, in each look: [dark, light]. */
const KINDS = {
  work: [room('#13243C', '#4C8DFF'), room('#EAF1FF', '#8DB3F5')],
  lab: [room('#0D2D33', '#2FD4D9'), room('#E2F6F7', '#5CC7CB')],
  production: [room('#211A3B', '#9A7CFF'), room('#EFEAFE', '#A995F0')],
  logistics: [room('#13291D', '#3FCB7A'), room('#E5F5EB', '#6CC995')],
  amenity: [room('#271731', '#D27BE8'), room('#F8EAFB', '#D49BE3')], // orchid, so it never reads as closed (red)
  home: [room('#29231A', '#CDAE72'), room('#F6F0E3', '#D3B983')],
  corridor: [room('#151C26', '#34465B'), room('#F5F6F8', '#CBD1DA')],
  lobby: [room('#19212E', '#5A6E88'), room('#EEF1F5', '#AEB8C6')],
  shaft: [room('#1D2839', '#8FB3FF'), room('#E8EEF9', '#9FB5DA')],
  outdoor: [room('#0F2219', '#2E7D5B'), room('#EAF5EE', '#8CC4A3')],
  generic: [room('#182029', '#475466'), room('#F3F4F6', '#C3C9D2')],
} as const;
type Kind = keyof typeof KINDS;

const byRoomType: Record<string, Kind> = {
  office: 'work', meeting_room: 'work', seminar_room: 'work', lecture_hall: 'work', library: 'work', print_room: 'work',
  lab: 'lab', quality_lab: 'lab', makerspace: 'lab', server_room: 'lab', technical_room: 'lab',
  production_zone: 'production', assembly_zone: 'production', additive_zone: 'production',
  warehouse_zone: 'logistics', logistics_zone: 'logistics', storage: 'logistics',
  kitchen: 'amenity', canteen: 'amenity', toilet: 'amenity', bathroom: 'amenity', locker_room: 'amenity', shop: 'amenity',
  bedroom: 'home', living_room: 'home',
  corridor: 'corridor', lobby: 'lobby', stairwell: 'shaft', lift: 'shaft', balcony: 'outdoor',
};
const byType: Record<string, Kind> = {
  corridor: 'corridor', hall: 'lobby', stair: 'shaft', lift: 'shaft', outdoor: 'outdoor',
};

/** How a space is drawn: by its room type (lab, office, …), else by its kind (corridor, stair, …). */
export function roomStyle(space: { type: string; room_type?: string }): RoomStyle {
  const kind = byRoomType[space.room_type ?? ''] ?? byType[space.type] ?? 'generic';
  return KINDS[kind][current === 'dark' ? 0 : 1];
}

export interface AssetStyle {
  top: string;
  edge: string;
  height_m: number; // 0 = drawn flat on the floor
}

/** Things in the rooms: machines stand tall and bright (dark) or solid grey (light), furniture lies flat. */
export function assetStyle(category: string): AssetStyle {
  const light = current === 'light';
  switch (category) {
    case 'machine': return light ? { top: '#AEBBCB', edge: '#76879B', height_m: 1.6 } : { top: '#A9BED6', edge: '#DCE9F8', height_m: 1.6 };
    case 'equipment': return light ? { top: '#C5D3E4', edge: '#8AA2BF', height_m: 1.0 } : { top: '#6F9CCB', edge: '#A9CBEE', height_m: 1.0 };
    case 'fixture': return light ? { top: '#DCE2EA', edge: '#A8B3C1', height_m: 0.4 } : { top: '#56667A', edge: '#7C8DA1', height_m: 0.4 };
    default: return light ? { top: '#E7EBF0', edge: '#C6CED8', height_m: 0 } : { top: '#2A3544', edge: '#3D4B5D', height_m: 0 };
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
