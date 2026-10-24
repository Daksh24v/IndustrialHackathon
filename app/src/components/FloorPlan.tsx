/** One floor seen from straight above (the 2D view): white rooms, thin walls, labels that size with the zoom;
 * you as an orange disc with a spreading ring, the route as an orange line that draws itself in, the target as
 * a pin. Drag to move, pinch or +/− to zoom; the plan redraws itself sharp at every zoom. */
import { type ComponentRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import Svg, { G, Path, Text as SvgText } from 'react-native-svg';

import type { BuildingDetail, MapView, Point } from '../api';
import {
  boundsOf, fit, grow, linePath, lineLength, moveTransform, polygonPath, toScreen, toWorld, type Transform,
} from '../geometry';
import { useMapGestures } from '../gestures';
import { colours, spaceFill } from '../theme';
import { LABEL_FONT, styles } from './FloorScene';
import { HereMarker, TargetPin } from './Markers';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const FOCUS_MARGIN_M = 8;
const MIN_LABEL_PX = 30; // rooms smaller than this on screen get no label
const MARGIN_PX = 120;

interface Props {
  detail: BuildingDetail;
  floorId: string;
  map: MapView | null;
  width: number;
  height: number;
  /** A tap on the floor: where on it (metres), e.g. to say "I'm here". */
  onTapFloor?: (floorId: string, point: Point) => void;
}

export function FloorPlan({ detail, floorId, map, width, height, onTapFloor }: Props) {
  const spaces = useMemo(() => detail.spaces.filter((space) => space.floor_id === floorId), [detail, floorId]);
  const pieces = useMemo(
    () => (map?.route?.pieces ?? []).filter((piece) => piece.floor_id === floorId),
    [map, floorId],
  );
  const here = map?.you_are_here?.floor_id === floorId ? map.you_are_here : null;
  const target = map?.target?.floor_id === floorId ? map.target : null;

  // Fit to what matters: the route and the two places if there are any, else the whole floor.
  const fitted = useMemo(() => {
    const focus: Point[] = [...pieces.flatMap((piece) => piece.points)];
    if (here) focus.push(here.position);
    if (target) focus.push(target.position);
    const bounds = focus.length
      ? grow(boundsOf(focus), FOCUS_MARGIN_M)
      : grow(boundsOf(spaces.flatMap((space) => space.polygon)), 2);
    return fit(bounds, width, height, 24);
  }, [pieces, here, target, spaces, width, height]);
  const [transform, setTransform] = useState<Transform>(fitted);
  useEffect(() => setTransform(fitted), [fitted]);
  const frame = useRef<ComponentRef<typeof View>>(null);
  const shown = useRef(transform);
  useLayoutEffect(() => {
    shown.current = transform;
  }, [transform]);
  const tapped = onTapFloor
    ? ([pageX, pageY]: [number, number]) =>
        frame.current?.measureInWindow((left, top) =>
          onTapFloor(floorId, toWorld(shown.current, [pageX - left, pageY - top])))
    : undefined;
  const gestures = useMapGestures(width, height, ({ k, tx, ty }) =>
    setTransform((current) => moveTransform(current, k, tx, ty, width, height)), tapped);
  const zoomBy = (k: number) => setTransform((current) => moveTransform(current, k, 0, 0, width, height));

  // The route draws itself in.
  const draw = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    draw.setValue(0);
    Animated.timing(draw, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [draw, pieces]);

  const routeLengthPx = pieces.reduce((sum, piece) => sum + lineLength(piece.points) * transform.scale, 0) || 1;
  const dashOffset = draw.interpolate({ inputRange: [0, 1], outputRange: [routeLengthPx, 0] });
  const wall = Math.min(1.4, Math.max(0.5, transform.scale * 0.09));
  const herePx = here ? toScreen(transform, here.position) : null;
  const targetPx = target ? toScreen(transform, target.position) : null;

  return (
    <View ref={frame} style={[styles.frame, { width, height }]} testID="floor-plan">
      <Animated.View {...gestures.panHandlers} style={[{ width, height }, gestures.style]}>
        <Svg width={width + 2 * MARGIN_PX} height={height + 2 * MARGIN_PX} style={{ position: 'absolute', left: -MARGIN_PX, top: -MARGIN_PX }}>
          <G transform={`translate(${MARGIN_PX} ${MARGIN_PX})`}>
            {spaces.map((space) => (
              <Path key={space.id} d={polygonPath(transform, space.polygon)} fill={spaceFill[space.type] ?? colours.room}
                    stroke={colours.wall} strokeWidth={wall} />
            ))}
            {spaces.map((space) => {
              const side = Math.sqrt(space.area_m2) * transform.scale;
              if (side < MIN_LABEL_PX || space.type === 'outdoor') return null;
              const [cx, cy] = toScreen(transform, space.anchor);
              const size = Math.min(13, Math.max(8.5, transform.scale * 0.9));
              return (
                <SvgText key={`${space.id}-label`} x={cx} y={cy + size / 3} fill={colours.label} fontSize={size}
                         fontFamily={LABEL_FONT} textAnchor="middle">
                  {side > 110 || !space.ref ? space.name : space.ref}
                </SvgText>
              );
            })}
            {pieces.map((piece, index) => (
              <G key={`route-${index}`}>
                <Path d={linePath(transform, piece.points)} stroke={colours.accentFaint} strokeWidth={14}
                      strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <AnimatedPath
                  testID="route-line"
                  d={linePath(transform, piece.points)}
                  stroke={colours.accent}
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  strokeDasharray={[routeLengthPx, routeLengthPx]}
                  strokeDashoffset={dashOffset}
                />
              </G>
            ))}
            {targetPx && <TargetPin x={targetPx[0]} y={targetPx[1]} height={34} />}
            {herePx && <HereMarker x={herePx[0]} y={herePx[1]} radius={8} />}
          </G>
        </Svg>
      </Animated.View>
      <View style={styles.controls}>
        <Pressable testID="zoom-in" accessibilityLabel="Zoom in" style={styles.button} onPress={() => zoomBy(1.5)}>
          <Text style={styles.buttonText}>+</Text>
        </Pressable>
        <Pressable testID="zoom-out" accessibilityLabel="Zoom out" style={styles.button} onPress={() => zoomBy(1 / 1.5)}>
          <Text style={styles.buttonText}>−</Text>
        </Pressable>
      </View>
    </View>
  );
}
