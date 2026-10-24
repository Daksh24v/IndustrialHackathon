import { StatusBar } from 'expo-status-bar';
import { Component, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  api, ApiError, buildingFromUrl, type BuildingRow, type ChatReply, pickBuilding, placeOf, type Point, type Question,
  showBuildingInUrl,
} from './src/api';
import { BuildingBlocks } from './src/components/BuildingBlocks';
import { BuildingPicker } from './src/components/BuildingPicker';
import { ChatCard, plain } from './src/components/ChatCard';
import { FinniLogo } from './src/components/FinniLogo';
import { FloorPlan } from './src/components/FloorPlan';
import { FloorScene } from './src/components/FloorScene';
import { type Mode, ModeSwitch } from './src/components/ModeSwitch';
import MorphOrb, { type OrbAnswer, type OrbHandle } from './src/orb/MorphOrb';
import { chatTurn, RENEWED_NOTE } from './src/session';
import { initial, nextStep, reduce } from './src/state';
import { colours, isWide } from './src/theme';
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
  const [buildings, setBuildings] = useState<BuildingRow[]>([]);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const wide = isWide(useWindowDimensions().width);
  // home: the orb (src/orb); map: the building and the route. An answer with a route brings the map in.
  const [mode, setMode] = useState<Mode>('home');
  const [attempt, setAttempt] = useState(0); // "Retry" after the server couldn't be reached
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const orb = useRef<OrbHandle>(null);

  // Which building: ?building=<id> in the address (web), else EXPO_PUBLIC_BUILDING, else the first factory.
  useEffect(() => {
    (async () => {
      try {
        const rows = await api.buildings();
        setBuildings(rows);
        const id = pickBuilding(rows.map((row) => row.id), buildingFromUrl());
        if (!id) throw new ApiError('The server has no buildings.', 0);
        setBuildingId(id);
      } catch (error) {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    })();
  }, [attempt]);

  // Open it with a new conversation; switching buildings starts over (and ends the old conversation).
  const generation = useRef(0); // answers that arrive after a switch belong to the old building
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = state.sessionId;
  useEffect(() => {
    if (!buildingId) return;
    const mine = ++generation.current;
    const previous = sessionRef.current;
    if (previous) void api.endSession(previous).catch(() => {});
    dispatch({ type: 'switch' });
    (async () => {
      try {
        const [detail, outline, session] = await Promise.all([
          api.building(buildingId), api.outline(buildingId), api.startSession(buildingId)]);
        if (mine === generation.current) dispatch({ type: 'loaded', detail, outline, sessionId: session.session_id });
      } catch (error) {
        if (mine === generation.current) dispatch({ type: 'error', message: (error as Error).message });
      }
    })();
  }, [buildingId, attempt]);

  const pickOther = useCallback((id: string) => {
    showBuildingInUrl(id);
    setBuildingId(id);
  }, []);

  // Voice (../voice): the mic hands over what was said like typed text; answers are read out.
  const sendRef = useRef<(text: string) => boolean>(() => false);
  const voice = useVoice({
    buildingId: state.detail?.building.id ?? null,
    onHeard: (text) => {
      if (modeRef.current === 'home') {
        if (!orb.current) return false;
        orb.current.ask(text);
        return true;
      }
      return sendRef.current(text);
    },
    onError: (message) => dispatch({ type: 'error', message }),
  });
  const talking = voice.mic !== 'off'; // a spoken conversation: short answers, read out

  // One turn. If the server lost the conversation (restarted) or the Claude API failed, a new conversation
  // starts by itself and the question is asked again: the messages on screen stay.
  const here = state.map?.you_are_here ?? null;
  const send = useCallback(
    async (text: string) => {
      if (!state.sessionId || !buildingId) return;
      const mine = generation.current;
      dispatch({ type: 'send', text });
      voice.waiting();
      try {
        const turn = await chatTurn({ sessionId: state.sessionId, buildingId, text, spoken: talking, here });
        if (mine !== generation.current) {
          voice.stop(); // another building now: don't leave the mic waiting for this answer
          return;
        }
        if (turn.renewed) dispatch({ type: 'renewed', sessionId: turn.sessionId, note: RENEWED_NOTE });
        dispatch({ type: 'reply', reply: turn.reply });
        void voice.say(turn.reply);
      } catch (error) {
        voice.stop();
        if (mine === generation.current) dispatch({ type: 'error', message: (error as Error).message });
      }
    },
    [state.sessionId, buildingId, voice, talking, here],
  );
  // Heard on the map screen: taken only if there's a conversation to send it to.
  sendRef.current = (text: string) => {
    if (!state.sessionId || !buildingId) return false;
    void send(text);
    return true;
  };

  // The same turn, asked on the orb screen: the answer comes back for the orb's card.
  const buildingRef = useRef(buildingId);
  buildingRef.current = buildingId;
  const hereRef = useRef(here);
  hereRef.current = here;
  const talkingRef = useRef(talking);
  talkingRef.current = talking;
  const lastReply = useRef<ChatReply | null>(null);
  const asks = useRef(0); // each orb question gets a number: a dropped or older one is ignored when it lands
  const mapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelMapSwitch = useCallback(() => {
    if (mapTimer.current) clearTimeout(mapTimer.current);
    mapTimer.current = null;
  }, []);
  const dropOrbAnswer = useCallback(() => {
    asks.current += 1; // whatever is in flight no longer counts
    lastReply.current = null;
    cancelMapSwitch();
    voice.stop();
  }, [cancelMapSwitch, voice]);
  const askFromOrb = useCallback(
    async (text: string): Promise<OrbAnswer> => {
      const ask = ++asks.current;
      lastReply.current = null;
      cancelMapSwitch();
      const sessionId = await until(() => sessionRef.current, SESSION_WAIT_MS);
      const building = buildingRef.current;
      if (!sessionId || !building) {
        voice.stop();
        return { text: "I can't reach the building right now. Check that the server is running, then ask again." };
      }
      const mine = generation.current;
      dispatch({ type: 'send', text });
      voice.waiting();
      try {
        const turn = await chatTurn({ sessionId, buildingId: building, text, spoken: talkingRef.current, here: hereRef.current });
        if (mine !== generation.current) {
          voice.stop();
          return { text: 'You switched buildings: ask me again.' };
        }
        if (turn.renewed) dispatch({ type: 'renewed', sessionId: turn.sessionId, note: RENEWED_NOTE });
        dispatch({ type: 'reply', reply: turn.reply }); // the map screen keeps the conversation either way
        if (ask !== asks.current) return { text: '' }; // dropped (New question / Escape) or a newer question
        lastReply.current = turn.reply;
        void voice.say(turn.reply);
        const said = [plain(turn.reply.reply), turn.reply.question?.question].filter(Boolean).join(' ');
        return { text: said || 'Here it is on the map.', options: turn.reply.question?.options };
      } catch (error) {
        voice.stop();
        return { text: (error as Error).message }; // shown in the orb's card (once, not also as a banner)
      }
    },
    [voice, cancelMapSwitch],
  );
  const onOrbAnswered = useCallback(() => {
    cancelMapSwitch();
    if (lastReply.current?.map?.focus_floor_id) mapTimer.current = setTimeout(() => setMode('map'), MAP_AFTER_MS);
  }, [cancelMapSwitch]);
  useEffect(() => cancelMapSwitch, [cancelMapSwitch]);
  useEffect(() => {
    cancelMapSwitch(); // a building switch or a screen change never gets overridden by an old timer
  }, [buildingId, mode, cancelMapSwitch]);

  // Tap the map: "I'm here". The dot moves, and Finni starts routes there without asking.
  const tapHere = useCallback(
    async (floorId: string, point: Point) => {
      if (!state.sessionId || !state.detail) return;
      try {
        const position = await api.setPositionAt(state.sessionId, floorId, point);
        dispatch({ type: 'here', place: placeOf(position, state.detail) });
      } catch (error) {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    },
    [state.sessionId, state.detail],
  );

  const floors = [...(state.detail?.floors ?? [])].sort((a, b) => a.level - b.level);
  const floorName = floors.find((floor) => floor.id === state.floorId)?.name;
  const footprints = state.outline?.floors.find((floor) => floor.id === state.floorId)?.footprints ?? [];
  const step = nextStep(state.map, state.floorId);
  const stepFloor = floors.find((floor) => floor.id === step?.to_floor_id);
  const inside = state.view === 'floor';
  const bottom = Math.max(insets.bottom, 12);
  const row = buildings.find((item) => item.id === buildingId);
  const current = state.detail?.building ?? (row ? { id: row.id, name: row.name ?? row.id } : null);

  const loadFailed = !!state.error && !state.detail;
  const retry = () => {
    dispatch({ type: 'error', message: '' });
    setAttempt((n) => n + 1);
  };
  const switchTo = (next: Mode) => {
    if (next === 'home') cancelMapSwitch();
    setMode(next);
  };

  if (mode === 'home') {
    return (
      <FadeIn key="home" style={styles.home}>
        <StatusBar style="dark" />
        <MorphOrb handleRef={orb} onSubmit={askFromOrb} onAnswered={onOrbAnswered} onCancel={dropOrbAnswer}
                  mic={voice.mic} micNotice={voice.notice} onMic={voice.toggle} lastAnswer={lastAnswer(state)}
                  notice={state.error || undefined} />
        <View style={styles.homePicker} pointerEvents="box-none">
          <BuildingPicker buildings={buildings} current={current} onPick={pickOther} />
        </View>
        <View style={styles.homeSwitch} pointerEvents="box-none">
          <ModeSwitch mode={mode} onChange={switchTo} mapReady={!!state.detail} />
        </View>
        {loadFailed && (
          <Pressable testID="retry" onPress={retry} style={styles.homeRetry}>
            <Text style={styles.stepText}>Retry</Text>
          </Pressable>
        )}
      </FadeIn>
    );
  }

  return (
    <FadeIn key="map" style={styles.screen}>
    <SafeAreaView style={[styles.screen, wide && styles.wide]} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={wide ? styles.side : styles.top} testID={wide ? 'side-panel' : 'top-panel'}>
        <View style={styles.header}>
          {inside || state.view === 'flying' ? (
            <Pressable testID="back" accessibilityLabel="Back to the building" onPress={() => dispatch({ type: 'back' })}
                       style={styles.back} hitSlop={8}>
              <Text style={styles.backText}>‹</Text>
            </Pressable>
          ) : null}
          <Pressable testID="home" accessibilityLabel="Finni home" onPress={() => setMode('home')}>
            <FinniLogo />
          </Pressable>
          <BuildingPicker buildings={buildings} current={current} onPick={pickOther} />
          <View style={styles.headerSwitch}>
            <ModeSwitch mode={mode} onChange={switchTo} mapReady={!!state.detail} />
          </View>
        </View>
        {loadFailed && (
          <Pressable testID="retry" onPress={retry} style={styles.retry}>
            <Text style={styles.stepText}>Retry</Text>
          </Pressable>
        )}
        <ChatCard messages={state.messages} question={state.question} busy={state.busy} onSend={send}
                  onMic={voice.toggle} mic={voice.mic} side={wide} note={state.note} />
        {state.error ? <Text testID="error" style={styles.error}>{state.error}</Text> : null}
      </View>

      <View style={styles.map} onLayout={(e) => setSize(e.nativeEvent.layout)}>
        {state.view === 'loading' && !state.error ? <ActivityIndicator color={colours.accent} style={{ flex: 1 }} /> : null}
        {state.outline && size.width > 0 && (state.view === 'outside' || state.view === 'flying') ? (
          <BuildingBlocks
            outline={state.outline}
            focusFloorId={state.view === 'flying' ? state.floorId : null}
            onArrived={() => dispatch({ type: 'arrived' })}
            onPickFloor={(floorId) => dispatch({ type: 'floor', floorId })}
            width={size.width}
            height={size.height}
          />
        ) : null}
        {state.detail && state.floorId && inside && size.width > 0 ? (
          threeD ? (
            <FloorScene detail={state.detail} floorId={state.floorId} map={state.map} footprints={footprints}
                        width={size.width} height={size.height} onTapFloor={tapHere} />
          ) : (
            <FloorPlan detail={state.detail} floorId={state.floorId} map={state.map} width={size.width} height={size.height}
                       onTapFloor={tapHere} />
          )
        ) : null}

        {inside && (
          <View style={styles.topRow} pointerEvents="box-none">
            <View style={styles.floors}>
              {floors.length > 1 && [...floors].reverse().map((floor) => (
                <Pressable key={floor.id} testID={`floor-${floor.level}`} onPress={() => dispatch({ type: 'floor', floorId: floor.id })}
                           accessibilityRole="button" accessibilityLabel={floor.name}
                           accessibilityState={{ selected: floor.id === state.floorId }}
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
                             accessibilityRole="tab" accessibilityState={{ selected: active }}
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
    </FadeIn>
  );
}

/** What Finni said last (and the question it is waiting on): the orb shows it when you come back. */
function lastAnswer(state: { messages: { from: string; text: string }[]; question: Question | null }): OrbAnswer | null {
  const last = [...state.messages].reverse().find((message) => message.from === 'guide');
  if (!last && !state.question) return null;
  const text = [last ? plain(last.text) : '', state.question?.question ?? ''].filter(Boolean).join(' ');
  return { text, options: state.question?.options };
}

/** Screens fade in instead of swapping hard. */
function FadeIn({ children, style }: { children: ReactNode; style: object }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
  }, [opacity]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}

const MAP_AFTER_MS = 1300; // the orb's answer card stays this long before the map comes in
const SESSION_WAIT_MS = 8000;
const FADE_MS = 260; // an orb question asked while the building still loads waits this long

/** The value once it's there (polled), or null after a while. */
async function until<T>(get: () => T | null, timeoutMs = 20000): Promise<T | null> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    const value = get();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return get();
}

const edge = { borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge };
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.background },
  home: { flex: 1, backgroundColor: '#FFFFFF' },
  homePicker: { position: 'absolute', top: 18, left: 0, right: 0, alignItems: 'center', zIndex: 3 },
  homeSwitch: { position: 'absolute', top: 16, right: 16, zIndex: 4 },
  homeRetry: { position: 'absolute', top: 110, alignSelf: 'center', backgroundColor: colours.accent, borderRadius: 20,
               paddingHorizontal: 18, paddingVertical: 10, zIndex: 4 },
  wide: { flexDirection: 'row' },
  top: { zIndex: 2 }, // the building menu opens over the map
  side: { width: 360, zIndex: 2, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colours.blockEdge,
          backgroundColor: colours.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, gap: 6,
            zIndex: 2 },
  headerSwitch: { marginLeft: 'auto' },
  back: { width: 28, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
  backText: { fontSize: 32, color: colours.text, marginTop: -4 },
  title: { fontSize: 18, fontWeight: '700', color: colours.text },
  error: { marginHorizontal: 16, marginBottom: 6, color: colours.error },
  map: { flex: 1 },
  topRow: { position: 'absolute', left: 12, right: 12, top: 12, flexDirection: 'row', alignItems: 'flex-start',
            justifyContent: 'space-between' },
  floors: { gap: 6, minWidth: 36 },
  floorChip: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
               backgroundColor: colours.background, ...edge },
  floorChipActive: { backgroundColor: colours.accent, borderColor: colours.accent },
  floorText: { color: colours.text, fontWeight: '600' },
  floorTextActive: { color: '#FFFFFF' },
  floorName: { marginTop: 8, color: colours.muted, fontSize: 13, fontWeight: '600', backgroundColor: 'rgba(255,255,255,0.85)',
               paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  toggle: { flexDirection: 'row', backgroundColor: colours.chip, borderRadius: 18, padding: 3 },
  toggleItem: { paddingHorizontal: 12, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  toggleActive: { backgroundColor: colours.background, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3,
                  shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  toggleText: { color: colours.muted, fontWeight: '700', fontSize: 13 },
  toggleTextActive: { color: colours.accent },
  retry: { alignSelf: 'flex-start', backgroundColor: colours.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
           marginHorizontal: 16, marginBottom: 8 },
  step: { position: 'absolute', alignSelf: 'center', backgroundColor: colours.accent, borderRadius: 20,
          paddingHorizontal: 16, paddingVertical: 10 },
  stepText: { color: '#FFFFFF', fontWeight: '600' },
  distance: { position: 'absolute', right: 12, backgroundColor: colours.background, borderRadius: 14,
              paddingHorizontal: 10, paddingVertical: 6, ...edge },
  distanceText: { color: colours.accent, fontWeight: '700' },
});
