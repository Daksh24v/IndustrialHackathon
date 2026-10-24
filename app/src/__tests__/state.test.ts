import type { ChatReply, MapView } from '../api';
import { initial, nextStep, reduce, type State } from '../state';

const loaded: State = { ...initial, view: 'outside', sessionId: 's' };

const map: MapView = {
  you_are_here: { label: 'Lab 0.21', floor_id: 'F0', position: [1, 1], space_id: 'a' },
  target: { label: 'Office 1.04', floor_id: 'F1', position: [5, 5], space_id: 'b' },
  route: {
    length_m: 140,
    pieces: [
      { floor_id: 'F0', points: [[1, 1], [2, 2]], then: { kind: 'stairs', name: 'Stairs 1', to_floor_id: 'F1' } },
      { floor_id: 'F1', points: [[2, 2], [5, 5]], then: null },
    ],
  },
  focus_floor_id: 'F0',
};

describe('state machine', () => {
  it('asks back without leaving the outside view', () => {
    let state = reduce(loaded, { type: 'send', text: 'Where is the toilet?' });
    expect(state.busy).toBe(true);
    const reply: ChatReply = { reply: '', question: { question: 'Which floor?', options: [{ label: 'G' }], allow_free_text: true }, map: null };
    state = reduce(state, { type: 'reply', reply });
    expect(state).toMatchObject({ view: 'outside', busy: false, question: { question: 'Which floor?' } });
    expect(state.messages).toEqual([{ from: 'you', text: 'Where is the toilet?' }]); // empty reply isn't shown
  });

  it('flies in when the agent shows something, then shows the floor', () => {
    let state = reduce(loaded, { type: 'reply', reply: { reply: 'Here.', question: null, map } });
    expect(state).toMatchObject({ view: 'flying', floorId: 'F0' });
    state = reduce(state, { type: 'arrived' });
    expect(state.view).toBe('floor');
    expect(nextStep(state.map, state.floorId)).toMatchObject({ name: 'Stairs 1', to_floor_id: 'F1' });
    state = reduce(state, { type: 'floor', floorId: 'F1' });
    expect(state).toMatchObject({ view: 'floor', floorId: 'F1' });
    expect(nextStep(state.map, state.floorId)).toBeNull();
    expect(reduce(state, { type: 'back' })).toMatchObject({ view: 'outside', floorId: null });
  });

  it('stays inside when a new answer arrives on the floor view', () => {
    const inside = { ...loaded, view: 'floor' as const, floorId: 'F1' };
    expect(reduce(inside, { type: 'reply', reply: { reply: 'x', question: null, map } }).view).toBe('floor');
  });

  it('shows errors and stops the spinner', () => {
    const busy = reduce(loaded, { type: 'send', text: 'hi' });
    expect(reduce(busy, { type: 'error', message: 'down' })).toMatchObject({ busy: false, error: 'down' });
  });
});
