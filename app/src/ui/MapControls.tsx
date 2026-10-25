/** The map's buttons, bottom right like a map app: "I'm here", the floors as a small stack (the open one orange;
 * hover for its name, click to go there, the top button for the whole building), the view (3D, bird's eye
 * straight from above, or the flat plan), the compass (north up) and zoom. The compass follows the view through the map's handle, not through a re-render of the screen. */
import { type RefObject, useEffect, useState } from 'react';

import type { Floor } from '../api';
import { Building, Locate } from './icons';

/** What the open floor view lets the buttons do. */
export interface MapHandle {
  zoomBy: (k: number) => void;
  north: () => void;
  /** Calls back with the view's turn (radians) now and whenever it changes; returns the unsubscribe. */
  watchYaw?: (callback: (yaw: number) => void) => () => void;
}

/** 3D leans in like walking into the picture; top is a bird's eye view straight down (it still turns); plan is the
 * flat 2D drawing, north up. */
export type ViewMode = '3d' | 'top' | 'plan';
const VIEWS: { mode: ViewMode; label: string; name: string; testID: string }[] = [
  { mode: '3d', label: '3D', name: '3D view', testID: 'view-3D' },
  { mode: 'top', label: 'Top', name: "Bird's eye view", testID: 'view-top' },
  { mode: 'plan', label: '2D', name: 'Flat plan (2D)', testID: 'view-2D' },
];

interface Props {
  inside: boolean;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  handle: RefObject<MapHandle | null>;
  floors: Floor[]; // lowest first
  floorId: string | null;
  onFloor: (floorId: string) => void;
  onBuilding: () => void;
  onHere: () => void;
  bottom: number;
}

export function MapControls({ inside, view, onView, handle, floors, floorId, onFloor, onBuilding, onHere, bottom }: Props) {
  const [yaw, setYaw] = useState(0);
  const [tip, setTip] = useState<{ name: string; y: number } | null>(null);
  const turns = view !== 'plan';
  useEffect(() => {
    if (!inside || !turns) return setYaw(0);
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => { stop = handle.current?.watchYaw?.(setYaw); }); // after the scene mounted
    return () => {
      window.clearTimeout(timer);
      stop?.();
    };
  }, [inside, turns, view, floorId, handle]);

  const top = [...floors].reverse();
  return (
    <div className="fi fi-controls" style={{ bottom }} data-testid="map-controls">
      <div className="fi-group">
        <button type="button" aria-label="I'm here: tap the floor where you are" title="I'm here" data-testid="here-button" onClick={onHere}>
          <Locate />
        </button>
      </div>
      {floors.length > 0 && (
        <div className="fi-group fi-stack" data-testid="floor-stack" onMouseLeave={() => setTip(null)}>
          <button type="button" className="whole" aria-label="The whole building" title="The whole building" data-testid="building"
                  aria-pressed={!inside} onClick={onBuilding}>
            <Building />
          </button>
          {top.map((floor, i) => {
            const on = inside && floor.id === floorId;
            return (
              <button key={floor.id} type="button" className="slab" aria-label={floor.name} aria-pressed={on}
                      data-testid={`stack-${floor.level}`} onClick={() => onFloor(floor.id)}
                      onMouseEnter={() => setTip({ name: floor.name, y: 32 + i * 14 })} onFocus={() => setTip({ name: floor.name, y: 32 + i * 14 })}
                      onBlur={() => setTip(null)}>
                <svg width="36" height="14" viewBox="0 0 36 14" aria-hidden="true">
                  <path d="M8 2 H34 L28 12 H2 Z" fill={on ? '#FF7A00' : '#ECECF0'} stroke={on ? '#C25700' : '#C9C9D0'} strokeWidth="1" />
                </svg>
              </button>
            );
          })}
          {tip && <span className="fi-tip" style={{ top: tip.y - 4 }}>{tip.name}</span>}
        </div>
      )}
      {inside && (
        <div className="fi-group" role="radiogroup" aria-label="View">
          {VIEWS.map((option) => (
            <button key={option.mode} type="button" className="txt" role="radio" aria-checked={view === option.mode}
                    aria-label={option.name} title={option.name} data-testid={option.testID}
                    data-on={view === option.mode ? '' : undefined} onClick={() => onView(option.mode)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {inside && turns && (
        <div className="fi-group">
          <button type="button" aria-label="North up" title="North up" data-testid="compass" onClick={() => handle.current?.north()}>
            <svg width="22" height="22" viewBox="-11 -11 22 22" style={{ transform: `rotate(${(-yaw * 180) / Math.PI}deg)` }} aria-hidden="true">
              <path d="M0 -9 L4 0 L-4 0 Z" fill="#FF7A00" />
              <path d="M0 9 L4 0 L-4 0 Z" fill="#C9C9D0" />
            </svg>
          </button>
        </div>
      )}
      {inside && (
        <div className="fi-group">
          <button type="button" aria-label="Zoom in" data-testid="zoom-in" onClick={() => handle.current?.zoomBy(1.5)}>+</button>
          <button type="button" aria-label="Zoom out" data-testid="zoom-out" onClick={() => handle.current?.zoomBy(1 / 1.5)}>−</button>
        </div>
      )}
    </div>
  );
}
