/** Ask / Map: the one way to move between the orb and the map, always in the same top corner. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colours } from '../theme';

export type Mode = 'home' | 'map';

interface Props {
  mode: Mode;
  onChange: (mode: Mode) => void;
  mapReady: boolean; // the building is loaded
}

export function ModeSwitch({ mode, onChange, mapReady }: Props) {
  const item = (value: Mode, label: string, testID: string, disabled = false) => {
    const active = mode === value;
    return (
      <Pressable testID={testID} accessibilityRole="tab" accessibilityState={{ selected: active, disabled }}
                 accessibilityLabel={value === 'home' ? 'Ask Finni' : 'Show the map'} disabled={disabled}
                 onPress={() => !active && onChange(value)} style={[styles.item, active && styles.active]}>
        <Text style={[styles.text, active && styles.textActive, disabled && styles.disabled]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.switch} accessibilityRole="tablist" testID="mode-switch">
      {item('home', 'Ask', 'mode-ask')}
      {item('map', 'Map', 'mode-map', !mapReady)}
    </View>
  );
}

const styles = StyleSheet.create({
  switch: {
    flexDirection: 'row', backgroundColor: '#F2F2F7', borderRadius: 18, padding: 3,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge,
  },
  item: { paddingHorizontal: 14, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  active: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3,
            shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  text: { color: colours.muted, fontWeight: '700', fontSize: 13 },
  textActive: { color: colours.accent },
  disabled: { opacity: 0.4 },
});
