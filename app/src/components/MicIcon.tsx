/** A microphone, drawn (no emoji), in Finni orange. */
import Svg, { Path, Rect } from 'react-native-svg';

import { colours } from '../theme';

export function MicIcon({ size = 22, colour = colours.accent }: { size?: number; colour?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={8.5} y={2.5} width={7} height={12} rx={3.5} fill={colour} />
      <Path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" stroke={colour} strokeWidth={2} strokeLinecap="round" />
      <Path d="M12 18v3.5M8.5 21.5h7" stroke={colour} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}
