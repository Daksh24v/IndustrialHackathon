/** Safety mode: the map dims and only what saves you stays bright — exits, fire extinguishers, defibrillators,
 * eyewash stations and the stairs (escape routes; lifts are not for a fire). The quick buttons are only the kinds
 * this building has, so they fit any building, the unseen Sunday one too. First aid kits are not in the data. */
import type { BuildingDetail, Point, SafetyKind } from './api';

export interface SafetyButton {
  kind: SafetyKind;
  label: string;
  question: string; // asked to FINNI when it isn't known where the person is
}

const THINGS: { kind: Exclude<SafetyKind, 'exit'>; label: string; question: string }[] = [
  { kind: 'fire_extinguisher', label: 'Fire extinguisher', question: "Where's the nearest fire extinguisher?" },
  { kind: 'defibrillator', label: 'First aid · AED', question: "Where's the nearest defibrillator?" },
  { kind: 'eyewash_station', label: 'Eyewash', question: "Where's the nearest eyewash station?" },
];

export function safetyButtons(detail: BuildingDetail | null): SafetyButton[] {
  if (!detail) return [];
  const has = new Set(detail.assets.map((asset) => asset.type));
  const buttons: SafetyButton[] = THINGS.filter((thing) => has.has(thing.kind));
  if (detail.openings.some((opening) => opening.kind === 'entrance')) {
    buttons.push({ kind: 'exit', label: 'Nearest exit', question: "What's the quickest way out of the building?" });
  }
  return buttons;
}

export type MarkKind = SafetyKind | 'stairs';

export interface SafetyMark {
  id: string;
  kind: MarkKind;
  at: Point;
  label: string;
}

/** What to light up on one floor in safety mode. */
export function safetyMarks(detail: BuildingDetail, floorId: string): SafetyMark[] {
  const marks: SafetyMark[] = [];
  for (const asset of detail.assets) {
    if (asset.floor_id !== floorId) continue;
    const kind = THINGS.find((thing) => thing.kind === asset.type)?.kind;
    if (kind) marks.push({ id: asset.id, kind, at: asset.position, label: asset.name });
  }
  for (const opening of detail.openings) {
    if (opening.floor_id === floorId && opening.kind === 'entrance') {
      marks.push({ id: opening.id, kind: 'exit', at: opening.position, label: 'Exit' });
    }
  }
  for (const connector of detail.vertical_connectors) {
    if (connector.kind !== 'stairs') continue;
    for (const space of detail.spaces) {
      if (space.floor_id === floorId && connector.space_ids.includes(space.id)) {
        marks.push({ id: `${connector.id}-${space.id}`, kind: 'stairs', at: space.anchor, label: connector.name });
      }
    }
  }
  return marks;
}
