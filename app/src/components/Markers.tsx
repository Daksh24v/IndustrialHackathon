/** The two map markers, shared by the 3D and the 2D view: where you are (an orange disc lying on the floor
 * with a ring that keeps spreading out, like a beacon) and where you're going (a pin standing on the floor);
 * and the marks for the building's edits. */
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Circle, Ellipse, G, Line, Path, Text as SvgText } from 'react-native-svg';

import type { Point } from '../api';
import type { FloorChanges } from '../changes';
import type { MarkKind, SafetyMark } from '../safety';
import { colours, map as mapColours } from '../theme';

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
      <Ellipse cx={x} cy={y + radius * 0.25} rx={radius * 1.1} ry={radius * 1.1 * flatten} fill="rgba(0,0,0,0.12)" />
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
      <Ellipse cx={x} cy={y} rx={r * 0.9} ry={r * 0.9 * flatten} fill="rgba(0,0,0,0.16)" />
      <Path d={d} fill={colours.accent} stroke="#FFFFFF" strokeWidth={1.5} strokeLinejoin="round" />
      <Circle cx={x} cy={cy} r={r * 0.42} fill="#FFFFFF" />
    </G>
  );
}

interface HaloProps {
  x: number;
  y: number;
  size: number;
  weight: '600' | '700';
  colour: string;
  fontFamily?: string;
  text: string;
}

/** Text with an outline in the map's background, readable on top of anything. */
function Halo({ x, y, size, weight, colour, fontFamily, text }: HaloProps) {
  const common = { x, y, fontSize: size, fontWeight: weight, fontFamily, textAnchor: 'middle' as const };
  return (
    <>
      <SvgText {...common} fill={mapColours.background} stroke={mapColours.background} strokeWidth={3} strokeLinejoin="round">
        {text}
      </SvgText>
      <SvgText {...common} fill={colour}>{text}</SvgText>
    </>
  );
}

interface ChangeMarksProps {
  changes: FloorChanges;
  project: (p: Point) => Point; // plan metres to the screen
  visible?: (p: Point) => boolean; // e.g. not behind the 3D camera
  fontFamily?: string;
}

/** The building's edits on top of a floor: a red bar across a closed door, a green bar in a new door's gap, a
 * red label on a closed lift or staircase, a small blue marker where a thing was moved to. */
export function ChangeMarks({ changes, project, visible = () => true, fontFamily }: ChangeMarksProps) {
  return (
    <G testID="changes">
      {changes.doors.filter((door) => visible(door.a) && visible(door.b)).map((door) => {
        const [ax, ay] = project(door.a);
        const [bx, by] = project(door.b);
        const colour = door.kind === 'closed' ? colours.closed : colours.added;
        return (
          <G key={`door-${door.id}`} testID={door.kind === 'closed' ? 'closed-door' : 'new-door'}>
            <Line x1={ax} y1={ay} x2={bx} y2={by} stroke={mapColours.background} strokeWidth={8} strokeLinecap="round" />
            <Line x1={ax} y1={ay} x2={bx} y2={by} stroke={colour} strokeWidth={4.5} strokeLinecap="round" />
          </G>
        );
      })}
      {changes.labels.filter((label) => visible(label.at)).map((label) => {
        const [x, y] = project(label.at);
        return (
          <G key={`closed-${label.id}`} testID="closed-label">
            <Halo x={x} y={y - 8} size={12} weight="700" colour={colours.closed} fontFamily={fontFamily} text={label.text} />
          </G>
        );
      })}
      {changes.moved.filter((thing) => visible(thing.at)).map((thing) => {
        const [x, y] = project(thing.at);
        return (
          <G key={`moved-${thing.id}`} testID="moved-thing">
            <Path d={`M${x} ${y - 7} L${x + 7} ${y} L${x} ${y + 7} L${x - 7} ${y} Z`} fill={colours.moved} stroke="#FFFFFF"
                  strokeWidth={2} />
            <Halo x={x} y={y - 11} size={11} weight="600" colour={colours.moved} fontFamily={fontFamily} text={thing.label} />
          </G>
        );
      })}
    </G>
  );
}

const SAFETY_COLOUR: Record<MarkKind, string> = {
  fire_extinguisher: '#E53935',
  defibrillator: '#16A34A',
  eyewash_station: '#0EA5A4',
  exit: '#16A34A',
  stairs: '#22C55E',
};

/** Safety mode: a round badge per safety thing (a flame for an extinguisher, a cross for a defibrillator, a drop
 * for an eyewash station), a green EXIT tag on entrances and a stairs badge on the escape stairs. */
export function SafetyMarks({ marks, project, visible = () => true, fontFamily, size = 1 }: {
  marks: SafetyMark[];
  project: (p: Point) => Point;
  visible?: (p: Point) => boolean;
  fontFamily?: string;
  size?: number; // 1 on a floor, smaller on the floor stack
}) {
  return (
    <G testID="safety-marks">
      {marks.filter((mark) => visible(mark.at)).map((mark) => {
        const [x, y] = project(mark.at);
        const colour = SAFETY_COLOUR[mark.kind];
        const r = 10 * size;
        if (mark.kind === 'exit') {
          const w = 34 * size;
          const h = 16 * size;
          return (
            <G key={mark.id} testID="safety-exit">
              <Path d={`M${x - w / 2} ${y - h / 2} h${w} v${h} h${-w} Z`} fill={colour} stroke="#FFFFFF" strokeWidth={1.5} />
              <SvgText x={x} y={y + 4 * size} fontSize={10 * size} fontWeight="800" fontFamily={fontFamily} fill="#FFFFFF"
                       textAnchor="middle">EXIT</SvgText>
            </G>
          );
        }
        const icon =
          mark.kind === 'fire_extinguisher'
            ? `M${x} ${y - 6 * size} C${x + 5 * size} ${y - 1 * size} ${x + 4 * size} ${y + 6 * size} ${x} ${y + 6 * size} C${x - 4 * size} ${y + 6 * size} ${x - 5 * size} ${y} ${x - 1 * size} ${y - 3 * size} C${x - 1 * size} ${y} ${x + 1 * size} ${y + 1 * size} ${x} ${y - 6 * size} Z`
            : mark.kind === 'eyewash_station'
              ? `M${x} ${y - 6 * size} C${x + 5 * size} ${y} ${x + 5 * size} ${y + 6 * size} ${x} ${y + 6 * size} C${x - 5 * size} ${y + 6 * size} ${x - 5 * size} ${y} ${x} ${y - 6 * size} Z`
              : mark.kind === 'stairs'
                ? `M${x - 6 * size} ${y + 5 * size} h${4 * size} v${-4 * size} h${4 * size} v${-4 * size} h${4 * size}`
                : `M${x - 2 * size} ${y - 6 * size} h${4 * size} v${4 * size} h${4 * size} v${4 * size} h${-4 * size} v${4 * size} h${-4 * size} v${-4 * size} h${-4 * size} v${-4 * size} h${4 * size} Z`;
        return (
          <G key={mark.id} testID={`safety-${mark.kind}`}>
            <Circle cx={x} cy={y} r={r + 3 * size} fill={colour} fillOpacity={0.25} />
            <Circle cx={x} cy={y} r={r} fill={colour} stroke="#FFFFFF" strokeWidth={1.5} />
            {mark.kind === 'stairs' ? (
              <Path d={icon} stroke="#FFFFFF" strokeWidth={1.8 * size} fill="none" strokeLinejoin="round" />
            ) : (
              <Path d={icon} fill="#FFFFFF" />
            )}
          </G>
        );
      })}
    </G>
  );
}
