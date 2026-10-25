/** The map's buttons, bottom right like a map app: "I'm here", the floors as a small stack (the open one orange;
 * hover for its name, click to go there, the top button for the whole building), the view (3D, bird's eye
 * straight from above, or the flat plan), the compass (north up) and zoom. The compass follows the view through the map's handle, not through a re-render of the screen. */
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react';

import type { Floor } from '../api';
import type { ThemeName } from '../theme';
import type { WallMode } from '../walls';
import { useDock } from './dock';
import { Building, Locate, Walls } from './icons';
import { MapKey } from './MapKey';
import type { MapKey as Legend } from '../legend';
import { ThemeToggle } from './ThemeToggle';

/** What the open floor view lets the buttons do. */
export interface MapHandle {
  zoomBy: (k: number) => void;
  north: () => void;
  /** Calls back with the view's turn (radians) now and whenever it changes; returns the unsubscribe. */
  watchYaw?: (callback: (yaw: number) => void) => () => void;
  /** Turn by this much (animated), e.g. 45° left or right. */
  turnBy?: (angle: number) => void;
  /** Start turning by hand: the returned function turns the view this far from where it was. */
  beginTurn?: () => (angle: number) => void;
}

const STEP = Math.PI / 4; // one press of a turn button
const DRAG_TURN = 0.012; // radians per pixel dragged on the compass (about 520 px for all the way round)
const CLICK_PX = 4;

/** The compass: points north as the view turns; click it for north up, drag it sideways to turn all the way round. */
function Compass({ yaw, handle }: { yaw: number; handle: RefObject<MapHandle | null> }) {
  const drag = useRef<{ x: number; turn?: (angle: number) => void; moved: boolean } | null>(null);
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    drag.current = { x: event.clientX, turn: handle.current?.beginTurn?.(), moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const now = drag.current;
    if (!now) return;
    const dx = event.clientX - now.x;
    if (Math.abs(dx) > CLICK_PX) now.moved = true;
    if (now.moved) now.turn?.(dx * DRAG_TURN);
  };
  const up = () => {
    const was = drag.current;
    drag.current = null;
    if (was && !was.moved) handle.current?.north();
  };
  return (
    <button type="button" aria-label="North up (drag to turn)" title="Click: north up · drag: turn" data-testid="compass"
            style={{ cursor: 'ew-resize', touchAction: 'none' }} onPointerDown={down} onPointerMove={move} onPointerUp={up}
            onPointerCancel={() => (drag.current = null)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') handle.current?.turnBy?.(-STEP);
              if (event.key === 'ArrowRight') handle.current?.turnBy?.(STEP);
              if (event.key === 'Enter' || event.key === ' ') handle.current?.north();
            }}>
      <svg width="24" height="24" viewBox="-12 -12 24 24" style={{ transform: `rotate(${(-yaw * 180) / Math.PI}deg)` }} aria-hidden="true">
        <circle r="11" fill="none" stroke="#E2E2E8" strokeWidth="1.2" />
        <path d="M0 -9 L4 0 L-4 0 Z" fill="#FF7A00" />
        <path d="M0 9 L4 0 L-4 0 Z" fill="#C9C9D0" />
      </svg>
    </button>
  );
}

function Shield() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3z" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 8v5M12 16v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function TurnArrow({ flip = false }: { flip?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
  /** Changes whenever another map view is shown (loaded, a floor, the building): the compass follows the new one. */
  mapKey: string;
  theme: ThemeName;
  onTheme: () => void;
  /** A phone inside a floor: fewer buttons (two fingers turn and zoom), the views side by side, so they all fit. */
  compact?: boolean;
  /** Safety mode (shield): on or off, and whether this building has anything to show for it. */
  safety: boolean;
  onSafety?: () => void;
  /** How the floor's walls stand (3D and top views): cut away to see in, all low, or all full height. */
  walls?: WallMode;
  onWalls?: () => void;
  /** What the colours mean, for the map key button. */
  legend?: Legend | null;
}

const WALL_NAMES: Record<WallMode, string> = { cutaway: 'Walls: cut away', low: 'Walls: low', full: 'Walls: full height' };

export function MapControls({ inside, view, onView, handle, floors, floorId, onFloor, onBuilding, onHere, bottom, mapKey, theme, onTheme, compact = false, safety, onSafety, walls = 'cutaway', onWalls, legend = null }: Props) {
  const [yaw, setYaw] = useState(0);
  const [tip, setTip] = useState<{ name: string; y: number } | null>(null);
  const turns = !inside || view !== 'plan'; // the building and the 3D / top views turn; the flat plan stays north up
  useEffect(() => {
    if (!turns) return setYaw(0);
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => { stop = handle.current?.watchYaw?.(setYaw); }); // after the scene mounted
    return () => {
      window.clearTimeout(timer);
      stop?.();
    };
  }, [turns, mapKey, handle]);

  const top = [...floors].reverse();
  const column = useRef<HTMLDivElement>(null);
  useDock(column); // the buttons near the mouse swell, like a dock
  return (
    <div className="fi fi-controls" style={{ bottom }} data-testid="map-controls" ref={column}>
      {!(compact && inside) && <ThemeToggle theme={theme} onToggle={onTheme} />}
      {onSafety && (
        <div className="fi-group">
          <button type="button" className="fi-safety" data-on={safety ? '' : undefined} data-testid="safety-toggle"
                  aria-pressed={safety} aria-label={safety ? 'Leave safety mode' : 'Safety: exits, extinguishers, first aid'}
                  title={safety ? 'Leave safety mode' : 'Safety mode'} onClick={onSafety}>
            <Shield />
          </button>
        </div>
      )}
      <MapKey legend={legend} />
      <div className="fi-group">
        <button type="button" aria-label="I'm here: tap the floor where you are" title="I'm here" data-testid="here-button" onClick={onHere}>
          <Locate />
        </button>
      </div>
      {floors.length > 0 && (
        <div className="fi-group fi-stack" data-testid="floor-stack" onMouseLeave={() => setTip(null)}>
          <button type="button" className="whole" aria-label="The whole building" title="The whole building" data-testid="stack-building"
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
        <div className={compact ? 'fi-group fi-row' : 'fi-group'} role="radiogroup" aria-label="View">
          {VIEWS.map((option) => (
            <button key={option.mode} type="button" className="txt" role="radio" aria-checked={view === option.mode}
                    aria-label={option.name} title={option.name} data-testid={option.testID}
                    data-on={view === option.mode ? '' : undefined} onClick={() => onView(option.mode)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {inside && view !== 'plan' && onWalls && (
        <div className="fi-group">
          <button type="button" aria-label={`${WALL_NAMES[walls]} (click to change)`} title={WALL_NAMES[walls]} data-testid="walls-toggle"
                  onClick={onWalls}>
            <Walls mode={walls} />
          </button>
        </div>
      )}
      {turns && (
        <div className="fi-group" aria-label="Turn the map">
          {!compact && (
            <button type="button" aria-label="Turn left" title="Turn left" data-testid="turn-left" onClick={() => handle.current?.turnBy?.(-STEP)}>
              <TurnArrow flip />
            </button>
          )}
          <Compass yaw={yaw} handle={handle} />
          {!compact && (
            <button type="button" aria-label="Turn right" title="Turn right" data-testid="turn-right" onClick={() => handle.current?.turnBy?.(STEP)}>
              <TurnArrow />
            </button>
          )}
        </div>
      )}
      {inside && !compact && (
        <div className="fi-group">
          <button type="button" aria-label="Zoom in" data-testid="zoom-in" onClick={() => handle.current?.zoomBy(1.5)}>+</button>
          <button type="button" aria-label="Zoom out" data-testid="zoom-out" onClick={() => handle.current?.zoomBy(1 / 1.5)}>−</button>
        </div>
      )}
    </div>
  );
}
