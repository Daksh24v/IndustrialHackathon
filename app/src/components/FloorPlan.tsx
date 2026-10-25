/** One floor seen from straight above (the 2D view): rooms tinted by what they're for, things in them as small
 * rectangles, thin walls, labels that size with the zoom;
 * you as an orange disc with a spreading ring, the route as an orange line that draws itself in, the target as
 * a pin. Drag to move, pinch or +/− to zoom; the plan redraws itself sharp at every zoom. */
import { type ComponentRef, type MutableRefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import Svg, { G, Path, Text as SvgText } from 'react-native-svg';

import type { BuildingDetail, MapView, Point } from '../api';
import { assetsOn, changesOn } from '../changes';
import {
  assetRect, boundsOf, fit, grow, linePath, lineLength, moveTransform, polygonPath, toScreen, toWorld, type Transform,
} from '../geometry';
import { useMapGestures } from '../gestures';
import { assetStyle, colours, map as mapColours, roomStyle } from '../theme';
import type { MapHandle } from '../ui/MapControls';
import { atLeast, type Inset, LABEL_FONT, NO_INSET, SAFETY_DIM, styles } from './FloorScene';
import { safetyMarks } from '../safety';
import { routeSpaces } from '../steps';
import { ChangeMarks, HereMarker, SafetyMarks, TargetPin } from './Markers';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const FOCUS_MARGIN_M = 8;
const MIN_LABEL_PX = 30; // rooms smaller than this on screen get no label
const MARGIN_PX = 120;
const MIN_ASSET_PX = 3;

interface Props {
  detail: BuildingDetail;
  floorId: string;
  map: MapView | null;
  width: number;
  height: number;
  /** A tap on the floor: where on it (metres), e.g. to say "I'm here". */
  onTapFloor?: (floorId: string, point: Point) => void;
  controls?: boolean;
  handleRef?: MutableRefObject<MapHandle | null>;
  inset?: Inset;
  highlight?: Point[] | null;
  focus?: Point[] | null;
  safety?: boolean;
}

/** A plan fitted into the uncovered part of the screen. */
function fitInside(bounds: Parameters<typeof fit>[0], width: number, height: number, inset: Inset): Transform {
  const t = fit(bounds, width - inset.left - inset.right, height - inset.top - inset.bottom, 24);
  return { ...t, offsetX: t.offsetX + inset.left, offsetY: t.offsetY + inset.top };
}

export function FloorPlan({ detail, floorId, map, width, height, onTapFloor, controls = true, handleRef, inset = NO_INSET,
                            highlight, focus, safety = false }: Props) {
  const marks = useMemo(() => (safety ? safetyMarks(detail, floorId) : []), [safety, detail, floorId]);
  const dim = safety ? SAFETY_DIM : 1;
  const onWay = useMemo(() => routeSpaces(map, detail), [map, detail]); // the rooms the route passes
  const spaces = useMemo(() => detail.spaces.filter((space) => space.floor_id === floorId), [detail, floorId]);
  const pieces = useMemo(
    () => (map?.route?.pieces ?? []).filter((piece) => piece.floor_id === floorId),
    [map, floorId],
  );
  const here = map?.you_are_here?.floor_id === floorId ? map.you_are_here : null;
  const target = map?.target?.floor_id === floorId ? map.target : null;
  const changes = useMemo(() => changesOn(detail, map, floorId), [detail, map, floorId]);
  const assets = useMemo(() => assetsOn(detail, map, floorId), [detail, map, floorId]);

  // Fit to what matters: the route and the two places if there are any, else the whole floor.
  const fitted = useMemo(() => {
    const focus: Point[] = [...pieces.flatMap((piece) => piece.points)];
    if (here) focus.push(here.position);
    if (target) focus.push(target.position);
    const bounds = focus.length
      ? grow(boundsOf(focus), FOCUS_MARGIN_M)
      : grow(boundsOf(spaces.flatMap((space) => space.polygon)), 2);
    return fitInside(bounds, width, height, inset);
  }, [pieces, here, target, spaces, width, height, inset.left, inset.top, inset.right, inset.bottom]);
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
    setTransform((current) => moveTransform(current, k, tx, ty, width, height)), tapped, frame);
  const zoomBy = (k: number) => setTransform((current) => moveTransform(current, k, 0, 0, width, height));
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  useEffect(() => {
    if (!handleRef) return;
    const mine: MapHandle = { zoomBy: (k) => zoomRef.current(k), north: () => {} }; // the plan is always north up
    handleRef.current = mine;
    return () => {
      if (handleRef.current === mine) handleRef.current = null;
    };
  }, [handleRef]);
  useEffect(() => {
    if (focus?.length) setTransform(fitInside(atLeast(grow(boundsOf(focus), 4), 10), width, height, inset));
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps -- a new stretch only

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
    <View ref={frame} style={[styles.frame, { width, height, backgroundColor: mapColours.background }]} testID="floor-plan">
      <Animated.View {...gestures.panHandlers} style={[{ width, height }, gestures.style]}>
        <Svg width={width + 2 * MARGIN_PX} height={height + 2 * MARGIN_PX} style={{ position: 'absolute', left: -MARGIN_PX, top: -MARGIN_PX }}>
          <G transform={`translate(${MARGIN_PX} ${MARGIN_PX})`}>
            <G opacity={dim}>
            {spaces.map((space) => {
              const style = roomStyle(space);
              return (
                <G key={space.id}>
                  <Path d={polygonPath(transform, space.polygon)} fill={style.fill} stroke={mapColours.wall2d} strokeWidth={wall * 2} />
                  <Path d={polygonPath(transform, space.polygon)} fill="none" stroke={style.edge} strokeOpacity={0.6}
                        strokeWidth={Math.max(0.5, wall * 0.6)} />
                </G>
              );
            })}
            {assets.filter((asset) => Math.min(asset.footprint.width_m, asset.footprint.depth_m) * transform.scale >= MIN_ASSET_PX)
              .map((asset) => {
                const style = assetStyle(asset.category ?? '');
                const isTarget = map?.target?.asset_id === asset.id;
                return (
                  <Path key={asset.id} d={polygonPath(transform, assetRect(asset.position, asset.footprint))}
                        fill={isTarget ? colours.accent : style.top} stroke={isTarget ? '#FFFFFF' : style.edge}
                        strokeWidth={isTarget ? 1.5 : 0.6} opacity={pieces.length && !onWay.has(asset.space_id) ? 0.28 : 1} />
                );
              })}
            {spaces.filter((space) => changes.closedSpaces.has(space.id)).map((space) => (
              <Path key={`closed-${space.id}`} testID="closed-space" d={polygonPath(transform, space.polygon)}
                    fill={mapColours.closedFaint} stroke={colours.closed} strokeWidth={1.5} />
            ))}
            {spaces.map((space) => {
              const side = Math.sqrt(space.area_m2) * transform.scale;
              if (side < MIN_LABEL_PX || space.type === 'outdoor') return null;
              const [cx, cy] = toScreen(transform, space.anchor);
              const size = Math.min(13, Math.max(8.5, transform.scale * 0.9));
              return (
                <SvgText key={`${space.id}-label`} x={cx} y={cy + size / 3} fill={mapColours.label} fontSize={size}
                         fontFamily={LABEL_FONT} textAnchor="middle">
                  {side > 110 || !space.ref ? space.name : space.ref}
                </SvgText>
              );
            })}
            </G>
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
            {highlight && highlight.length > 1 && (
              <Path d={linePath(transform, highlight)} stroke="#B54F00" strokeOpacity={0.6} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round"
                    fill="none" testID="route-highlight" />
            )}
            <ChangeMarks changes={changes} project={(p) => toScreen(transform, p)} fontFamily={LABEL_FONT} />
            {safety && <SafetyMarks marks={marks} project={(p) => toScreen(transform, p)} fontFamily={LABEL_FONT} />}
            {targetPx && <TargetPin x={targetPx[0]} y={targetPx[1]} height={34} />}
            {herePx && <HereMarker x={herePx[0]} y={herePx[1]} radius={8} />}
          </G>
        </Svg>
      </Animated.View>
      {controls && <View style={styles.controls}>
        <Pressable testID="zoom-in" accessibilityLabel="Zoom in" style={styles.button} onPress={() => zoomBy(1.5)}>
          <Text style={styles.buttonText}>+</Text>
        </Pressable>
        <Pressable testID="zoom-out" accessibilityLabel="Zoom out" style={styles.button} onPress={() => zoomBy(1 / 1.5)}>
          <Text style={styles.buttonText}>−</Text>
        </Pressable>
      </View>}
    </View>
  );
}
