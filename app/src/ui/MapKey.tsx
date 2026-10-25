/** "Map key", bottom left of the map: a small button that opens a card saying what the colours mean (rooms by
 * what they're for, the round signs, the floor patterns, orange and red), only for what this building has. */
import { useState } from 'react';

import type { MapKey as Key } from '../legend';

export function MapKey({ legend, left, bottom }: { legend: Key | null; left: number; bottom: number }) {
  const [open, setOpen] = useState(false);
  if (!legend) return null;
  return (
    <div className="fi fi-key" style={{ left, bottom }} data-testid="map-key">
      {open && (
        <div className="fi-key-card" role="dialog" aria-label="Map key">
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
      <button type="button" className="fi-key-btn" aria-expanded={open} onClick={() => setOpen((now) => !now)}
              data-testid="map-key-button">
        {open ? 'Close key' : 'Map key'}
      </button>
    </div>
  );
}
