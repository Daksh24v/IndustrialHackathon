import { StatusBar } from 'expo-status-bar';
import { Component, type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  api, ApiError, buildingFromUrl, type BuildingRow, type Context, type MaintenanceMessage, pickBuilding, placeOf, type Point,
  type Mobility, type Report, type SafetyKind, showBuildingInUrl,
} from './src/api';
import { categories } from './src/categories';
import { withReports } from './src/changes';
import { safetyButtons } from './src/safety';
import { BuildingBlocks } from './src/components/BuildingBlocks';
import { FloorPlan } from './src/components/FloorPlan';
import { FloorScene, type Inset, TILT, TOP_TILT } from './src/components/FloorScene';
import Intro from './src/orb/Intro';
import type { SphereMode } from './src/orb/sphere';
import { chatTurn, RENEWED_NOTE } from './src/session';
import { initial, nextStep, reduce } from './src/state';
import { bare, routeSteps, summary } from './src/steps';
import { flushSync } from 'react-dom';

import { colours, isWide, map as mapColours, setTheme, startTheme, type ThemeName } from './src/theme';
import { HoverGlowButton } from './src/ui/HoverGlowButton';
import { MapControls, type MapHandle, type ViewMode } from './src/ui/MapControls';
import { mapKey } from './src/legend';
import { straightenMap, straightRoute } from './src/routeShape';
import type { WallMode } from './src/walls';
import { OrbMark } from './src/ui/OrbMark';
import { Panel, type PanelMode, sheetHeight, type Snap } from './src/ui/Panel';
import { SearchBar } from './src/ui/SearchBar';
import { switchWithTransition } from './src/ui/ThemeToggle';
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
  const [walls, setWalls] = useState<WallMode>('cutaway');
  // Dark (the digital twin) or light: the map's colours switch, the page's too (the "dark" class on <html>).
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const first = startTheme(globalThis.location?.search ?? '', savedTheme());
    setTheme(first);
    return first;
  });
  useEffect(() => {
    globalThis.document?.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  const toggleTheme = () => {
    const next: ThemeName = theme === 'dark' ? 'light' : 'dark';
    switchWithTransition(() => {
      setTheme(next);
      flushSync(() => setThemeState(next));
      document.documentElement.classList.toggle('dark', next === 'dark');
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // private window: the choice just isn't remembered
      }
    });
  };
  const [buildings, setBuildings] = useState<BuildingRow[]>([]);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [context, setContext] = useState<Context | null>(null); // the OpenStreetMap neighbourhood, if any
  const [attempt, setAttempt] = useState(0); // "Retry" after the server couldn't be reached
  const [panelOpen, setPanelOpen] = useState(false);
  const [snap, setSnap] = useState<Snap>('peek');
  const [sphere, setSphere] = useState<SphereMode>('rest');
  const [hoverStep, setHoverStep] = useState<number | null>(null);
  const [pickedStep, setPickedStep] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Broken for everyone (polled, so a colleague's report shows up too), the maintenance inbox, and safety mode.
  const [reports, setReports] = useState<Report[]>([]);
  const [emailOn, setEmailOn] = useState(false);
  const [inbox, setInbox] = useState<MaintenanceMessage[]>([]);
  const [panelMode, setPanelMode] = useState<PanelMode>('answer');
  const [safety, setSafety] = useState(false);
  const [safetyBusy, setSafetyBusy] = useState<SafetyKind | null>(null);
  // How the person moves (the chip under the search bar); the conversation's routes all fit it.
  const [mobility, setMobility] = useState<Mobility>('walk');
  const toldByFinni = useRef(false); // FINNI set it in the chat: the server has it already (with any width they gave)
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
    setContext(null);
    // The neighbourhood is a nice-to-have: without it (or when it fails) the map works the same.
    void api.context(buildingId).then((found) => mine === generation.current && setContext(found), () => {});
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
      setPanelMode('answer');
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
        void refreshReports(); // "the lift is broken" shows at once
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
  const legend = useMemo(() => mapKey(state.detail), [state.detail, theme]); // eslint-disable-line react-hooks/exhaustive-deps -- the colours follow the look
  const row = buildings.find((item) => item.id === buildingId);
  const current = state.detail?.building ?? (row ? { id: row.id, name: row.name ?? row.id } : null);
  const loadFailed = !!state.error && !state.detail;
  const retry = () => {
    dispatch({ type: 'error', message: '' });
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    if (!state.sessionId) return;
    if (toldByFinni.current) {
      toldByFinni.current = false;
      return;
    }
    api.mobility(state.sessionId, mobility).catch(() => setToast("Couldn't change how you move; try again."));
  }, [state.sessionId, mobility]);
  useEffect(() => { // "I'm driving a forklift" in the chat: the chip follows
    const said = state.map?.route?.profile?.toLowerCase() as Mobility | undefined;
    if (said && said !== mobility && ['wheelchair', 'trolley', 'forklift'].includes(said)) {
      toldByFinni.current = true;
      setMobility(said);
    }
  }, [state.map]); // eslint-disable-line react-hooks/exhaustive-deps
  const quick = useMemo(() => categories(state.detail, mobility), [state.detail, mobility]);
  const safetyChoices = useMemo(() => safetyButtons(state.detail), [state.detail]);
  // the map with reports in red, its route drawn straight down the corridors
  const drawn = useMemo(() => withReports(straightenMap(state.map, state.detail), reports), [state.map, state.detail, reports]);
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
  const highlight = useMemo(() => (lit && lit.floorId === state.floorId && lit.path.length > 1
    ? straightRoute(lit.path, (state.detail?.spaces ?? []).filter((space) => space.floor_id === lit.floorId)) : null),
  [lit, state.floorId, state.detail]);

  // The map fills the screen; FINNI's column (laptops) or bar and sheet (phones) cover part of it.
  const showPanel = panelOpen && (panelMode !== 'answer' || state.messages.length > 0 || state.busy || !!state.error)
    && !(walking && !wide);
  const sheet = showPanel && !wide ? sheetHeight(snap, window.height) : 0;
  const inset: Inset = wide
    ? { left: COLUMN_PX + 16, top: walking ? 96 : 0, right: 72, bottom: 0 }
    : { left: 0, top: walking ? 120 : inside ? 196 : 132, right: inside ? 64 : 0, bottom: sheet };
  const controlsBottom = wide ? 24 : sheet + 16;
  const phoneSheetUp = !wide && showPanel && snap !== 'peek'; // like a map app: the buttons step aside for the sheet
  const mapLeft = wide ? COLUMN_PX + 32 : 12;

  // Escape inside a floor (not while typing or walking): back out to the whole building.
  useEffect(() => {
    if (!inside || walking) return;
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (event.key === 'Escape' && tag !== 'INPUT' && tag !== 'TEXTAREA') dispatch({ type: 'back' });
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [inside, walking]);

  // Reports: polled, so what a colleague reported shows up here too; only a real change redraws the map.
  const reportsKey = useRef('');
  const refreshReports = useCallback(async () => {
    const id = buildingRef.current;
    if (!id) return;
    try {
      const got = await api.reports(id);
      const key = JSON.stringify(got.reports);
      setEmailOn(got.email);
      if (key !== reportsKey.current) {
        reportsKey.current = key;
        setReports(got.reports);
      }
    } catch {
      // the next poll tries again
    }
  }, []);
  useEffect(() => {
    reportsKey.current = '';
    setReports([]);
    if (!buildingId) return;
    void refreshReports();
    const timer = setInterval(() => void refreshReports(), REPORTS_POLL_MS);
    return () => clearInterval(timer);
  }, [buildingId, refreshReports]);
  const refreshInbox = useCallback(async () => {
    if (!buildingRef.current) return;
    try {
      setInbox((await api.maintenance(buildingRef.current)).messages);
    } catch {
      // shown next time
    }
  }, []);
  const openPanel = (mode: PanelMode) => {
    setPanelMode(mode);
    setPanelOpen(true);
    setSnap(mode === 'reports' ? 'half' : 'peek'); // the safety buttons fit the low sheet: the map stays in view
    if (mode === 'reports') void refreshInbox();
  };
  const fixed = async (elementId: string) => {
    if (!buildingId) return;
    try {
      await api.clearReport(buildingId, elementId);
    } catch (error) {
      setToast((error as Error).message);
    }
    await refreshReports();
    await refreshInbox();
  };

  // Safety mode: the map dims to exits, extinguishers, first aid and stairs; a quick button routes to the nearest.
  const toggleSafety = () => {
    const on = !safety;
    setSafety(on);
    if (on) openPanel('safety');
    else if (panelMode === 'safety') setPanelMode('answer');
  };
  const findNearest = async (kind: SafetyKind) => {
    const choice = safetyChoices.find((button) => button.kind === kind);
    if (!state.sessionId || !choice) return;
    setSafetyBusy(kind);
    try {
      const { found, map } = await api.nearest(state.sessionId, kind);
      const said = kind === 'exit'
        ? `The nearest exit is by ${bare(found.room)}, ${Math.round(found.walk_m)} m away.`
        : `${found.label} is in ${bare(found.room)}, ${Math.round(found.walk_m)} m away.`;
      dispatch({ type: 'reply', reply: { reply: said, question: null, map } });
      setPickedStep(null);
      setPanelMode('answer');
      setSnap('peek');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setToast('Tap the map where you are, or tell FINNI. Asking FINNI now…');
        void ask(choice.question); // FINNI asks where they are, once
      } else {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    } finally {
      setSafetyBusy(null);
    }
  };

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
           mode={panelMode} safetyButtons={safetyChoices} onSafety={(kind) => void findNearest(kind)} safetyBusy={safetyBusy}
           reports={reports} inbox={inbox} email={emailOn} onFixed={(id) => void fixed(id)}
           busy={state.busy} error={state.detail ? state.error : null} note={state.note}
           activeStep={hoverStep ?? shownStep} snap={snap} onSnap={setSnap}
           onOption={(label) => void ask(label)} onClose={() => {
             setPanelOpen(false);
             setPanelMode('answer');
           }}
           onStepHover={setHoverStep} onStepPick={(index) => setPickedStep(index)}
           onStart={() => walkTo(0)} />
  ) : null;
  const search = (
    <SearchBar busy={state.busy} mode={sphere} mic={voice.mic} notice={voice.notice}
               onSubmit={(text) => void ask(text)} onCancel={dropAnswer} onMic={voice.toggle}
               building={current} buildings={buildings} onPickBuilding={pickOther} categories={quick}
               reports={reports} onReports={() => openPanel('reports')}
               mobility={mobility} onMobility={setMobility} />
  );

  return (
    <View style={[styles.screen, { backgroundColor: mapColours.background }]}>
      <StatusBar style="dark" />
      <View style={[styles.map, { backgroundColor: mapColours.background }]} testID="map-layer" key={theme}>
        {state.view === 'loading' && !state.error ? <ActivityIndicator color={colours.accent} style={{ flex: 1 }} /> : null}
        {state.outline && (state.view === 'outside' || state.view === 'flying') ? (
          <BuildingBlocks
            outline={state.outline}
            context={context}
            spaces={state.detail?.spaces}
            map={drawn}
            detail={state.detail}
            safety={safety}
            focusFloorId={state.view === 'flying' ? state.floorId : null}
            leaveFloorId={state.view === 'outside' ? state.left : null}
            onArrived={() => dispatch({ type: 'arrived' })}
            onPickFloor={(floorId) => dispatch({ type: 'floor', floorId })}
            spin={state.view === 'outside' && !state.map?.route}
            width={window.width}
            height={window.height}
            inset={inset}
            handleRef={handle}
          />
        ) : null}
        {state.detail && state.floorId && inside ? (
          view !== 'plan' ? (
            <FloorScene tilt={view === 'top' ? TOP_TILT : TILT} detail={state.detail} floorId={state.floorId} map={drawn} footprints={footprints} safety={safety}
                        context={context} width={window.width} height={window.height} onTapFloor={tapHere} controls={false}
                        handleRef={handle} inset={inset} highlight={highlight} focus={focusPath} walls={walls} />
          ) : (
            <FloorPlan detail={state.detail} floorId={state.floorId} map={drawn} footprints={footprints} safety={safety}
                       width={window.width} height={window.height}
                       onTapFloor={tapHere} controls={false} handleRef={handle} inset={inset} highlight={highlight}
                       focus={focusPath} />
          )
        ) : null}
        {context?.buildings.length && (state.view !== 'floor' || view !== 'plan') ? (
          <Text style={[styles.credit, { color: mapColours.chromeMuted }]} pointerEvents="none">{context.attribution}</Text>
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

      {inside && !walking && (
        <div className="fi fi-floor" style={wide ? { left: mapLeft + (window.width - mapLeft - 72) / 2 } : { left: 12, top: 200, transform: 'none' }}>
          <HoverGlowButton className="fi-back" data-testid="building" aria-label="Back to the whole building (Escape)"
                           title="Back to the whole building (Esc)" onClick={() => dispatch({ type: 'back' })}>
            ‹ Building
          </HoverGlowButton>
          {floorName && <span data-testid="floor-name">{floorName}</span>}
        </div>
      )}
      {inside && step && stepFloor && !walking && (
        <Pressable testID="next-step" style={[styles.step, { bottom: controlsBottom, left: wide ? mapLeft : 12, right: wide ? undefined : 72 }]}
                   onPress={() => dispatch({ type: 'floor', floorId: stepFloor.id })}>
          <Text style={styles.stepText}>Take {step.name ?? step.kind} to {stepFloor.name} ›</Text>
        </Pressable>
      )}
      {!(phoneSheetUp) && <MapControls inside={inside} view={view} onView={setView} handle={handle} floors={floors}
                   floorId={state.floorId} onFloor={(floorId) => dispatch({ type: 'floor', floorId })}
                   onBuilding={() => dispatch({ type: 'back' })} onHere={openHere} bottom={controlsBottom}
                   safety={safety} onSafety={safetyChoices.length ? toggleSafety : undefined}
                   mapKey={`${state.view}:${state.floorId}:${view}:${theme}`} theme={theme} onTheme={toggleTheme}
                   compact={!wide} walls={walls}
                   onWalls={() => setWalls((now) => (now === 'cutaway' ? 'low' : now === 'low' ? 'full' : 'cutaway'))}
                   legend={legend} />}
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

const THEME_KEY = 'finni-theme';
const savedTheme = (): string | null => {
  try {
    return globalThis.localStorage?.getItem(THEME_KEY) ?? null;
  } catch {
    return null;
  }
};
const REPORTS_POLL_MS = 8000; // how soon a colleague's report shows up
const COLUMN_PX = 400; // FINNI's column on laptops: the search card and the answer under it
const SESSION_WAIT_MS = 8000; // a question asked while the building still loads waits this long
const DONE_MS = 1300; // the orb stays green this long after an answer
const VOICE_LINE = { off: '', listening: "Listening… pause when you're done", thinking: 'Thinking…', speaking: 'Speaking… talk to interrupt, tap the mic to stop' };

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
  map: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: mapColours.background },
  credit: { position: 'absolute', right: 10, bottom: 4, color: mapColours.chromeMuted, fontSize: 10 },
  title: { fontSize: 18, fontWeight: '700', color: colours.text },
  step: { position: 'absolute', backgroundColor: colours.accent, borderRadius: 22, paddingHorizontal: 18, paddingVertical: 12,
          shadowColor: colours.accent, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  stepText: { color: '#FFFFFF', fontWeight: '700' },
  failed: { position: 'absolute', top: '40%', left: 24, right: 24, alignItems: 'center', gap: 12 },
  failedText: { color: colours.error, textAlign: 'center' },
  retry: { backgroundColor: colours.accent, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 },
});
