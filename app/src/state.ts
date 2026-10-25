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
  note: string | null; // a quiet line in the chat, e.g. a new conversation was started
  walk: number | null; // walking the route: the step shown ("Start")
}

export type Event =
  | { type: 'switch' } // another building: start over
  | { type: 'loaded'; detail: BuildingDetail; outline: Outline; sessionId: string }
  | { type: 'renewed'; sessionId: string; note: string } // the old conversation was lost; the messages stay
  | { type: 'send'; text: string }
  | { type: 'cancel' } // the question in flight was dropped (Escape)
  | { type: 'walk'; step: number | null }
  | { type: 'reply'; reply: ChatReply }
  | { type: 'arrived' }
  | { type: 'floor'; floorId: string }
  | { type: 'back' }
  | { type: 'here'; place: Place }
  | { type: 'error'; message: string };

export const initial: State = {
  view: 'loading', detail: null, outline: null, sessionId: null, messages: [], question: null, map: null,
  floorId: null, busy: false, error: null, note: null, walk: null,
};

export function reduce(state: State, event: Event): State {
  switch (event.type) {
    case 'switch':
      return initial;
    case 'loaded':
      return { ...state, view: 'outside', detail: event.detail, outline: event.outline, sessionId: event.sessionId, error: null };
    case 'renewed':
      return { ...state, sessionId: event.sessionId, note: event.note };
    case 'send':
      return { ...state, busy: true, error: null, note: null, question: null,
               messages: [...state.messages, { from: 'you', text: event.text }] };
    case 'cancel':
      return { ...state, busy: false };
    case 'walk':
      return { ...state, walk: event.step };
    case 'reply': {
      const { reply, question, map } = event.reply;
      const messages = reply ? [...state.messages, { from: 'guide' as const, text: reply }] : state.messages;
      const next = { ...state, busy: false, messages, question };
      if (!map || !map.focus_floor_id) return next;
      // Something to show: fly in from outside, or switch straight to the floor if already inside.
      return { ...next, map, walk: null, floorId: map.focus_floor_id, view: state.view === 'floor' ? 'floor' : 'flying' };
    }
    case 'arrived':
      return state.view === 'flying' ? { ...state, view: 'floor' } : state;
    case 'floor':
      return { ...state, floorId: event.floorId, view: state.view === 'outside' ? 'flying' : 'floor' };
    case 'back':
      return { ...state, view: 'outside', floorId: null, walk: null };
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
