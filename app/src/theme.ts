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

export const spaceFill: Record<string, string> = {
  room: colours.room,
  corridor: colours.corridor,
  hall: colours.hall,
  stair: colours.shaft,
  lift: colours.shaft,
  outdoor: colours.outdoor,
};

/** Screens at least this wide get the chat as a panel beside the map (desktop); narrower ones the phone layout. */
export const WIDE_PX = 900;
export const isWide = (width: number) => width >= WIDE_PX;
