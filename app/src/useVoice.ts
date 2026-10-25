/** The microphone and the guide's voice. Tap the mic once: it listens, stops when you pause and hands over
 * what you said; the answer is read out and it listens again. Talk over it to interrupt (web: it hears you
 * start and goes quiet at once, then listens); say "stop" and the conversation ends. Tap while it talks or works
 * on an answer to stop it (the answer still arrives as text); tap while it listens to send what it has (or stop,
 * if nothing was recorded yet). It also stops by itself when nobody speaks for a while, and whenever the
 * browser refuses to play the answer it listens again instead of hanging. */
import {
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';

import type { ChatReply } from './api';
import { audioUrl, isStopCommand, recordingType, SILENCE, SilenceDetector, type Spoken, voiceApi, watchForBargeIn } from './voice';

export type MicState = 'off' | 'listening' | 'thinking' | 'speaking';

const FILLER = 'One moment.';
const FILLER_AFTER_MS = 1200;
const DIDNT_HEAR = "Sorry, I didn't catch that.";
const RECORDING = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, isMeteringEnabled: true };
const MIN_RECORDING_MS = 600; // a tap after this long sends what was recorded, even if it sounded quiet
const NOTHING_HEARD = "I didn't hear anything, so I stopped listening. Tap the mic to try again.";
const NOT_NOW = "I couldn't take that just now. Tap the mic and say it again.";
const AFTER_BARGE_IN_WAIT_MS = 3500; // talked over it and then said nothing more ("stop!"): close the mic quietly

interface Options {
  buildingId: string | null;
  /** What was said. Return false when it can't be taken (e.g. nothing loaded yet): the mic then stops. */
  onHeard: (text: string) => boolean | void;
  onError: (message: string) => void;
}

export function useVoice({ buildingId, onHeard, onError }: Options) {
  const recorder = useAudioRecorder(RECORDING);
  const recording = useAudioRecorderState(recorder, 100);
  const player = useAudioPlayer(null);
  const playing = useAudioPlayerStatus(player);
  const [mic, setMicState] = useState<MicState>('off');
  const [notice, setNotice] = useState<string | null>(null); // a friendly line about the mic, not an error
  const state = useRef<MicState>('off');
  const on = useRef(false); // a spoken conversation is going: answers are read out, then it listens again
  const detector = useRef(new SilenceDetector());
  const filler = useRef<Spoken | null>(null);
  const fillerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turns = useRef(0);
  const quietIfNothing = useRef(false); // this turn began by talking over Finni: silence just ends it
  const latest = useRef({ buildingId, onHeard, onError });
  latest.current = { buildingId, onHeard, onError };

  function setMic(next: MicState) {
    state.current = next;
    setMicState(next);
  }

  function fail(error: unknown) {
    stop();
    latest.current.onError((error as Error).message ?? String(error));
  }

  async function play(spoken: Spoken): Promise<boolean> {
    const url = audioUrl(spoken);
    if (!url) {
      if (spoken.audio_error) latest.current.onError(spoken.audio_error);
      return false;
    }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }); // the speaker, not the earpiece
    player.replace({ uri: url });
    player.setPlaybackRate(spoken.playback_rate || 1, 'high');
    player.play();
    return true;
  }

  async function listen(afterBargeIn = false) {
    const turn = ++turns.current; // a stop or a newer listen while we wait makes this one stale
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!on.current || turn !== turns.current) return;
      if (!permission.granted) {
        stop();
        latest.current.onError('Allow the microphone to talk to the guide.');
        return;
      }
      player.pause();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      if (!on.current || turn !== turns.current) return;
      recorder.record();
      detector.current = new SilenceDetector(afterBargeIn ? { ...SILENCE, waitMs: AFTER_BARGE_IN_WAIT_MS } : SILENCE);
      quietIfNothing.current = afterBargeIn;
      setMic('listening');
    } catch (error) {
      fail(error);
    }
  }

  /** Read a line out, then listen again (if still in a spoken conversation). */
  async function sayThenListen(spoken: Spoken) {
    if (!on.current) return;
    if (await play(spoken)) setMic('speaking');
    else await listen();
  }

  /** The person paused: stop recording, turn it into words, hand them over. */
  async function finishTurn() {
    setMic('thinking');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('The recording is empty.');
      const audio = await (await fetch(uri)).blob();
      const heard = await voiceApi.transcribe(audio, recordingType(uri, audio.type), latest.current.buildingId);
      if (!on.current) return;
      if (!heard) await sayThenListen(await voiceApi.speakText(DIDNT_HEAR));
      else if (isStopCommand(heard)) stop(); // "stop": end the conversation, nothing sent
      else if (latest.current.onHeard(heard) === false) {
        stop();
        setNotice(NOT_NOW);
      }
    } catch (error) {
      fail(error);
    }
  }

  function stop() {
    on.current = false;
    turns.current += 1;
    if (fillerTimer.current) clearTimeout(fillerTimer.current);
    if (recorder.isRecording) recorder.stop().catch(() => {});
    player.pause();
    setMic('off');
  }

  /** The mic button. */
  function toggle() {
    setNotice(null);
    switch (state.current) {
      case 'off':
        if (on.current) return; // already starting (waiting for the permission prompt)
        on.current = true;
        if (!filler.current) voiceApi.speakText(FILLER).then((clip) => (filler.current = clip)).catch(() => {});
        void listen();
        break;
      case 'listening':
        if (detector.current.spoke || recording.durationMillis >= MIN_RECORDING_MS) void finishTurn();
        else stop();
        break;
      case 'speaking':
        stop(); // stop talking (to say something instead, just talk over it)
        break;
      case 'thinking':
        stop(); // stop talking; the answer still arrives as text
        break;
    }
  }

  /** Something was sent to the guide (spoken, typed or a tapped option): wait for the answer. */
  function waiting() {
    if (!on.current) return;
    if (state.current === 'listening') recorder.stop().catch(() => {}); // they tapped an option instead
    player.pause();
    setMic('thinking');
    if (fillerTimer.current) clearTimeout(fillerTimer.current);
    fillerTimer.current = setTimeout(() => {
      if (state.current === 'thinking' && filler.current) void play(filler.current);
    }, FILLER_AFTER_MS);
  }

  /** The guide answered: read it out, then listen again. */
  async function say(answer: ChatReply) {
    if (!on.current) return;
    if (fillerTimer.current) clearTimeout(fillerTimer.current);
    try {
      await sayThenListen(await voiceApi.speakAnswer(answer));
    } catch (error) {
      fail(error);
    }
  }

  // listening: stop when they pause, or give up when nobody speaks
  useEffect(() => {
    if (state.current !== 'listening' || !recording.isRecording) return;
    const decision = detector.current.update(recording.metering, recording.durationMillis);
    if (decision === 'done') void finishTurn();
    else if (decision === 'nothing') {
      stop();
      if (!quietIfNothing.current) setNotice(NOTHING_HEARD);
    }
  }, [recording]);

  // speaking: the person talks over it (web): go quiet at once and listen to them
  useEffect(() => {
    if (mic !== 'speaking') return;
    return watchForBargeIn(() => {
      if (state.current !== 'speaking' || !on.current) return;
      player.pause();
      void listen(true);
    });
  }, [mic]); // eslint-disable-line react-hooks/exhaustive-deps -- one watch per answer read out

  // speaking: when the answer has been read out, listen again
  useEffect(() => {
    if (playing.didJustFinish && state.current === 'speaking' && on.current) void listen();
  }, [playing.didJustFinish]);

  // the browser refused to play it (autoplay rules) or the file failed: don't hang on "speaking"
  const playError = (playing as { error?: string }).error;
  useEffect(() => {
    if (playError && state.current === 'speaking' && on.current) void listen();
  }, [playError]);

  return { mic, notice, toggle, waiting, say, stop };
}
