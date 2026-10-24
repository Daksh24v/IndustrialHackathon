import { StatusBar } from 'expo-status-bar';
import { Component, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  api, ApiError, buildingFromUrl, type BuildingRow, pickBuilding, placeOf, type Point, showBuildingInUrl,
} from './src/api';
import { BuildingBlocks } from './src/components/BuildingBlocks';
import { BuildingPicker } from './src/components/BuildingPicker';
import { plain } from './src/components/ChatCard';
import { FloorPlan } from './src/components/FloorPlan';
import { FloorScene } from './src/components/FloorScene';
import Intro from './src/orb/Intro';
import MorphOrb, { type OrbAnswer, type OrbHandle } from './src/orb/MorphOrb';
import type { Area } from './src/orb/motion';
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
  const [threeD, setThreeD] = useState(true);
  const [buildings, setBuildings] = useState<BuildingRow[]>([]);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // "Retry" after the server couldn't be reached
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const wide = isWide(window.width);
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

  // Voice (../voice): what was said goes to FINNI like typed text; answers are read out.
  const voice = useVoice({
    buildingId: state.detail?.building.id ?? null,
    onHeard: (text) => {
      if (!orb.current) return false;
      orb.current.ask(text);
      return true;
    },
    onError: (message) => dispatch({ type: 'error', message }),
  });
  const talking = voice.mic !== 'off'; // a spoken conversation: short answers, read out

  // One turn. If the server lost the conversation (restarted) or the Claude API failed, a new conversation
  // starts by itself and the question is asked again (session.ts). An answer with a route flies the map in.
  const here = state.map?.you_are_here ?? null;
  const buildingRef = useRef(buildingId);
  buildingRef.current = buildingId;
  const hereRef = useRef(here);
  hereRef.current = here;
  const talkingRef = useRef(talking);
  talkingRef.current = talking;
  const asks = useRef(0); // each question gets a number: a dropped or older one is ignored when it lands
  const dropAnswer = useCallback(() => {
    asks.current += 1; // whatever is in flight no longer counts
    voice.stop();
  }, [voice]);
  const ask = useCallback(
    async (text: string): Promise<OrbAnswer> => {
      const mine = ++asks.current;
      const sessionId = await until(() => sessionRef.current, SESSION_WAIT_MS);
      const building = buildingRef.current;
      if (!sessionId || !building) {
        voice.stop();
        return { text: "I can't reach the building right now. Check that the server is running, then ask again." };
      }
      const turnOf = generation.current;
      dispatch({ type: 'send', text });
      voice.waiting();
      try {
        const turn = await chatTurn({ sessionId, buildingId: building, text, spoken: talkingRef.current, here: hereRef.current });
        if (turnOf !== generation.current) {
          voice.stop();
          return { text: 'You switched buildings: ask me again.' };
        }
        if (turn.renewed) dispatch({ type: 'renewed', sessionId: turn.sessionId, note: RENEWED_NOTE });
        if (mine !== asks.current) return { text: '' }; // dropped (New question / Escape) or a newer question
        dispatch({ type: 'reply', reply: turn.reply }); // an answer with a route flies the map to the floor
        void voice.say(turn.reply);
        const said = [plain(turn.reply.reply), turn.reply.question?.question].filter(Boolean).join(' ');
        return { text: said || 'Here it is on the map.', options: turn.reply.question?.options };
      } catch (error) {
        voice.stop();
        return { text: (error as Error).message }; // shown in the card (once, not also as a banner)
      }
    },
    [voice],
  );

  // Tap the map: "I'm here". The dot moves, and FINNI starts routes there without asking.
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
  const open = inside || state.view === 'flying'; // a floor is open (or opening): FINNI moves beside the map
  const bottom = Math.max(insets.bottom, 12);
  const row = buildings.find((item) => item.id === buildingId);
  const current = state.detail?.building ?? (row ? { id: row.id, name: row.name ?? row.id } : null);
  const loadFailed = !!state.error && !state.detail;
  const retry = () => {
    dispatch({ type: 'error', message: '' });
    setAttempt((n) => n + 1);
  };

  // One screen: the map fills it; FINNI sits over the building, or beside the map once a floor is open.
  const { finni, map } = layout(window.width, window.height, open, wide);

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.map, { left: map.x, top: map.y, width: map.w, height: map.h }]} testID="map-layer">
        {state.view === 'loading' && !state.error ? <ActivityIndicator color={colours.accent} style={{ flex: 1 }} /> : null}
        {state.outline && (state.view === 'outside' || state.view === 'flying') ? (
          <BuildingBlocks
            outline={state.outline}
            focusFloorId={state.view === 'flying' ? state.floorId : null}
            onArrived={() => dispatch({ type: 'arrived' })}
            onPickFloor={(floorId) => dispatch({ type: 'floor', floorId })}
            spin={state.view === 'outside'}
            width={map.w}
            height={map.h}
          />
        ) : null}
        {state.detail && state.floorId && inside ? (
          threeD ? (
            <FloorScene detail={state.detail} floorId={state.floorId} map={state.map} footprints={footprints}
                        width={map.w} height={map.h} onTapFloor={tapHere} />
          ) : (
            <FloorPlan detail={state.detail} floorId={state.floorId} map={state.map} width={map.w} height={map.h}
                       onTapFloor={tapHere} />
          )
        ) : null}

        {inside && (
          <View style={styles.topRow} pointerEvents="box-none">
            <Pressable testID="building" accessibilityLabel="Back to the whole building" onPress={() => dispatch({ type: 'back' })}
                       style={styles.buildingButton}>
              <Text style={styles.buildingText}>‹ Building</Text>
            </Pressable>
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

      <MorphOrb handleRef={orb} onSubmit={ask} onCancel={dropAnswer} area={finni} docked={open}
                mic={voice.mic} micNotice={voice.notice} onMic={voice.toggle} history={state.messages}
                notice={state.error || state.note || undefined} />

      <View style={[styles.picker, open && wide ? { left: map.x, width: map.w } : null]} pointerEvents="box-none">
        <BuildingPicker buildings={buildings} current={current} onPick={pickOther} />
      </View>
      <Intro />
      {loadFailed && (
        <Pressable testID="retry" onPress={retry} style={styles.retry}>
          <Text style={styles.stepText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const PANEL_PX = 400; // FINNI's column beside an open map (laptops)
const SHEET_SHARE = 0.44; // FINNI's bottom sheet under an open map (phones)
const SESSION_WAIT_MS = 8000; // a question asked while the building still loads waits this long

/** Where FINNI and the map go: FINNI over the whole building, or beside the open map (column / sheet). */
export function layout(width: number, height: number, open: boolean, wide: boolean): { finni: Area; map: Area } {
  if (!open) return { finni: { x: 0, y: 0, w: width, h: height }, map: { x: 0, y: 0, w: width, h: height } };
  if (wide) {
    return { finni: { x: 0, y: 0, w: PANEL_PX, h: height }, map: { x: PANEL_PX, y: 0, w: width - PANEL_PX, h: height } };
  }
  const sheet = Math.round(height * SHEET_SHARE);
  return { finni: { x: 0, y: height - sheet, w: width, h: sheet }, map: { x: 0, y: 0, w: width, h: height - sheet } };
}

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
  screen: { flex: 1, backgroundColor: colours.background, overflow: 'hidden' },
  map: { position: 'absolute' },
  picker: { position: 'absolute', top: 18, left: 0, right: 0, alignItems: 'center', zIndex: 3 },
  title: { fontSize: 18, fontWeight: '700', color: colours.text },
  topRow: { position: 'absolute', left: 12, right: 12, top: 60, flexDirection: 'row', alignItems: 'flex-start',
            justifyContent: 'space-between' },
  buildingButton: { height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center',
                    backgroundColor: colours.background, ...edge },
  buildingText: { color: colours.text, fontWeight: '700', fontSize: 13 },
  floorName: { marginTop: 8, color: colours.muted, fontSize: 13, fontWeight: '600', backgroundColor: 'rgba(255,255,255,0.85)',
               paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  toggle: { flexDirection: 'row', backgroundColor: colours.chip, borderRadius: 18, padding: 3, marginRight: 48 },
  toggleItem: { paddingHorizontal: 12, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  toggleActive: { backgroundColor: colours.background, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3,
                  shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  toggleText: { color: colours.muted, fontWeight: '700', fontSize: 13 },
  toggleTextActive: { color: colours.accent },
  retry: { position: 'absolute', top: 110, alignSelf: 'center', backgroundColor: colours.accent, borderRadius: 20,
           paddingHorizontal: 18, paddingVertical: 10, zIndex: 4 },
  step: { position: 'absolute', alignSelf: 'center', backgroundColor: colours.accent, borderRadius: 20,
          paddingHorizontal: 16, paddingVertical: 10 },
  stepText: { color: '#FFFFFF', fontWeight: '600' },
  distance: { position: 'absolute', right: 12, backgroundColor: colours.background, borderRadius: 14,
              paddingHorizontal: 10, paddingVertical: 6, ...edge },
  distanceText: { color: colours.accent, fontWeight: '700' },
});
