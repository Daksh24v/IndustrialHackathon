/** The search card at the top: FINNI's orb, "Search or ask FINNI…", the mic; under it the building (a menu of
 * every building) and quick searches made from what this building has. Enter asks, Escape drops a question
 * that is still being answered. */
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';

import type { BuildingRow } from '../api';
import type { Category } from '../categories';
import { groupBuildings } from '../components/BuildingPicker';
import type { SphereMode } from '../orb/sphere';
import type { MicState } from '../useVoice';
import { Mic, Send } from './icons';
import { OrbMark } from './OrbMark';

const LOOKING = ['Searching the building…', 'Finding the way…', 'Checking doors and stairs…'];
const LOOK_MS = 1600;

interface Props {
  busy: boolean;
  mode: SphereMode;
  mic: MicState;
  notice?: string | null;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onMic?: () => void;
  building: { id: string; name: string } | null;
  buildings: BuildingRow[];
  onPickBuilding: (id: string) => void;
  categories: Category[];
}

export function SearchBar(props: Props) {
  const { busy, mode, mic, notice, onSubmit, onCancel, onMic, building, buildings, onPickBuilding, categories } = props;
  const [value, setValue] = useState('');
  const [look, setLook] = useState(0);
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) return setLook(0);
    const timer = window.setInterval(() => setLook((i) => (i + 1) % LOOKING.length), LOOK_MS);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  }, []);

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue('');
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    if (busy) onCancel();
    else setValue('');
  };

  return (
    <div className="fi fi-search" data-testid="search">
      <form className="fi-bar" onSubmit={send} autoComplete="off">
        <OrbMark size={40} mode={mode} className="fi-mark" testID="orb-mark" />
        <input ref={input} className="fi-field" value={value} maxLength={200} placeholder="Search or ask FINNI…"
               aria-label="Search or ask FINNI" data-testid="search-input" spellCheck={false}
               onChange={(event) => setValue(event.target.value)} onKeyDown={onKey} />
        {onMic && (
          <button type="button" className="fi-icon" aria-label={mic === 'off' ? 'Speak to FINNI' : 'Stop'} data-testid="search-mic"
                  data-on={mic !== 'off' ? '' : undefined} onClick={onMic}>
            <Mic />
          </button>
        )}
        <button type="submit" className="fi-icon fi-send" aria-label="Ask" data-testid="search-send"
                data-ready={value.trim() ? '' : undefined}>
          <Send />
        </button>
      </form>
      <div className="fi-under">
        {busy ? (
          <span key={look} className="fi-status" role="status" data-testid="search-status">{LOOKING[look]}</span>
        ) : notice ? (
          <span className="fi-status" role="status">{notice}</span>
        ) : (
          <button type="button" className="fi-building" data-testid="building-picker" aria-haspopup="listbox"
                  aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
            in <b>{building?.name ?? 'loading…'}</b> ▾
          </button>
        )}
      </div>
      {categories.length > 0 && (
        <div className="fi-chips" role="list" aria-label="Quick searches">
          {categories.map((category) => (
            <button key={category.label} type="button" className="fi-chip" role="listitem" data-testid={`category-${category.label}`}
                    onClick={() => onSubmit(category.question)}>
              {category.label}
            </button>
          ))}
        </div>
      )}
      {menu && (
        <BuildingMenu buildings={buildings} current={building?.id ?? null}
                      onPick={(id) => {
                        setMenu(false);
                        if (id !== building?.id) onPickBuilding(id);
                      }}
                      onClose={() => setMenu(false)} />
      )}
    </div>
  );
}

function BuildingMenu({ buildings, current, onPick, onClose }: {
  buildings: BuildingRow[]; current: string | null; onPick: (id: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = groupBuildings(buildings, query);
  return (
    <div className="fi-menu" role="listbox" data-testid="building-menu"
         onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <input autoFocus value={query} placeholder="Find a building" aria-label="Find a building" data-testid="building-search"
             onChange={(event) => setQuery(event.target.value)} />
      {groups.map((group) => (
        <div key={group.title}>
          <h4>{group.title}</h4>
          {group.rows.map((row) => (
            <button key={row.id} type="button" role="option" aria-current={row.id === current ? 'true' : undefined}
                    aria-selected={row.id === current} data-testid={`building-${row.id}`} onClick={() => onPick(row.id)}>
              {row.name ?? row.id}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
