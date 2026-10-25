/** One chat turn that survives a lost conversation: if the server forgot it (404, e.g. after a restart) or the
 * Claude API failed (502), start a new conversation, tell it where the person is, and ask again once. */
import { api, ApiError, type ChatReply, type Place } from './api';

export const RENEWED_NOTE = 'Started a new conversation: the last one was lost.';

export interface Turn {
  sessionId: string;
  buildingId: string;
  text: string;
  spoken?: boolean;
  here?: Place | null; // where the person is, so the new conversation knows it too
}

export interface TurnResult {
  reply: ChatReply;
  sessionId: string; // a new one when renewed
  renewed: boolean;
}

type Client = Pick<typeof api, 'chat' | 'startSession' | 'setPositionAt'>;

export function shouldRenew(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 502);
}

export async function chatTurn(turn: Turn, client: Client = api): Promise<TurnResult> {
  try {
    const reply = await client.chat(turn.sessionId, turn.text, undefined, turn.spoken);
    return { reply, sessionId: turn.sessionId, renewed: false };
  } catch (error) {
    if (!shouldRenew(error)) throw error;
  }
  const { session_id: sessionId } = await client.startSession(turn.buildingId);
  if (turn.here) {
    try {
      await client.setPositionAt(sessionId, turn.here.floor_id, turn.here.position);
    } catch {
      // not worth failing the turn over: Finni can ask
    }
  }
  const reply = await client.chat(sessionId, turn.text, undefined, turn.spoken);
  return { reply, sessionId, renewed: true };
}
