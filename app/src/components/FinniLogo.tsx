/** Placeholder logo: swap this file for the real one (keep the export and the height). */
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colours } from '../theme';

export function FinniLogo({ height = 30 }: { height?: number }) {
  return (
    <View style={styles.row} testID="finni-logo" accessibilityLabel="Finni">
      <Svg width={height} height={height} viewBox="0 0 32 32">
        <Path d="M16 30c-1-3-9-10-9-17a9 9 0 0 1 18 0c0 7-8 14-9 17z" fill={colours.accent} />
        <Circle cx={16} cy={13} r={3.6} fill="#FFFFFF" />
      </Svg>
      <Text style={[styles.word, { fontSize: height * 0.8, lineHeight: height }]}>finni</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  word: { fontWeight: '800', color: colours.text, letterSpacing: -0.5 },
});
