/** The quick searches under the search bar ("Toilets", "Kitchen", "Exit" …), made from what the open building
 * really has, so they fit any building, the unseen Sunday one too. Tapping one asks FINNI the question. */
import type { BuildingDetail, Mobility } from './api';

export interface Category {
  label: string;
  question: string;
}

const MAX = 6;

const RULES: { label: string; question: string; has: (detail: BuildingDetail) => boolean }[] = [
  { label: 'Toilets', question: "Where's the nearest toilet?",
    has: (d) => d.spaces.some((s) => ['toilet', 'bathroom'].includes(s.room_type)) || d.assets.some((a) => a.type === 'toilet') },
  { label: 'Exit', question: "What's the quickest way out of the building?",
    has: (d) => d.openings.some((o) => o.kind === 'entrance') },
  { label: 'Coffee', question: "Where's the nearest coffee machine?", has: (d) => d.assets.some((a) => a.type === 'coffee_machine') },
  { label: 'Kitchen', question: "Where's the nearest kitchen?",
    has: (d) => d.spaces.some((s) => ['kitchen', 'canteen'].includes(s.room_type)) },
  { label: 'Meeting rooms', question: "Where's the nearest meeting room?",
    has: (d) => d.spaces.some((s) => ['meeting_room', 'seminar_room'].includes(s.room_type)) },
  { label: 'Lift', question: "Where's the nearest lift?", has: (d) => d.spaces.some((s) => s.type === 'lift') },
  { label: 'Stairs', question: 'Where are the nearest stairs?', has: (d) => d.spaces.some((s) => s.type === 'stair') },
  { label: 'Fire extinguisher', question: "Where's the nearest fire extinguisher?",
    has: (d) => d.assets.some((a) => a.type === 'fire_extinguisher') },
  { label: 'Printer', question: "Where's the print room?", has: (d) => d.spaces.some((s) => s.room_type === 'print_room') },
];

/** First when the person drives a forklift (the chip): where a forklift goes. */
const FORKLIFT: typeof RULES = [
  { label: 'Loading dock', question: 'Forklift to the loading dock',
    has: (d) => d.spaces.some((s) => s.room_type === 'logistics_zone') },
  { label: 'Forklift charger', question: 'Nearest forklift charger',
    has: (d) => d.assets.some((a) => a.type === 'forklift_charging_station') },
];

export function categories(detail: BuildingDetail | null, mobility: Mobility = 'walk'): Category[] {
  if (!detail) return [];
  const rules = mobility === 'forklift' ? [...FORKLIFT, ...RULES] : RULES;
  return rules.filter((rule) => rule.has(detail)).slice(0, MAX).map(({ label, question }) => ({ label, question }));
}
