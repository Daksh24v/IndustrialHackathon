import { StatusBar } from 'expo-status-bar';
import { Component, type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  api, ApiError, buildingFromUrl, type BuildingRow, pickBuilding, placeOf, type Point, showBuildingInUrl,
} from './src/api';
import { categories } from './src/categories';
import { BuildingBlocks } from './src/components/BuildingBlocks';
import { FloorPlan } from './src/components/FloorPlan';
import { FloorScene, type Inset, TILT, TOP_TILT } from './src/components/FloorScene';
import Intro from './src/orb/Intro';
import type { SphereMode } from './src/orb/sphere';
import { chatTurn, RENEWED_NOTE } from './src/session';
import { initial, nextStep, reduce } from './src/state';
import { routeSteps, summary } from './src/steps';
import { colours, isWide } from './src/theme';
import { MapControls, type MapHandle, type ViewMode } from './src/ui/MapControls';
import { OrbMark } from './src/ui/OrbMark';
import { Panel, sheetHeight, type Snap } from './src/ui/Panel';
import { SearchBar } from './src/ui/SearchBar';
import { WalkBanner } from './src/ui/WalkBanner';
import './src/ui/finni.css';
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
  const [view, setView] = useState<ViewMode>('3d');
  const [buildings, setBuildings] = useState<BuildingRow[]>([]);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // "Retry" after the server couldn't be reached
  const [panelOpen, setPanelOpen] = useState(false);
  const [snap, setSnap] = useState<Snap>('peek');
  const [sphere, setSphere] = useState<SphereMode>('rest');
  const [hoverStep, setHoverStep] = useState<number | null>(null);
  const [pickedStep, setPickedStep] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const window = useWindowDimensions();
  const wide = isWide(window.width);
  const handle = useRef<MapHandle | null>(null);

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
    setPanelOpen(false);
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
  const askRef = useRef<(text: string) => void>(() => {});
  const voice = useVoice({
    buildingId: state.detail?.building.id ?? null,
    onHeard: (text) => {
      if (!sessionRef.current) return false;
      askRef.current(text);
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
    dispatch({ type: 'cancel' });
    setSphere('rest');
  }, [voice]);
  const ask = useCallback(
    async (text: string) => {
      const mine = ++asks.current;
      setPanelOpen(true);
      setSnap('peek');
      setSphere('think');
      const sessionId = await until(() => sessionRef.current, SESSION_WAIT_MS);
      const building = buildingRef.current;
      if (!sessionId || !building) {
        voice.stop();
        setSphere('rest');
        dispatch({ type: 'error', message: "I can't reach the building right now. Check that the server is running, then ask again." });
        return;
      }
      const turnOf = generation.current;
      dispatch({ type: 'send', text });
      voice.waiting();
      try {
        const turn = await chatTurn({ sessionId, buildingId: building, text, spoken: talkingRef.current, here: hereRef.current });
        if (turnOf !== generation.current) return voice.stop();
        if (turn.renewed) dispatch({ type: 'renewed', sessionId: turn.sessionId, note: RENEWED_NOTE });
        if (mine !== asks.current) return; // dropped (Escape) or a newer question
        dispatch({ type: 'reply', reply: turn.reply }); // an answer with a route flies the map to the floor
        setSphere('done');
        setTimeout(() => setSphere((now) => (now === 'done' ? 'rest' : now)), DONE_MS); // so the next answer flashes too
        setPickedStep(null);
        setSnap((turn.reply.question?.options.length ?? 0) > 3 ? 'half' : 'peek');
        void voice.say(turn.reply);
      } catch (error) {
        voice.stop();
        if (mine !== asks.current) return;
        setSphere('rest');
        dispatch({ type: 'error', message: (error as Error).message });
      }
    },
    [voice],
  );
  askRef.current = (text) => void ask(text);

  // Tap the map: "I'm here". The dot moves, and FINNI starts routes there without asking.
  const tapHere = useCallback(
    async (floorId: string, point: Point) => {
      if (!state.sessionId || !state.detail) return;
      try {
        const position = await api.setPositionAt(state.sessionId, floorId, point);
        dispatch({ type: 'here', place: placeOf(position, state.detail) });
        setToast(null);
      } catch (error) {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    },
    [state.sessionId, state.detail],
  );

  const floors = useMemo(() => [...(state.detail?.floors ?? [])].sort((a, b) => a.level - b.level), [state.detail]);
  const floorName = floors.find((floor) => floor.id === state.floorId)?.name;
  const footprints = state.outline?.floors.find((floor) => floor.id === state.floorId)?.footprints ?? [];
  const step = nextStep(state.map, state.floorId);
  const stepFloor = floors.find((floor) => floor.id === step?.to_floor_id);
  const inside = state.view === 'floor';
  const row = buildings.find((item) => item.id === buildingId);
  const current = state.detail?.building ?? (row ? { id: row.id, name: row.name ?? row.id } : null);
  const loadFailed = !!state.error && !state.detail;
  const retry = () => {
    dispatch({ type: 'error', message: '' });
    setAttempt((n) => n + 1);
  };
  const quick = useMemo(() => categories(state.detail), [state.detail]);
  const steps = useMemo(() => routeSteps(state.map, state.detail), [state.map, state.detail]);
  const sum = useMemo(() => summary(state.map, state.detail), [state.map, state.detail]);

  // Walking the route ("Start"), or a step picked in the list: show its floor and frame it.
  const walking = state.walk !== null && !!steps[state.walk];
  const shownStep = walking ? state.walk : pickedStep;
  useEffect(() => {
    const at = shownStep !== null ? steps[shownStep] : null;
    if (at && at.floorId !== state.floorId) dispatch({ type: 'floor', floorId: at.floorId });
  }, [shownStep, steps]); // eslint-disable-line react-hooks/exhaustive-deps -- follow the step, not the floor
  const walkTo = (index: number | null) => {
    dispatch({ type: 'walk', step: index });
    const at = index !== null ? steps[index] : null;
    if (at && talking) void voice.say({ reply: `${at.walk_m ? `In ${at.walk_m} metres, ` : ''}${at.action}.`, question: null, map: null });
  };
  const focusPath = useMemo(() => {
    const at = shownStep !== null ? steps[shownStep] : null;
    return at && at.floorId === state.floorId ? at.path : null;
  }, [shownStep, steps, state.floorId]);
  const lit = hoverStep !== null ? steps[hoverStep] : shownStep !== null ? steps[shownStep] : null;
  const highlight = lit && lit.floorId === state.floorId && lit.path.length > 1 ? lit.path : null;

  // The map fills the screen; FINNI's column (laptops) or bar and sheet (phones) cover part of it.
  const showPanel = panelOpen && (state.messages.length > 0 || state.busy || !!state.error) && !(walking && !wide);
  const sheet = showPanel && !wide ? sheetHeight(snap, window.height) : 0;
  const inset: Inset = wide
    ? { left: COLUMN_PX + 16, top: walking ? 96 : 0, right: 72, bottom: 0 }
    : { left: 0, top: walking ? 120 : 132, right: inside ? 64 : 0, bottom: sheet };
  const controlsBottom = wide ? 24 : sheet + 16;
  const mapLeft = wide ? COLUMN_PX + 32 : 12;

  const openHere = () => {
    if (!inside && floors.length) dispatch({ type: 'floor', floorId: (floors.find((f) => f.level === 0) ?? floors[0]).id });
    setToast('Tap the floor where you are. FINNI starts your routes there.');
  };
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const panel = showPanel ? (
    <Panel wide={wide} messages={state.messages} question={state.question} map={state.map} steps={steps} summary={sum}
           busy={state.busy} error={state.detail ? state.error : null} note={state.note}
           activeStep={hoverStep ?? shownStep} snap={snap} onSnap={setSnap}
           onOption={(label) => void ask(label)} onClose={() => setPanelOpen(false)}
           onStepHover={setHoverStep} onStepPick={(index) => setPickedStep(index)}
           onStart={() => walkTo(0)} />
  ) : null;
  const search = (
    <SearchBar busy={state.busy} mode={sphere} mic={voice.mic} notice={voice.notice}
               onSubmit={(text) => void ask(text)} onCancel={dropAnswer} onMic={voice.toggle}
               building={current} buildings={buildings} onPickBuilding={pickOther} categories={quick} />
  );

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.map} testID="map-layer">
        {state.view === 'loading' && !state.error ? <ActivityIndicator color={colours.accent} style={{ flex: 1 }} /> : null}
        {state.outline && (state.view === 'outside' || state.view === 'flying') ? (
          <BuildingBlocks
            outline={state.outline}
            spaces={state.detail?.spaces}
            map={state.map}
            focusFloorId={state.view === 'flying' ? state.floorId : null}
            onArrived={() => dispatch({ type: 'arrived' })}
            onPickFloor={(floorId) => dispatch({ type: 'floor', floorId })}
            spin={state.view === 'outside' && !state.map?.route}
            width={window.width}
            height={window.height}
            inset={inset}
          />
        ) : null}
        {state.detail && state.floorId && inside ? (
          view !== 'plan' ? (
            <FloorScene tilt={view === 'top' ? TOP_TILT : TILT} detail={state.detail} floorId={state.floorId} map={state.map} footprints={footprints}
                        width={window.width} height={window.height} onTapFloor={tapHere} controls={false}
                        handleRef={handle} inset={inset} highlight={highlight} focus={focusPath} />
          ) : (
            <FloorPlan detail={state.detail} floorId={state.floorId} map={state.map} width={window.width} height={window.height}
                       onTapFloor={tapHere} controls={false} handleRef={handle} inset={inset} highlight={highlight}
                       focus={focusPath} />
          )
        ) : null}
      </View>

      {wide ? (
        <div className="fi fi-column">
          {search}
          {panel}
        </div>
      ) : (
        <>
          {!walking && search}
          {panel}
        </>
      )}

      {inside && floorName && wide && !walking && (
        <div className="fi fi-floor" style={{ left: mapLeft + (window.width - mapLeft - 72) / 2 }} data-testid="floor-name">
          {floorName}
        </div>
      )}
      {inside && step && stepFloor && !walking && (
        <Pressable testID="next-step" style={[styles.step, { bottom: controlsBottom, left: wide ? mapLeft : 12, right: wide ? undefined : 72 }]}
                   onPress={() => dispatch({ type: 'floor', floorId: stepFloor.id })}>
          <Text style={styles.stepText}>Take {step.name ?? step.kind} to {stepFloor.name} ›</Text>
        </Pressable>
      )}
      <MapControls inside={inside} view={view} onView={setView} handle={handle} floors={floors}
                   floorId={state.floorId} onFloor={(floorId) => dispatch({ type: 'floor', floorId })}
                   onBuilding={() => dispatch({ type: 'back' })} onHere={openHere} bottom={controlsBottom} />
      {walking && (
        <WalkBanner steps={steps} index={state.walk!} left={wide ? mapLeft : 12} right={wide ? 88 : 12}
                    onNext={() => walkTo(Math.min(steps.length - 1, state.walk! + 1))}
                    onBack={() => walkTo(Math.max(0, state.walk! - 1))} onStop={() => walkTo(null)} />
      )}
      {talking && (
        <div className="fi fi-voice" style={{ left: wide ? mapLeft + (window.width - mapLeft - 72) / 2 : '50%', top: wide ? 40 : 150 }}
             data-testid="voice-orb">
          <OrbMark size={140} mode={voice.mic === 'listening' ? 'listen' : voice.mic === 'speaking' ? 'speak' : 'think'} />
          <span>{VOICE_LINE[voice.mic]}</span>
        </div>
      )}
      {toast && <div className="fi fi-toast" style={{ bottom: controlsBottom + 4 }} role="status" data-testid="toast">{toast}</div>}
      <Intro />
      {loadFailed && (
        <View style={styles.failed}>
          <Text style={styles.failedText} testID="error">{state.error}</Text>
          <Pressable testID="retry" onPress={retry} style={styles.retry}>
            <Text style={styles.stepText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const COLUMN_PX = 400; // FINNI's column on laptops: the search card and the answer under it
const SESSION_WAIT_MS = 8000; // a question asked while the building still loads waits this long
const DONE_MS = 1300; // the orb stays green this long after an answer
const VOICE_LINE = { off: '', listening: "Listening… pause when you're done", thinking: 'Thinking…', speaking: 'Speaking… tap the mic to interrupt' };

/** The value once it's there (polled), or null after a while. */
async function until<T>(get: () => T | null, timeoutMs = 20000): Promise<T | null> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    const value = get();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return get();
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.background, overflow: 'hidden' },
  map: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  title: { fontSize: 18, fontWeight: '700', color: colours.text },
  step: { position: 'absolute', backgroundColor: colours.accent, borderRadius: 22, paddingHorizontal: 18, paddingVertical: 12,
          shadowColor: colours.accent, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  stepText: { color: '#FFFFFF', fontWeight: '700' },
  failed: { position: 'absolute', top: '40%', left: 24, right: 24, alignItems: 'center', gap: 12 },
  failedText: { color: colours.error, textAlign: 'center' },
  retry: { backgroundColor: colours.accent, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 },
});
