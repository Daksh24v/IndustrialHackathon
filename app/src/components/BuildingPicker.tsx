/** Which building to talk about: the open building's name as a button; it opens a list of every building the
 * server knows, with a search box, grouped by where the building comes from. */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { BuildingRow } from '../api';
import { colours } from '../theme';

const SOURCES: Record<string, string> = {
  sunday: 'New buildings',
  procedural: 'Factories and campuses',
  osm_indoor: 'OpenStreetMap',
  swiss_dwellings: 'Swiss Dwellings',
  resplan: 'ResPlan homes',
};

export interface Group {
  title: string;
  rows: BuildingRow[];
}

/** The buildings matching a search (name or id), grouped by source; buildings dropped into data/sunday first. */
export function groupBuildings(rows: BuildingRow[], query: string): Group[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, BuildingRow[]>();
  for (const row of rows) {
    const text = `${row.name ?? ''} ${row.id}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    const key = row.split === 'sunday' ? 'sunday' : row.source ?? row.split;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const order = Object.keys(SOURCES);
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, list]) => ({
      title: SOURCES[key] ?? key,
      rows: list.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
    }));
}

interface Props {
  buildings: BuildingRow[];
  current: { id: string; name: string } | null;
  onPick: (id: string) => void;
}

export function BuildingPicker({ buildings, current, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const groups = open ? groupBuildings(buildings, query) : [];
  const pick = (id: string) => {
    setOpen(false);
    setQuery('');
    if (id !== current?.id) onPick(id);
  };

  return (
    <View style={styles.wrap}>
      <Pressable testID="building-picker" accessibilityLabel="Choose a building" style={styles.button}
                 onPress={() => setOpen(!open)} disabled={!buildings.length}>
        <Text style={styles.name} numberOfLines={1}>{current?.name ?? 'Choose a building'}</Text>
        <Text style={styles.caret}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open && (
        <View style={styles.menu} testID="building-menu">
          <TextInput testID="building-search" style={styles.search} placeholder="Search buildings…"
                     placeholderTextColor={colours.muted} value={query} onChangeText={setQuery} autoFocus
                     onSubmitEditing={() => groups[0]?.rows[0] && pick(groups[0].rows[0].id)} />
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {groups.map((group) => (
              <View key={group.title}>
                <Text style={styles.group}>{group.title} · {group.rows.length}</Text>
                {group.rows.map((row) => (
                  <Pressable key={row.id} testID={`building-${row.id}`} onPress={() => pick(row.id)}
                             style={[styles.row, row.id === current?.id && styles.rowActive]}>
                    <Text style={styles.rowName} numberOfLines={1}>{row.name ?? row.id}</Text>
                    <Text style={styles.rowId} numberOfLines={1}>{row.id}</Text>
                  </Pressable>
                ))}
              </View>
            ))}
            {!groups.length && <Text style={styles.none}>No building matches “{query}”.</Text>}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, zIndex: 10 },
  button: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '100%', gap: 4,
            backgroundColor: colours.chip, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  name: { color: colours.text, fontWeight: '600', fontSize: 13, flexShrink: 1 },
  caret: { color: colours.muted, fontSize: 11 },
  menu: { position: 'absolute', top: 34, left: 0, width: 320, maxWidth: '100%', backgroundColor: colours.background,
          borderRadius: 14, borderWidth: 1, borderColor: '#ECECEC', padding: 8,
          shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  search: { borderRadius: 10, backgroundColor: colours.chip, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14,
            color: colours.text, marginBottom: 6 },
  list: { maxHeight: 360 },
  group: { color: colours.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginTop: 8,
           marginBottom: 2, marginHorizontal: 6 },
  row: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 },
  rowActive: { backgroundColor: colours.accentFaint },
  rowName: { color: colours.text, fontSize: 14 },
  rowId: { color: colours.muted, fontSize: 11 },
  none: { color: colours.muted, padding: 8 },
});
