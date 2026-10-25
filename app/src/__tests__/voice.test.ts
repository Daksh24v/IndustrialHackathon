import { ApiError } from '../api';
import { audioUrl, recordingType, SilenceDetector, VOICE_URL, voiceApi } from '../voice';

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return { ok: status < 400, status, statusText: 'x', json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe('voiceApi', () => {
  it('sends the recording as the body, with its type and the building', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const audio = new Blob(['m4a bytes']);
    const heard = await voiceApi.transcribe(audio, 'audio/m4a', 'proc factory', fakeFetch(200, { heard: 'Floor 1' }, seen));
    expect(heard).toBe('Floor 1');
    expect(seen[0].url).toBe(`${VOICE_URL}/voice/transcribe?building_id=proc%20factory`);
    expect(seen[0].init?.body).toBe(audio);
    expect((seen[0].init?.headers as Record<string, string>)['content-type']).toBe('audio/m4a');
  });

  it('asks for a chat answer or a line to be spoken', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const spoken = { spoken: 'Which floor?', audio_url: '/voice/audio/ab.mp3', audio_error: null, playback_rate: 1.15 };
    const answer = { reply: '', question: null, map: null };
    expect(await voiceApi.speakAnswer(answer, fakeFetch(200, spoken, seen))).toEqual(spoken);
    expect(JSON.parse(seen[0].init?.body as string)).toEqual({ answer });
    await voiceApi.speakText('One moment.', fakeFetch(200, spoken, seen));
    expect(JSON.parse(seen[1].init?.body as string)).toEqual({ text: 'One moment.' });
    expect(audioUrl(spoken)).toBe(`${VOICE_URL}/voice/audio/ab.mp3`);
    expect(audioUrl({ ...spoken, audio_url: null })).toBeNull();
  });

  it('reports voice errors and an unreachable service', async () => {
    await expect(voiceApi.speakText('hi', fakeFetch(502, { detail: 'ElevenLabs 401' }))).rejects.toEqual(
      new ApiError('Voice: ElevenLabs 401', 502),
    );
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(voiceApi.speakText('hi', down)).rejects.toMatchObject({ status: 0 });
  });

  it('knows the recording type', () => {
    expect(recordingType('file:///cache/rec.m4a')).toBe('audio/m4a');
    expect(recordingType('blob:http://localhost/abc', 'audio/webm;codecs=opus')).toBe('audio/webm');
    expect(recordingType('blob:http://localhost/abc')).toBe('audio/webm');
  });
});

describe('SilenceDetector', () => {
  const options = { speechDb: -38, quietMs: 900, waitMs: 8000, maxMs: 15000 };

  it('ends the turn after a pause in speech', () => {
    const detector = new SilenceDetector(options);
    expect(detector.update(-60, 100)).toBe('listening');
    expect(detector.update(-20, 500)).toBe('listening');  // speaking
    expect(detector.update(-25, 1500)).toBe('listening');
    expect(detector.update(-55, 2000)).toBe('listening'); // a short breath
    expect(detector.update(-55, 2400)).toBe('done');      // 900 ms quiet
  });

  it('gives up when nobody speaks, and never records too long', () => {
    expect(new SilenceDetector(options).update(-60, 8000)).toBe('nothing');
    const talker = new SilenceDetector(options);
    talker.update(-20, 100);
    expect(talker.update(-20, 15000)).toBe('done');
    expect(new SilenceDetector(options).update(undefined, 15000)).toBe('nothing'); // no metering at all
  });
});

describe('stop words and talking over Finni', () => {
  const { BargeInDetector, isStopCommand } = require('../voice');
  it('knows a "stop" from a question with the word in it', () => {
    for (const said of ['Stop', 'stop!', 'Okay, stop.', 'Finni, be quiet', 'Hey Finny stop', 'cancel', 'Stopp', "That's enough"]) {
      expect(isStopCommand(said)).toBe(true);
    }
    for (const said of ['Stop at the kitchen on the way', 'where is the bus stop', 'take me to the exit', '']) {
      expect(isStopCommand(said)).toBe(false);
    }
  });
  it('hears someone talk over it only when it is loud for a moment, after the start', () => {
    const detector = new BargeInDetector({ speechDb: -34, holdMs: 200, graceMs: 400 });
    expect(detector.update(-10, 100)).toBe(false);  // the speaker starting up
    expect(detector.update(-20, 500)).toBe(false);  // loud, but only just
    expect(detector.update(-50, 600)).toBe(false);  // a click, gone
    expect(detector.update(-20, 700)).toBe(false);
    expect(detector.update(-20, 950)).toBe(true);   // still talking 250 ms later
  });
});
