import { StatusBar } from 'expo-status-bar';
import { Component, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError, type ChatReply, pickBuilding } from './src/api';
import { BuildingBlocks } from './src/components/BuildingBlocks';
import { ChatCard } from './src/components/ChatCard';
import { FinniLogo } from './src/components/FinniLogo';
import { FloorPlan } from './src/components/FloorPlan';
import { FloorScene } from './src/components/FloorScene';
import MorphOrb, { type OrbAnswer, type OrbHandle } from './src/orb/MorphOrb';
import { initial, nextStep, reduce } from './src/state';
import { colours } from './src/theme';
import { useVoice } from './src/useVoice';

/** Shows an error on screen (with what went wrong) instead of a crashed app. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <SafeAreaView style={[styles.screen, { padding: 24, gap: 12 }]}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text testID="crash" style={{ color: colours.error }}>{String(this.state.error.message)}</Text>
        <Pressable onPress={() => this.setState({ error: null })} style={styles.retry}>
          <Text style={styles.stepText}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <Guide />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

function Guide() {
  const [state, dispatch] = useReducer(reduce, initial);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [threeD, setThreeD] = useState(true);
  // home: the orb; map: the building and the route (comes in when an answer has a route)
  const [mode, setMode] = useState<'home' | 'map'>('home');
  const orb = useRef<OrbHandle>(null);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  // A laptop (or a tablet held sideways): the conversation on the left, the map beside it. Phones: one column.
  const wide = window.width >= WIDE_MIN_PX && window.width > window.height;

  const loaded = useRef(deferred<string>());
  useEffect(() => {
    (async () => {
      try {
        const id = pickBuilding((await api.buildings()).map((row) => row.id));
        if (!id) throw new ApiError('The server has no buildings.', 0);
        const [detail, outline, session] = await Promise.all([api.building(id), api.outline(id), api.startSession(id)]);
        dispatch({ type: 'loaded', detail, outline, sessionId: session.session_id });
        loaded.current.resolve(session.session_id);
      } catch (error) {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    })();
  }, []);

  // Voice (../voice): the mic hands over what was said like typed text; answers are read out.
  const sendRef = useRef<(text: string) => void>(() => {});
  const voice = useVoice({
    buildingId: state.detail?.building.id ?? null,
    onHeard: (text) => (modeRef.current === 'home' ? orb.current?.ask(text) : sendRef.current(text)),
    onError: (message) => dispatch({ type: 'error', message }),
  });
  const talking = voice.mic !== 'off'; // a spoken conversation: short answers, read out
  const talkingRef = useRef(talking);
  talkingRef.current = talking;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const lastReply = useRef<ChatReply | null>(null);

  /** A question from the orb screen: same conversation as the map's, answered as a card. */
  const askFromOrb = useCallback(async (text: string): Promise<OrbAnswer> => {
    const sessionId = await loaded.current.promise;
    dispatch({ type: 'send', text });
    voice.waiting();
    try {
      const reply = await api.chat(sessionId, text, undefined, talkingRef.current);
      lastReply.current = reply;
      dispatch({ type: 'reply', reply });
      void voice.say(reply);
      const said = [reply.reply, reply.question?.question].filter(Boolean).join('\n\n');
      return { text: said || 'Here it is on the map.', options: reply.question?.options };
    } catch (error) {
      voice.stop();
      return { text: (error as Error).message };
    }
  }, [voice]);

  const onAnswered = useCallback(() => {
    if (lastReply.current?.map?.focus_floor_id) setTimeout(() => setMode('map'), MAP_AFTER_MS);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!state.sessionId) return;
      dispatch({ type: 'send', text });
      voice.waiting();
      try {
        const reply = await api.chat(state.sessionId, text, undefined, talking);
        dispatch({ type: 'reply', reply });
        void voice.say(reply);
      } catch (error) {
        voice.stop();
        dispatch({ type: 'error', message: (error as Error).message });
      }
    },
    [state.sessionId, voice, talking],
  );
  sendRef.current = send;

  const floors = [...(state.detail?.floors ?? [])].sort((a, b) => a.level - b.level);
  const floorName = floors.find((floor) => floor.id === state.floorId)?.name;
  const footprints = state.outline?.floors.find((floor) => floor.id === state.floorId)?.footprints ?? [];
  const step = nextStep(state.map, state.floorId);
  const stepFloor = floors.find((floor) => floor.id === step?.to_floor_id);
  const inside = state.view === 'floor';
  const bottom = Math.max(insets.bottom, 12);

  if (mode === 'home') {
    return (
      <>
        <StatusBar style="light" />
        <MorphOrb handleRef={orb} onSubmit={askFromOrb} onAnswered={onAnswered} mic={voice.mic} onMic={voice.toggle}
                  onOpenMap={state.map ? () => setMode('map') : undefined} notice={state.error ?? undefined} />
      </>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, wide && styles.row]} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <View style={wide ? styles.sidebar : null} testID={wide ? 'sidebar' : undefined}>
        <View style={styles.header}>
          <Pressable testID="back" accessibilityLabel="Back to Finni" onPress={() => setMode('home')}
                     style={styles.back} hitSlop={8}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <Pressable onPress={() => setMode('home')} accessibilityLabel="Finni home">
            <FinniLogo />
          </Pressable>
        </View>
        <ChatCard messages={state.messages} question={state.question} busy={state.busy} onSend={send}
                  onMic={voice.toggle} mic={voice.mic} tall={wide} />
        {state.error ? <Text testID="error" style={styles.error}>{state.error}</Text> : null}
      </View>

      <View style={styles.map} onLayout={(e) => setSize(e.nativeEvent.layout)}>
        {state.view === 'loading' && !state.error ? <ActivityIndicator color={colours.accent} style={{ flex: 1 }} /> : null}
        {state.outline && size.width > 0 && (state.view === 'outside' || state.view === 'flying') ? (
          <BuildingBlocks
            outline={state.outline}
            focusFloorId={state.view === 'flying' ? state.floorId : null}
            onArrived={() => dispatch({ type: 'arrived' })}
            width={size.width}
            height={size.height}
          />
        ) : null}
        {state.detail && state.floorId && inside && size.width > 0 ? (
          threeD ? (
            <FloorScene detail={state.detail} floorId={state.floorId} map={state.map} footprints={footprints}
                        width={size.width} height={size.height} />
          ) : (
            <FloorPlan detail={state.detail} floorId={state.floorId} map={state.map} width={size.width} height={size.height} />
          )
        ) : null}

        {inside && (
          <View style={styles.topRow} pointerEvents="box-none">
            <View style={styles.floors}>
              {floors.length > 1 && [...floors].reverse().map((floor) => (
                <Pressable key={floor.id} testID={`floor-${floor.level}`} onPress={() => dispatch({ type: 'floor', floorId: floor.id })}
                           style={[styles.floorChip, floor.id === state.floorId && styles.floorChipActive]}>
                  <Text style={[styles.floorText, floor.id === state.floorId && styles.floorTextActive]}>
                    {floor.level === 0 ? 'G' : floor.level}
                  </Text>
                </Pressable>
              ))}
            </View>
            {floorName ? <Text testID="floor-name" style={styles.floorName}>{floorName}</Text> : null}
            <View style={styles.toggle}>
              {(['3D', '2D'] as const).map((mode) => {
                const active = (mode === '3D') === threeD;
                return (
                  <Pressable key={mode} testID={`view-${mode}`} onPress={() => setThreeD(mode === '3D')}
                             style={[styles.toggleItem, active && styles.toggleActive]}>
                    <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{mode}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
        {inside && step && stepFloor ? (
          <Pressable testID="next-step" style={[styles.step, { bottom }]} onPress={() => dispatch({ type: 'floor', floorId: stepFloor.id })}>
            <Text style={styles.stepText}>Take {step.name ?? step.kind} to {stepFloor.name} ›</Text>
          </Pressable>
        ) : null}
        {state.map?.route && inside ? (
          <View style={[styles.distance, { bottom: bottom + (step && stepFloor ? 52 : 0) }]}>
            <Text style={styles.distanceText}>{Math.round(state.map.route.length_m)} m</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const WIDE_MIN_PX = 860;
const MAP_AFTER_MS = 1300; // the answer card stays this long before the map comes in

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
const SIDEBAR_PX = 400;

const edge = { borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge };
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.background },
  row: { flexDirection: 'row' },
  sidebar: { width: SIDEBAR_PX, paddingTop: 12, paddingBottom: 16, borderRightWidth: StyleSheet.hairlineWidth,
             borderRightColor: colours.blockEdge },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, gap: 6 },
  back: { width: 28, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
  backText: { fontSize: 32, color: colours.text, marginTop: -4 },
  title: { fontSize: 18, fontWeight: '700', color: colours.text },
  error: { marginHorizontal: 16, marginBottom: 6, color: colours.error },
  map: { flex: 1 },
  topRow: { position: 'absolute', left: 12, right: 12, top: 12, flexDirection: 'row', alignItems: 'flex-start',
            justifyContent: 'space-between' },
  floors: { gap: 6, minWidth: 36 },
  floorChip: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
               backgroundColor: colours.surface, ...edge },
  floorChipActive: { backgroundColor: colours.accent, borderColor: colours.accent },
  floorText: { color: colours.text, fontWeight: '600' },
  floorTextActive: { color: '#FFFFFF' },
  floorName: { marginTop: 8, color: colours.muted, fontSize: 13, fontWeight: '600', backgroundColor: 'rgba(28,28,30,0.85)',
               paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  toggle: { flexDirection: 'row', backgroundColor: colours.surface, borderRadius: 18, padding: 3, ...edge },
  toggleItem: { paddingHorizontal: 12, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  toggleActive: { backgroundColor: colours.surfaceRaised, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3,
                  shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  toggleText: { color: colours.muted, fontWeight: '700', fontSize: 13 },
  toggleTextActive: { color: colours.accent },
  retry: { alignSelf: 'flex-start', backgroundColor: colours.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10 },
  step: { position: 'absolute', alignSelf: 'center', backgroundColor: colours.accent, borderRadius: 20,
          paddingHorizontal: 16, paddingVertical: 10 },
  stepText: { color: '#FFFFFF', fontWeight: '600' },
  distance: { position: 'absolute', right: 12, backgroundColor: colours.surface, borderRadius: 14,
              paddingHorizontal: 10, paddingVertical: 6, ...edge },
  distanceText: { color: colours.accent, fontWeight: '700' },
});
