/** The two map markers, shared by the 3D and the 2D view: where you are (an orange disc lying on the floor
 * with a ring that keeps spreading out, like a beacon) and where you're going (a pin standing on the floor). */
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Ellipse, G, Path, Circle } from 'react-native-svg';

import { colours } from '../theme';

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

/** 0 → 1 over and over (the ring spreading out; route arrows flowing). */
export function useLoop(duration: number) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(value, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [value, duration]);
  return value;
}

interface HereProps {
  x: number;
  y: number;
  radius: number; // the disc, in pixels
  flatten?: number; // height / width of the ellipse: how much the floor is tilted (1 = seen from above)
}

export function HereMarker({ x, y, radius, flatten = 1 }: HereProps) {
  const pulse = useLoop(1800);
  const ring = pulse.interpolate({ inputRange: [0, 1], outputRange: [radius * 1.2, radius * 3.6] });
  const ringY = pulse.interpolate({ inputRange: [0, 1], outputRange: [radius * 1.2 * flatten, radius * 3.6 * flatten] });
  const fade = pulse.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.6, 0] });
  return (
    <G testID="you-are-here">
      <Ellipse cx={x} cy={y} rx={radius * 2.3} ry={radius * 2.3 * flatten} fill={colours.accentFaint} />
      <AnimatedEllipse cx={x} cy={y} rx={ring} ry={ringY} fill="none" stroke={colours.accent} strokeWidth={2}
                       opacity={fade} />
      <Ellipse cx={x} cy={y + radius * 0.25} rx={radius * 1.1} ry={radius * 1.1 * flatten} fill="rgba(0,0,0,0.45)" />
      <Ellipse cx={x} cy={y} rx={radius} ry={radius * flatten} fill={colours.accent} stroke="#FFFFFF" strokeWidth={2.5} />
    </G>
  );
}

interface PinProps {
  x: number; // where the tip touches the floor
  y: number;
  height: number; // pixels
  flatten?: number;
}

export function TargetPin({ x, y, height, flatten = 0.45 }: PinProps) {
  const r = height * 0.36;
  const cy = y - height + r;
  const d = `M${x} ${y} L${x - r * 0.92} ${cy + r * 0.39} A${r} ${r} 0 1 1 ${x + r * 0.92} ${cy + r * 0.39} Z`;
  return (
    <G testID="target-pin">
      <Ellipse cx={x} cy={y} rx={r * 0.9} ry={r * 0.9 * flatten} fill="rgba(0,0,0,0.5)" />
      <Path d={d} fill={colours.accent} stroke="#FFFFFF" strokeWidth={1.5} strokeLinejoin="round" />
      <Circle cx={x} cy={cy} r={r * 0.42} fill="#FFFFFF" />
    </G>
  );
}
