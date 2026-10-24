import { StatusBar } from 'expo-status-bar';
import { Component, type ReactNode, useCallback, useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, pickBuilding } from './src/api';
import { BuildingBlocks } from './src/components/BuildingBlocks';
import { ChatSheet } from './src/components/ChatSheet';
import { FloorPlan } from './src/components/FloorPlan';
import { initial, nextStep, reduce } from './src/state';
import { colours } from './src/theme';

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
        <Pressable onPress={() => this.setState({ error: null })} style={styles.step}>
          <Text style={styles.stepText}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Guide />
    </ErrorBoundary>
  );
}

function Guide() {
  const [state, dispatch] = useReducer(reduce, initial);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    (async () => {
      try {
        const id = pickBuilding((await api.buildings()).map((row) => row.id));
        if (!id) throw new ApiError('The server has no buildings.', 0);
        const [detail, outline, session] = await Promise.all([api.building(id), api.outline(id), api.startSession(id)]);
        dispatch({ type: 'loaded', detail, outline, sessionId: session.session_id });
      } catch (error) {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    })();
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!state.sessionId) return;
      dispatch({ type: 'send', text });
      try {
        dispatch({ type: 'reply', reply: await api.chat(state.sessionId, text) });
      } catch (error) {
        dispatch({ type: 'error', message: (error as Error).message });
      }
    },
    [state.sessionId],
  );

  const floors = [...(state.detail?.floors ?? [])].sort((a, b) => a.level - b.level);
  const floorName = floors.find((floor) => floor.id === state.floorId)?.name;
  const step = nextStep(state.map, state.floorId);
  const stepFloor = floors.find((floor) => floor.id === step?.to_floor_id);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        {state.view === 'floor' || state.view === 'flying' ? (
          <Pressable testID="back" onPress={() => dispatch({ type: 'back' })} style={styles.back}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{state.detail?.building.name ?? 'Talk to your building'}</Text>
          {floorName && state.view === 'floor' ? <Text style={styles.subtitle}>{floorName}</Text> : null}
        </View>
      </View>
      {state.error ? <Text testID="error" style={styles.error}>{state.error}</Text> : null}

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
        {state.detail && state.floorId && state.view === 'floor' && size.width > 0 ? (
          <FloorPlan detail={state.detail} floorId={state.floorId} map={state.map} width={size.width} height={size.height} />
        ) : null}

        {state.view === 'floor' && floors.length > 1 ? (
          <View style={styles.floors}>
            {[...floors].reverse().map((floor) => (
              <Pressable key={floor.id} testID={`floor-${floor.level}`} onPress={() => dispatch({ type: 'floor', floorId: floor.id })}
                         style={[styles.floorChip, floor.id === state.floorId && styles.floorChipActive]}>
                <Text style={[styles.floorText, floor.id === state.floorId && styles.floorTextActive]}>
                  {floor.level === 0 ? 'G' : floor.level}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {state.view === 'floor' && step && stepFloor ? (
          <Pressable testID="next-step" style={styles.step} onPress={() => dispatch({ type: 'floor', floorId: stepFloor.id })}>
            <Text style={styles.stepText}>Take {step.name ?? step.kind} to {stepFloor.name} ›</Text>
          </Pressable>
        ) : null}
        {state.map?.route && state.view === 'floor' ? (
          <View style={styles.distance}><Text style={styles.distanceText}>{Math.round(state.map.route.length_m)} m</Text></View>
        ) : null}
      </View>

      <ChatSheet messages={state.messages} question={state.question} busy={state.busy} onSend={send} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, gap: 8 },
  back: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 30, color: colours.text, marginTop: -4 },
  title: { fontSize: 18, fontWeight: '700', color: colours.text },
  subtitle: { fontSize: 13, color: colours.muted },
  error: { marginHorizontal: 16, marginBottom: 6, color: colours.error },
  map: { flex: 1 },
  floors: { position: 'absolute', left: 12, top: 12, gap: 6 },
  floorChip: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
               backgroundColor: colours.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge },
  floorChipActive: { backgroundColor: colours.accent, borderColor: colours.accent },
  floorText: { color: colours.text, fontWeight: '600' },
  floorTextActive: { color: '#FFFFFF' },
  step: { position: 'absolute', alignSelf: 'center', bottom: 16, backgroundColor: colours.accent, borderRadius: 20,
          paddingHorizontal: 16, paddingVertical: 10 },
  stepText: { color: '#FFFFFF', fontWeight: '600' },
  distance: { position: 'absolute', right: 12, bottom: 68, backgroundColor: colours.background, borderRadius: 14,
              paddingHorizontal: 10, paddingVertical: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge },
  distanceText: { color: colours.accent, fontWeight: '700' },
});
