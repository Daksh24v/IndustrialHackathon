/** One floor from above: white rooms, thin walls, small labels; the person's position as a glowing orange blur,
 * the route as an orange line that draws itself in, the target as a pin. Drag to move, +/- to zoom. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop, Text as SvgText } from 'react-native-svg';

import type { BuildingDetail, MapView, Point } from '../api';
import { boundsOf, centre, fit, grow, linePath, lineLength, polygonPath, toScreen } from '../geometry';
import { colours, spaceFill } from '../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const FOCUS_MARGIN_M = 8;
const MIN_LABEL_PX = 26; // rooms smaller than this on screen get no label

interface Props {
  detail: BuildingDetail;
  floorId: string;
  map: MapView | null;
  width: number;
  height: number;
}

export function FloorPlan({ detail, floorId, map, width, height }: Props) {
  const spaces = useMemo(() => detail.spaces.filter((space) => space.floor_id === floorId), [detail, floorId]);
  const pieces = useMemo(
    () => (map?.route?.pieces ?? []).filter((piece) => piece.floor_id === floorId),
    [map, floorId],
  );
  const here = map?.you_are_here?.floor_id === floorId ? map.you_are_here : null;
  const target = map?.target?.floor_id === floorId ? map.target : null;

  // Fit to what matters: the route and the two places if there are any, else the whole floor.
  const transform = useMemo(() => {
    const focus: Point[] = [...pieces.flatMap((piece) => piece.points)];
    if (here) focus.push(here.position);
    if (target) focus.push(target.position);
    const bounds = focus.length
      ? grow(boundsOf(focus), FOCUS_MARGIN_M)
      : grow(boundsOf(spaces.flatMap((space) => space.polygon)), 2);
    return fit(bounds, width, height, 24);
  }, [pieces, here, target, spaces, width, height]);

  // Drag and zoom (the whole drawing moves; vector graphics stay sharp).
  const [zoom, setZoom] = useState(1);
  const pan = useRef(new Animated.ValueXY()).current;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
        onPanResponderGrant: () => pan.extractOffset(),
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
        onPanResponderRelease: () => pan.flattenOffset(),
      }),
    [pan],
  );
  useEffect(() => {
    pan.setValue({ x: 0, y: 0 });
    pan.setOffset({ x: 0, y: 0 });
    setZoom(1);
  }, [floorId, map, pan]);

  // The orange blur breathes; the route draws itself in.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const draw = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    draw.setValue(0);
    Animated.timing(draw, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [draw, pieces]);

  const routeLengthPx = pieces.reduce((sum, piece) => sum + lineLength(piece.points) * transform.scale, 0) || 1;
  const dashOffset = draw.interpolate({ inputRange: [0, 1], outputRange: [routeLengthPx, 0] });
  const blurRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [16, 26] });
  const blurOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.55] });

  const herePx = here ? toScreen(transform, here.position) : null;
  const targetPx = target ? toScreen(transform, target.position) : null;

  return (
    <View style={[styles.frame, { width, height }]} testID="floor-plan">
      <Animated.View
        {...responder.panHandlers}
        style={{ width, height, transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: zoom }] }}
      >
        <Svg width={width} height={height}>
          <Defs>
            <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={colours.accent} stopOpacity={0.85} />
              <Stop offset="45%" stopColor={colours.accent} stopOpacity={0.35} />
              <Stop offset="100%" stopColor={colours.accent} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <G>
            {spaces.map((space) => (
              <Path
                key={space.id}
                d={polygonPath(transform, space.polygon)}
                fill={spaceFill[space.type] ?? colours.room}
                stroke={colours.wall}
                strokeWidth={0.8}
              />
            ))}
            {spaces.map((space) => {
              const [cx, cy] = toScreen(transform, centre(space.polygon));
              const side = Math.sqrt(space.area_m2) * transform.scale;
              if (side < MIN_LABEL_PX || space.type === 'outdoor') return null;
              return (
                <SvgText key={`${space.id}-label`} x={cx} y={cy + 3} fill={colours.label} fontSize={9}
                         textAnchor="middle">
                  {space.ref ?? space.name}
                </SvgText>
              );
            })}
          </G>
          {pieces.map((piece, index) => (
            <G key={`route-${index}`}>
              <Path d={linePath(transform, piece.points)} stroke={colours.accentFaint} strokeWidth={12}
                    strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <AnimatedPath
                testID="route-line"
                d={linePath(transform, piece.points)}
                stroke={colours.accent}
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                strokeDasharray={[routeLengthPx, routeLengthPx]}
                strokeDashoffset={dashOffset}
              />
            </G>
          ))}
          {targetPx && (
            <G testID="target-pin">
              <Circle cx={targetPx[0]} cy={targetPx[1]} r={9} fill={colours.background} stroke={colours.accent}
                      strokeWidth={3} />
              <Circle cx={targetPx[0]} cy={targetPx[1]} r={3.5} fill={colours.accent} />
            </G>
          )}
          {herePx && (
            <G testID="you-are-here">
              <AnimatedCircle cx={herePx[0]} cy={herePx[1]} r={blurRadius} fill="url(#glow)" opacity={blurOpacity} />
              <Circle cx={herePx[0]} cy={herePx[1]} r={5} fill={colours.accent} stroke={colours.background}
                      strokeWidth={2} />
            </G>
          )}
        </Svg>
      </Animated.View>
      <View style={styles.zoom}>
        <Pressable accessibilityLabel="Zoom in" style={styles.zoomButton} onPress={() => setZoom((z) => Math.min(z * 1.5, 8))}>
          <Text style={styles.zoomText}>+</Text>
        </Pressable>
        <Pressable accessibilityLabel="Zoom out" style={styles.zoomButton} onPress={() => setZoom((z) => Math.max(z / 1.5, 0.5))}>
          <Text style={styles.zoomText}>−</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colours.background },
  zoom: { position: 'absolute', right: 12, top: 12, gap: 8 },
  zoomButton: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colours.background, alignItems: 'center',
    justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge,
  },
  zoomText: { fontSize: 20, color: colours.text },
});
