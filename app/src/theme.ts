/** Dark map, one accent colour: orange is "you" and "your way". Same look as the orb screen (src/orb/orb.css). */
export const colours = {
  background: '#000000',
  surface: '#1C1C1E',
  surfaceRaised: '#2C2C2E',
  line: 'rgba(255, 255, 255, 0.10)',
  block: '#1C1C1E', // the building from outside: walls facing left
  blockSide: '#141416', // walls facing right
  blockTop: '#2A2A2E',
  blockEdge: '#3A3A3E',
  blockShadow: '#0D0D0F',
  room: '#18181B',
  corridor: '#232327',
  hall: '#1D1D20',
  shaft: '#2C2C31',
  outdoor: '#142019',
  wall: '#3F3F45',
  wallFace: [42, 70] as const, // grey levels of 3D walls: away from the light .. lit
  slab: '#121214',
  slabSide: '#0E0E10',
  label: '#8E8E93',
  text: '#F2F2F7',
  muted: '#8E8E93',
  chip: '#1C1C1E',
  chipText: '#E5E5EA',
  accent: '#FF7A00',
  accentSoft: 'rgba(255, 122, 0, 0.35)',
  accentFaint: 'rgba(255, 122, 0, 0.16)',
  accentChip: 'rgba(255, 122, 0, 0.12)',
  error: '#FF6B6B',
} as const;

export const spaceFill: Record<string, string> = {
  room: colours.room,
  corridor: colours.corridor,
  hall: colours.hall,
  stair: colours.shaft,
  lift: colours.shaft,
  outdoor: colours.outdoor,
};
