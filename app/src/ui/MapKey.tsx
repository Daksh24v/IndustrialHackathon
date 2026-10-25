/** The map key, in the map's button column: a button that opens a card beside the column saying what the colours
 * mean (rooms by what they're for, the round signs, the floor patterns, orange and red), only for what this
 * building has. */
import { useLayoutEffect, useRef, useState } from 'react';

import type { MapKey as Key } from '../legend';
import { KeyIcon } from './icons';

const GAP_PX = 10; // between the column and the card
const EDGE_PX = 16; // the card stays this far inside the screen

export function MapKey({ legend }: { legend: Key | null }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  // Beside the button, its top level with the button's, moved up when it would run off the bottom.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const box = button.current.getBoundingClientRect();
    const height = card.current?.offsetHeight ?? 0;
    setAt({ top: Math.max(EDGE_PX, Math.min(box.top, window.innerHeight - height - EDGE_PX)),
            right: window.innerWidth - box.left + GAP_PX });
  }, [open]);
  if (!legend) return null;
  return (
    <div className="fi-group" data-testid="map-key">
      <button ref={button} type="button" aria-expanded={open} aria-label={open ? 'Close the map key' : 'Map key: what the colours mean'}
              title="Map key" data-on={open ? '' : undefined} data-testid="map-key-button" onClick={() => setOpen((now) => !now)}>
        <KeyIcon />
      </button>
      {open && (
        <div ref={card} className="fi fi-key-card" role="dialog" aria-label="Map key"
             style={at ? { top: at.top, right: at.right } : { visibility: 'hidden' }}>
          <h4>Rooms, by what they're for</h4>
          {legend.rooms.map((line) => (
            <p key={line.id}><i className="sw" style={{ background: line.fill, borderColor: line.edge }} />{line.label}</p>
          ))}
          {legend.signs.length > 0 && <h4>Signs by the names</h4>}
          {legend.signs.map((line) => (
            <p key={line.id}><i className="dot" style={{ background: line.fill }} />{line.label}</p>
          ))}
          {legend.floors.length > 0 && <h4>Floors, close up</h4>}
          {legend.floors.map((label) => <p key={label} className="plain">{label}</p>)}
          <h4>On the map</h4>
          {legend.marks.map((line) => (
            <p key={line.id}><i className="bar" style={{ background: line.fill }} />{line.label}</p>
          ))}
        </div>
      )}
    </div>
  );
}
