/** The microphone and the guide's voice. Tap the mic once: it listens, stops when you pause and hands over
 * what you said; the answer is read out and it listens again. Tap while it talks to interrupt; tap while it
 * listens (before you speak) to stop; it also stops by itself when nobody speaks for a while. */
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
import { audioUrl, recordingType, SilenceDetector, type Spoken, voiceApi } from './voice';

export type MicState = 'off' | 'listening' | 'thinking' | 'speaking';

const FILLER = 'One moment.';
const FILLER_AFTER_MS = 1200;
const DIDNT_HEAR = "Sorry, I didn't catch that.";
const RECORDING = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, isMeteringEnabled: true };

interface Options {
  buildingId: string | null;
  onHeard: (text: string) => void;
  onError: (message: string) => void;
}

export function useVoice({ buildingId, onHeard, onError }: Options) {
  const recorder = useAudioRecorder(RECORDING);
  const recording = useAudioRecorderState(recorder, 100);
  const player = useAudioPlayer(null);
  const playing = useAudioPlayerStatus(player);
  const [mic, setMicState] = useState<MicState>('off');
  const state = useRef<MicState>('off');
  const on = useRef(false); // a spoken conversation is going: answers are read out, then it listens again
  const detector = useRef(new SilenceDetector());
  const filler = useRef<Spoken | null>(null);
  const fillerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  async function listen() {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        stop();
        latest.current.onError('Allow the microphone to talk to the guide.');
        return;
      }
      player.pause();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      detector.current = new SilenceDetector();
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
      if (heard) latest.current.onHeard(heard);
      else await sayThenListen(await voiceApi.speakText(DIDNT_HEAR));
    } catch (error) {
      fail(error);
    }
  }

  function stop() {
    on.current = false;
    if (fillerTimer.current) clearTimeout(fillerTimer.current);
    if (recorder.isRecording) recorder.stop().catch(() => {});
    player.pause();
    setMic('off');
  }

  /** The mic button. */
  function toggle() {
    switch (state.current) {
      case 'off':
        on.current = true;
        if (!filler.current) voiceApi.speakText(FILLER).then((clip) => (filler.current = clip)).catch(() => {});
        void listen();
        break;
      case 'listening':
        if (detector.current.spoke) void finishTurn();
        else stop();
        break;
      case 'speaking':
        void listen(); // interrupt
        break;
      case 'thinking':
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
    else if (decision === 'nothing') stop();
  }, [recording]);

  // speaking: when the answer has been read out, listen again
  useEffect(() => {
    if (playing.didJustFinish && state.current === 'speaking' && on.current) void listen();
  }, [playing.didJustFinish]);

  return { mic, toggle, waiting, say, stop };
}
