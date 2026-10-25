/** What a room's floor is covered with, so you can tell a kitchen from an office before reading its name: a
 * checkerboard in kitchens and canteens, small tiles in toilets and bathrooms, planks in homes, big concrete
 * panels in the halls, vinyl seams in the labs. Offices, meeting rooms and corridors stay plain (carpet). The
 * pattern is laid along the room (its oriented box) in metres, so it sits in perspective like a real floor. */
import type { Point, Space } from './api';
import { orientedBox } from './geometry';

export type FinishKind = 'checker' | 'tiles' | 'planks' | 'panels' | 'vinyl';

export interface Finish {
  kind: FinishKind;
  size: number; // metres between the lines
}

const BY_ROOM: Record<string, Finish> = {
  kitchen: { kind: 'checker', size: 0.5 }, canteen: { kind: 'checker', size: 0.6 },
  toilet: { kind: 'tiles', size: 0.3 }, bathroom: { kind: 'tiles', size: 0.3 }, locker_room: { kind: 'tiles', size: 0.3 },
  bedroom: { kind: 'planks', size: 0.2 }, living_room: { kind: 'planks', size: 0.2 }, library: { kind: 'planks', size: 0.25 },
  production_zone: { kind: 'panels', size: 3 }, assembly_zone: { kind: 'panels', size: 3 }, additive_zone: { kind: 'panels', size: 3 },
  warehouse_zone: { kind: 'panels', size: 4 }, logistics_zone: { kind: 'panels', size: 4 },
  lab: { kind: 'vinyl', size: 1.2 }, quality_lab: { kind: 'vinyl', size: 1.2 }, makerspace: { kind: 'vinyl', size: 1.2 },
};

export function finishOf(space: Pick<Space, 'type' | 'room_type'>): Finish | null {
  return BY_ROOM[space.room_type] ?? null;
}

/** Lines are laid out over the room's box; the drawing clips them to the room. Squares are the dark ones of a
 * checkerboard. At most `limit` of each, so a big hall doesn't cost thousands of lines. */
export function finishPattern(space: Pick<Space, 'polygon'>, finish: Finish, limit = 400): { lines: [Point, Point][]; squares: Point[][] } {
  const box = orientedBox(space.polygon);
  const { centre, u, v } = box;
  const at = (a: number, b: number): Point => [centre[0] + a * u[0] + b * v[0], centre[1] + a * u[1] + b * v[1]];
  const [hl, hw] = [box.length / 2, box.width / 2];
  const lines: [Point, Point][] = [];
  const squares: Point[][] = [];
  const size = Math.max(finish.size, Math.sqrt((box.length * box.width) / limit));
  const across = (step: number) => {
    for (let a = -hl + step; a < hl - 1e-6 && lines.length < limit; a += step) lines.push([at(a, -hw), at(a, hw)]);
  };
  const along = (step: number) => {
    for (let b = -hw + step; b < hw - 1e-6 && lines.length < limit; b += step) lines.push([at(-hl, b), at(hl, b)]);
  };
  if (finish.kind === 'checker') {
    for (let i = 0; -hl + i * size < hl; i += 1) {
      for (let j = 0; -hw + j * size < hw && squares.length < limit; j += 1) {
        if ((i + j) % 2) continue;
        const [a0, b0] = [-hl + i * size, -hw + j * size];
        const [a1, b1] = [Math.min(hl, a0 + size), Math.min(hw, b0 + size)];
        squares.push([at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]);
      }
    }
  } else if (finish.kind === 'planks') {
    along(size); // the boards run the long way
  } else {
    across(size);
    if (finish.kind !== 'vinyl') along(size);
  }
  return { lines, squares };
}
