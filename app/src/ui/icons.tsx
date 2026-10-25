/** Line icons for the FINNI controls and the directions (24 × 24, drawn in currentColor). */
import type { StepKind } from '../steps';

const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Walls: a corner of a room, tall on one side and cut low on the other. */
export const Walls = ({ mode }: { mode: 'cutaway' | 'low' | 'full' }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 19 L12 22 L21 19" {...line} />
    <path d={mode === 'full' ? 'M3 19 V7 L12 4 L21 7 V19' : mode === 'low' ? 'M3 19 V16 M21 19 V16' : 'M3 19 V7 L12 4 V10 M21 19 V15'} {...line} />
  </svg>
);

export const Mic = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" {...line} />
  </svg>
);
/** The microphone struck through: muted. */
export const MicOff = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7M3.5 3.5l17 17" {...line} />
  </svg>
);
export const Send = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" {...line} /></svg>
);
export const Locate = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="6" {...line} /><circle cx="12" cy="12" r="2" fill="currentColor" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" {...line} />
  </svg>
);
export const Building = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
    <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" {...line} />
  </svg>
);

/** The map key: three swatches with a line of text beside each. */
export const KeyIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
    <rect x="3" y="4" width="5" height="4" rx="1" fill="currentColor" /><rect x="3" y="10" width="5" height="4" rx="1" fill="currentColor" />
    <rect x="3" y="16" width="5" height="4" rx="1" fill="currentColor" />
    <path d="M11 6h10M11 12h10M11 18h7" {...line} />
  </svg>
);

/** The direction arrow for a step: which way to turn, stairs, lift or the flag at the end. */
export function StepIcon({ kind, action }: { kind: StepKind; action: string }) {
  if (kind === 'arrive') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4h11l-2 4 2 4H6" {...line} /></svg>;
  if (kind === 'stairs') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h5v-5h5v-5h5V5h3" {...line} /></svg>;
  if (kind === 'lift') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" {...line} /><path d="m9 9 3-3 3 3M9 15l3 3 3-3" {...line} /></svg>;
  }
  if (action.startsWith('Turn left')) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 20v-8a3 3 0 0 0-3-3H5M9 5 5 9l4 4" {...line} /></svg>;
  if (action.startsWith('Turn right')) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20v-8a3 3 0 0 1 3-3h8M15 5l4 4-4 4" {...line} /></svg>;
  if (action.startsWith('Turn around')) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20V9a4 4 0 0 1 8 0v6M12 12l4 4 4-4" {...line} /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4M6 10l6-6 6 6" {...line} /></svg>;
}
