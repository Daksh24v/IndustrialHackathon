/** Client for the voice endpoints (../voice, served by the backend): speech to text, and answers in Finni's
 * voice. Plain functions, tested without a microphone; src/useVoice.ts does the recording and playing. */
import { accessHeaders } from './access';
import { API_URL, ApiError, type ChatReply } from './api';

// The backend serves /voice too; EXPO_PUBLIC_VOICE_URL only if voice runs as its own service (port 8001).
export const VOICE_URL = (process.env.EXPO_PUBLIC_VOICE_URL ?? API_URL).replace(/\/$/, '');

export interface Spoken {
  spoken: string;
  audio_url: string | null;
  audio_error: string | null;
  playback_rate: number;
}

async function post<T>(path: string, body: BodyInit, contentType: string, fetcher: typeof fetch = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${VOICE_URL}${path}`, {
      method: 'POST', headers: { 'content-type': contentType, ...accessHeaders() }, body,
    });
  } catch {
    throw new ApiError(`Can't reach the voice service at ${VOICE_URL}.`, 0);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail ?? detail;
    } catch {
      // keep the status text
    }
    throw new ApiError(`Voice: ${detail}`, response.status);
  }
  return (await response.json()) as T;
}

export const voiceApi = {
  /** What was said in the recording; the building id helps it hear room and machine names. */
  transcribe: async (audio: Blob, contentType: string, buildingId: string | null, fetcher?: typeof fetch) => {
    const query = buildingId ? `?building_id=${encodeURIComponent(buildingId)}` : '';
    return (await post<{ heard: string }>(`/voice/transcribe${query}`, audio, contentType, fetcher)).heard;
  },
  /** A /chat answer read out: short, with the question and its options. */
  speakAnswer: (answer: ChatReply, fetcher?: typeof fetch) =>
    post<Spoken>('/voice/speak', JSON.stringify({ answer }), 'application/json', fetcher),
  /** Any line the app decides on ("One moment.", later AR steps like "Turn left now."). */
  speakText: (text: string, fetcher?: typeof fetch) =>
    post<Spoken>('/voice/speak', JSON.stringify({ text }), 'application/json', fetcher),
};

/** Where the player can stream the spoken audio from. */
export function audioUrl(spoken: Spoken): string | null {
  return spoken.audio_url ? `${VOICE_URL}${spoken.audio_url}` : null;
}

/** The recording's media type: from the blob when the browser says, else from the file name (m4a on phones). */
export function recordingType(uri: string, blobType = ''): string {
  if (blobType) return blobType.split(';')[0];
  const extension = uri.split('?')[0].split('.').pop()?.toLowerCase();
  return { m4a: 'audio/m4a', mp4: 'audio/mp4', wav: 'audio/wav', caf: 'audio/x-caf', '3gp': 'audio/3gpp' }[
    extension ?? ''] ?? 'audio/webm';
}

export interface SilenceOptions {
  speechDb: number;  // louder than this (dBFS) is someone speaking
  quietMs: number;   // this much quiet after speech ends the turn
  waitMs: number;    // nobody spoke for this long: stop listening
  maxMs: number;     // never record longer
}

export const SILENCE: SilenceOptions = { speechDb: -38, quietMs: 900, waitMs: 8000, maxMs: 15000 };

/** Decides from the microphone level when a spoken turn is over. Feed it the recorder's metering (dBFS) and
 * how long it has been recording; without metering (some devices) it only stops at maxMs. */
export class SilenceDetector {
  spoke = false;
  private lastLoudMs = 0;

  constructor(private readonly options: SilenceOptions = SILENCE) {}

  update(levelDb: number | undefined, elapsedMs: number): 'listening' | 'done' | 'nothing' {
    if (levelDb !== undefined && levelDb > this.options.speechDb) {
      this.spoke = true;
      this.lastLoudMs = elapsedMs;
    }
    if (elapsedMs >= this.options.maxMs) return this.spoke ? 'done' : 'nothing';
    if (this.spoke && elapsedMs - this.lastLoudMs >= this.options.quietMs) return 'done';
    if (!this.spoke && elapsedMs >= this.options.waitMs) return 'nothing';
    return 'listening';
  }
}

/** Words that mean "stop talking", said instead of a question: the conversation ends, nothing is sent. */
const STOP_WORDS = new Set([
  'stop', 'stop it', 'stop talking', 'stop please', 'please stop', 'ok stop', 'okay stop', 'finni stop', 'finny stop',
  'be quiet', 'quiet', 'shut up', 'cancel', 'never mind', 'nevermind', "that's enough", 'thats enough', 'enough',
  'thank you stop', 'stopp', 'halt', 'ruhe', 'hör auf', 'hoer auf',
]);

/** Whether what was heard is only a "stop" ("Stop!", "Okay, stop.", "Finni, be quiet"), not a question that
 * happens to contain the word ("stop at the kitchen on the way"). */
export function isStopCommand(heard: string): boolean {
  const words = heard.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(hey |hi )?(finni|finny|finn[ie]?)\b ?/, '');
  return STOP_WORDS.has(words) || STOP_WORDS.has(words.replace(/^(ok|okay|please|no|hey) /, ''));
}
