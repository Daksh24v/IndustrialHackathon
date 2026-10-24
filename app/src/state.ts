/** The screen's state machine: the building from outside → (the agent shows something) fly in → one floor. */
import type { BuildingDetail, ChatReply, MapView, Outline, Place, Question, RoutePiece } from './api';
import type { Message } from './components/ChatCard';

export type View = 'loading' | 'outside' | 'flying' | 'floor';

export interface State {
  view: View;
  detail: BuildingDetail | null;
  outline: Outline | null;
  sessionId: string | null;
  messages: Message[];
  question: Question | null;
  map: MapView | null;
  floorId: string | null;
  busy: boolean;
  error: string | null;
}

export type Event =
  | { type: 'loaded'; detail: BuildingDetail; outline: Outline; sessionId: string }
  | { type: 'send'; text: string }
  | { type: 'reply'; reply: ChatReply }
  | { type: 'arrived' }
  | { type: 'floor'; floorId: string }
  | { type: 'back' }
  | { type: 'here'; place: Place }
  | { type: 'error'; message: string };

export const initial: State = {
  view: 'loading', detail: null, outline: null, sessionId: null, messages: [], question: null, map: null,
  floorId: null, busy: false, error: null,
};

export function reduce(state: State, event: Event): State {
  switch (event.type) {
    case 'loaded':
      return { ...state, view: 'outside', detail: event.detail, outline: event.outline, sessionId: event.sessionId, error: null };
    case 'send':
      return { ...state, busy: true, error: null, question: null,
               messages: [...state.messages, { from: 'you', text: event.text }] };
    case 'reply': {
      const { reply, question, map } = event.reply;
      const messages = reply ? [...state.messages, { from: 'guide' as const, text: reply }] : state.messages;
      const next = { ...state, busy: false, messages, question };
      if (!map || !map.focus_floor_id) return next;
      // Something to show: fly in from outside, or switch straight to the floor if already inside.
      return { ...next, map, floorId: map.focus_floor_id, view: state.view === 'floor' ? 'floor' : 'flying' };
    }
    case 'arrived':
      return state.view === 'flying' ? { ...state, view: 'floor' } : state;
    case 'floor':
      return { ...state, floorId: event.floorId, view: state.view === 'outside' ? 'flying' : 'floor' };
    case 'back':
      return { ...state, view: 'outside', floorId: null };
    case 'here': {
      // "I'm here" from a tap: the dot moves at once; the route and the target stay as they are.
      const base: MapView = state.map ?? { you_are_here: null, target: null, route: null, focus_floor_id: null };
      return { ...state, error: null, map: { ...base, you_are_here: event.place } };
    }
    case 'error':
      return { ...state, busy: false, error: event.message };
  }
}

/** The route piece shown on the current floor, and the step that leads to the next floor (if any). */
export function nextStep(map: MapView | null, floorId: string | null): RoutePiece['then'] | null {
  const pieces = map?.route?.pieces ?? [];
  const index = pieces.findIndex((piece) => piece.floor_id === floorId && piece.then?.to_floor_id);
  return index >= 0 ? pieces[index].then : null;
}
