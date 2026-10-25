/** The whole spoken loop with a mockAudio microphone and speaker: listen, pause, words handed over, the answer read
 * out, listening again; muting; stopping. */
import { act, renderHook } from '@testing-library/react-native';

import { useVoice } from '../useVoice';
import { voiceApi } from '../voice';

const mockAudio = {
  recording: { isRecording: false, durationMillis: 0, metering: -60 as number | undefined, canRecord: true,
               fileSize: 0, mediaServicesDidReset: false, url: null },
  playing: { didJustFinish: false },
  played: [] as string[],
  rates: [] as number[],
  paused: 0,
  permission: true,
};

const mockRecorder = {
  isRecording: false,
  uri: 'file:///cache/turn.m4a' as string | null,
  prepareToRecordAsync: jest.fn(async () => {}),
  record: jest.fn(() => { mockRecorder.isRecording = true; }),
  stop: jest.fn(async () => { mockRecorder.isRecording = false; }),
};
const mockPlayer = {
  replace: jest.fn((source: { uri: string }) => mockAudio.played.push(source.uri)),
  setPlaybackRate: jest.fn((rate: number) => mockAudio.rates.push(rate)),
  play: jest.fn(),
  pause: jest.fn(() => { mockAudio.paused += 1; }),
};

jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
  requestRecordingPermissionsAsync: async () => ({ granted: mockAudio.permission }),
  setAudioModeAsync: async () => {},
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => mockAudio.recording,
  useAudioPlayer: () => mockPlayer,
  useAudioPlayerStatus: () => mockAudio.playing,
}));

const spoken = (name: string) => ({ spoken: name, audio_url: `/voice/audio/${name}.mp3`, audio_error: null,
                                    playback_rate: 1.15 });

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockAudio, { played: [], rates: [], paused: 0, permission: true });
  mockAudio.recording = { ...mockAudio.recording, isRecording: false, durationMillis: 0, metering: -60 };
  mockAudio.playing = { didJustFinish: false };
  mockRecorder.isRecording = false;
  global.fetch = jest.fn(async () => ({ blob: async () => new Blob(['m4a']) })) as unknown as typeof fetch;
  jest.spyOn(voiceApi, 'speakText').mockImplementation(async (text) => spoken(text === 'One moment.' ? 'filler' : 'sorry'));
  jest.spyOn(voiceApi, 'speakAnswer').mockResolvedValue(spoken('answer'));
  jest.spyOn(voiceApi, 'transcribe').mockResolvedValue('Where is the coffee machine?');
});

async function setup() {
  const onHeard = jest.fn();
  const onError = jest.fn();
  const hook = await renderHook(() => useVoice({ buildingId: 'proc-factory-dev-003', onHeard, onError }));
  /** The mockRecorder reports a new level after `ms` of recording. */
  const level = async (db: number, ms: number) => {
    mockAudio.recording = { ...mockAudio.recording, isRecording: true, metering: db, durationMillis: ms };
    await act(async () => hook.rerender({}));
  };
  return { hook, onHeard, onError, level };
}

test('tap once: listens, hears the pause, hands over the words, reads the answer, listens again', async () => {
  const { hook, onHeard, level } = await setup();
  await act(async () => hook.result.current.toggle());
  expect(hook.result.current.mic).toBe('listening');
  expect(mockRecorder.record).toHaveBeenCalled();

  await level(-20, 400);   // speaking
  await level(-55, 1400);  // pause
  expect(voiceApi.transcribe).toHaveBeenCalledWith(expect.any(Blob), 'audio/m4a', 'proc-factory-dev-003');
  expect(onHeard).toHaveBeenCalledWith('Where is the coffee machine?');

  // App sends it to the guide, then gets the answer
  await act(async () => hook.result.current.waiting());
  expect(hook.result.current.mic).toBe('thinking');
  await act(async () => hook.result.current.say({ reply: 'Kitchen 1.27, 49 m.', question: null, map: null }));
  expect(hook.result.current.mic).toBe('speaking');
  expect(mockAudio.played.at(-1)).toMatch(/\/voice\/audio\/answer\.mp3$/);
  expect(mockAudio.rates.at(-1)).toBe(1.15);

  mockAudio.playing = { didJustFinish: true };    // finished reading it out
  await act(async () => hook.rerender({}));
  expect(hook.result.current.mic).toBe('listening');
  expect(mockRecorder.record).toHaveBeenCalledTimes(2);
});

test('says "One moment." when the answer is slow', async () => {
  jest.useFakeTimers();
  const { hook } = await setup();
  await act(async () => hook.result.current.toggle());
  await act(async () => hook.result.current.waiting());
  await act(async () => { jest.advanceTimersByTime(1300); });
  expect(mockAudio.played.at(-1)).toMatch(/filler\.mp3$/);
  jest.useRealTimers();
});

test('tapping while it talks stops it; tapping before speaking stops', async () => {
  const { hook } = await setup();
  await act(async () => hook.result.current.toggle());
  await act(async () => hook.result.current.say({ reply: 'Long answer.', question: null, map: null }));
  expect(hook.result.current.mic).toBe('speaking');
  await act(async () => hook.result.current.toggle());
  expect(mockPlayer.pause).toHaveBeenCalled();
  expect(hook.result.current.mic).toBe('off');
  await act(async () => hook.result.current.say({ reply: 'Ignored.', question: null, map: null }));
  expect(hook.result.current.mic).toBe('off');           // typed chats are not read out when voice is off

  await act(async () => hook.result.current.toggle());
  expect(hook.result.current.mic).toBe('listening');
  await act(async () => hook.result.current.toggle());  // nothing said yet: stop
  expect(hook.result.current.mic).toBe('off');
});

test('mute while listening: drops the recording, stays in the conversation; unmute: listens again', async () => {
  const { hook, onHeard, level } = await setup();
  await act(async () => hook.result.current.toggle());
  await level(-20, 400);                                  // halfway through saying something
  await act(async () => hook.result.current.toggleMute());
  expect(hook.result.current.mic).toBe('muted');
  expect(hook.result.current.muted).toBe(true);
  expect(mockRecorder.stop).toHaveBeenCalled();
  await level(-55, 1400);                                 // a late level reading changes nothing
  expect(onHeard).not.toHaveBeenCalled();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();

  await act(async () => hook.result.current.toggleMute());
  expect(hook.result.current.muted).toBe(false);
  expect(hook.result.current.mic).toBe('listening');
  expect(mockRecorder.record).toHaveBeenCalledTimes(2);
});

test('muted: answers are still read out, then it waits instead of listening', async () => {
  const { hook } = await setup();
  await act(async () => hook.result.current.toggle());
  await act(async () => hook.result.current.toggleMute());
  await act(async () => hook.result.current.waiting());  // a typed question while muted
  expect(hook.result.current.mic).toBe('thinking');
  await act(async () => hook.result.current.say({ reply: 'Kitchen 1.27.', question: null, map: null }));
  expect(hook.result.current.mic).toBe('speaking');
  mockAudio.playing = { didJustFinish: true };
  await act(async () => hook.rerender({}));
  expect(hook.result.current.mic).toBe('muted');
  expect(mockRecorder.record).toHaveBeenCalledTimes(1);   // only the first listen

  await act(async () => hook.result.current.toggle());   // the mic button still ends the conversation
  expect(hook.result.current.mic).toBe('off');
  expect(hook.result.current.muted).toBe(false);
  await act(async () => hook.result.current.toggle());   // a new conversation starts unmuted
  expect(hook.result.current.mic).toBe('listening');
});

test('mute while it talks: it finishes the answer, then waits for unmute', async () => {
  const { hook } = await setup();
  await act(async () => hook.result.current.toggle());
  await act(async () => hook.result.current.say({ reply: 'Long answer.', question: null, map: null }));
  const pausedBefore = mockAudio.paused;
  await act(async () => hook.result.current.toggleMute());
  expect(hook.result.current.mic).toBe('speaking');      // not cut off
  expect(mockAudio.paused).toBe(pausedBefore);
  mockAudio.playing = { didJustFinish: true };
  await act(async () => hook.rerender({}));
  expect(hook.result.current.mic).toBe('muted');
  await act(async () => hook.result.current.toggleMute());
  expect(hook.result.current.mic).toBe('listening');
});

test('"stop" ends the conversation without asking the guide', async () => {
  jest.spyOn(voiceApi, 'transcribe').mockResolvedValue('Okay, stop!');
  const { hook, onHeard, level } = await setup();
  await act(async () => hook.result.current.toggle());
  await level(-20, 300);
  await level(-60, 1300);
  expect(onHeard).not.toHaveBeenCalled();
  expect(hook.result.current.mic).toBe('off');
});

test('nobody speaks: stops by itself; nothing heard: says so and listens again', async () => {
  const { hook, onHeard, level } = await setup();
  await act(async () => hook.result.current.toggle());
  await level(-60, 8100);
  expect(hook.result.current.mic).toBe('off');

  jest.spyOn(voiceApi, 'transcribe').mockResolvedValue('');
  await act(async () => hook.result.current.toggle());
  await level(-20, 300);
  await level(-60, 1300);
  expect(onHeard).not.toHaveBeenCalled();
  expect(mockAudio.played.at(-1)).toMatch(/sorry\.mp3$/);
  expect(hook.result.current.mic).toBe('speaking');
});

test('no microphone permission: says why', async () => {
  mockAudio.permission = false;
  const { hook, onError } = await setup();
  await act(async () => hook.result.current.toggle());
  expect(hook.result.current.mic).toBe('off');
  expect(onError).toHaveBeenCalledWith('Allow the microphone to talk to the guide.');
});

test('never stuck: tapping while it works stops talking; a refused text stops with a friendly notice', async () => {
  const { hook } = await setup();
  await act(async () => hook.result.current.toggle());
  await act(async () => hook.result.current.waiting());
  expect(hook.result.current.mic).toBe('thinking');
  await act(async () => hook.result.current.toggle());   // used to do nothing
  expect(hook.result.current.mic).toBe('off');
  await act(async () => hook.result.current.say({ reply: 'Late answer.', question: null, map: null }));
  expect(hook.result.current.mic).toBe('off');           // the answer arrives as text, not read out

  const refused = jest.fn(() => false);
  const other = await renderHook(() => useVoice({ buildingId: 'b', onHeard: refused, onError: jest.fn() }));
  await act(async () => other.result.current.toggle());
  mockAudio.recording = { ...mockAudio.recording, isRecording: true, metering: -20, durationMillis: 400 };
  await act(async () => other.rerender({}));
  mockAudio.recording = { ...mockAudio.recording, isRecording: true, metering: -55, durationMillis: 1400 };
  await act(async () => other.rerender({}));
  expect(refused).toHaveBeenCalled();
  expect(other.result.current.mic).toBe('off');
  expect(other.result.current.notice).toMatch(/say it again/);
});

test('a quiet voice still gets sent when the mic is tapped; silence explains itself', async () => {
  const { hook, onHeard, level } = await setup();
  await act(async () => hook.result.current.toggle());
  await level(-45, 900);                                 // quieter than the speech threshold
  await act(async () => hook.result.current.toggle());
  expect(onHeard).toHaveBeenCalledWith('Where is the coffee machine?');

  const quiet = await setup();
  await act(async () => quiet.hook.result.current.toggle());
  await quiet.level(-60, 8100);
  expect(quiet.hook.result.current.mic).toBe('off');
  expect(quiet.hook.result.current.notice).toMatch(/didn't hear anything/);
});

test('the browser refuses to play the answer: listens again instead of hanging on "speaking"', async () => {
  const { hook } = await setup();
  await act(async () => hook.result.current.toggle());
  await act(async () => hook.result.current.say({ reply: 'Answer.', question: null, map: null }));
  expect(hook.result.current.mic).toBe('speaking');
  mockAudio.playing = { didJustFinish: false, error: 'NotAllowedError: play() failed' } as typeof mockAudio.playing;
  await act(async () => hook.rerender({}));
  expect(hook.result.current.mic).toBe('listening');
});

test('a second tap during the permission prompt does not start twice', async () => {
  const { hook } = await setup();
  await act(async () => {
    hook.result.current.toggle();
    hook.result.current.toggle();
  });
  expect(mockRecorder.record).toHaveBeenCalledTimes(1);
});
