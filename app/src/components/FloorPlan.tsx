/** One floor seen from straight above (the 2D view), drawn as an architect's plan (plan.ts): rooms tinted by what
 * they're for, walls with their real thickness, doors with their swing, stairs as treads with UP / DN arrows, and
 * every thing as its model seen from above (just its footprint from far away); labels that size with the zoom;
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
import { modelOf } from '../models/catalog';
import { colourOf } from '../models/materials';
import { doorSymbol, layered, partsFromAbove, type PlanShape, stairPlan, wallBand } from '../plan';
import { layoutStairs, stairInput } from '../stairs';
import { assetStyle, colours, map as mapColours, roomStyle, shade } from '../theme';
import type { MapHandle } from '../ui/MapControls';
import { doorLeaves, floorWalls } from '../walls';
import { atLeast, type Inset, LABEL_FONT, limitMove, limitZoom, NO_INSET, placeThings, SAFETY_DIM, styles } from './FloorScene';
import { safetyMarks } from '../safety';
import { routeSpaces } from '../steps';
import { ChangeMarks, HereMarker, SafetyMarks, TargetPin } from './Markers';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const FOCUS_MARGIN_M = 8;
const MIN_LABEL_PX = 30; // rooms smaller than this on screen get no label
const MARGIN_PX = 120;
const MIN_ASSET_PX = 3;
/** Pixels per metre where a thing shows as its model from above, then with its details, then the small ones. */
const SYMBOL_PX = [5, 13, 30];
const SYMBOL_BUDGET = [Infinity, 900, 260]; // at most this many things on screen at each level of detail
const DOOR_PX = 8; // door swings from this close
const TAG_PX = 13; // UP / DN on the stairs from this close

interface Props {
  detail: BuildingDetail;
  floorId: string;
  map: MapView | null;
  /** The building's outline on this floor: tells outside walls (thicker) from inside ones. */
  footprints?: Point[][];
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

const NO_FOOTPRINTS: Point[][] = [];

export function FloorPlan({ detail, floorId, map, footprints = NO_FOOTPRINTS, width, height, onTapFloor, controls = true, handleRef,
                            inset = NO_INSET, highlight, focus, safety = false }: Props) {
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
  const placed = useMemo(() => placeThings(assets), [assets]);
  const storey = detail.floors.find((floor) => floor.id === floorId)?.height_m ?? 3;
  const openings = useMemo(() => detail.openings.filter((opening) => opening.floor_id === floorId), [detail, floorId]);
  const newDoors = map?.changes?.new_doors;
  const walls = useMemo(() => {
    const added = (newDoors ?? []).filter((door) => door.floor_id === floorId); // a new door cuts a gap too
    return floorWalls(spaces, [...openings, ...added], footprints);
  }, [spaces, openings, newDoors, floorId, footprints]);
  const bands = useMemo(() => walls.map(wallBand), [walls]);
  const doors = useMemo(() => doorLeaves(openings, spaces, walls).map(doorSymbol), [openings, spaces, walls]);
  const stairs = useMemo(() => spaces.flatMap((space) => {
    if (space.type !== 'stair') return [];
    const laid = layoutStairs(stairInput(detail, space));
    return laid ? [{ id: space.id, ...stairPlan(laid) }] : [];
  }), [spaces, detail]);
  // Each thing's model from above, at each level of detail, worked out once (moving the plan only redraws it).
  const symbols = useMemo(() => {
    const roomOf = new Map(spaces.map((space) => [space.id, space.room_type]));
    return assets.map((asset) => {
      const where = placed.get(asset.id) ?? { angle: (asset.footprint.rotation_deg * Math.PI) / 180, z: 0 };
      const model = modelOf(asset.type, asset.category, asset.footprint.width_m, asset.footprint.depth_m,
                            { room: roomOf.get(asset.space_id), ceiling: storey });
      const at = (tier: number) => partsFromAbove(model.parts, asset.position, where.angle, tier, where.z);
      return [at(0), at(1), at(2)];
    });
  }, [assets, placed, spaces, storey]);

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
  const fittedScale = useRef(fitted.scale);
  fittedScale.current = fitted.scale;
  const gestures = useMapGestures(width, height, (move) => setTransform((current) => {
    const { k, tx, ty } = limitMove(move, current.scale, fittedScale.current);
    return moveTransform(current, k, tx, ty, width, height);
  }), tapped, frame);
  const zoomBy = (k: number) =>
    setTransform((current) => moveTransform(current, limitZoom(k, current.scale, fittedScale.current), 0, 0, width, height));
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

  const scene = useMemo(() => {
    const ppm = transform.scale;
    const d = (rings: Point[][]) => rings.map((ring) => polygonPath(transform, ring)).join(' ');
    const lines = (rings: Point[][]) => rings.map((ring) => linePath(transform, ring)).join(' ');
    const [left, top] = toWorld(transform, [-MARGIN_PX, -MARGIN_PX]);
    const [right, bottom] = toWorld(transform, [width + MARGIN_PX, height + MARGIN_PX]);
    const onScreen = ([x, y]: Point, r: number) => x + r > left && x - r < right && y - r < top && y + r > bottom;

    // Things: far away their footprint in their colour, closer their model from above, the detail stepping down
    // when too many are on screen at once.
    const wanted = assets.map((asset, i) => {
      const size = Math.max(asset.footprint.width_m, asset.footprint.depth_m);
      if (Math.min(asset.footprint.width_m, asset.footprint.depth_m) * ppm < MIN_ASSET_PX || !onScreen(asset.position, size)) return -2;
      return ppm < SYMBOL_PX[0] ? -1 : ppm < SYMBOL_PX[1] ? 0 : ppm < SYMBOL_PX[2] ? 1 : 2;
    });
    let cap = 2;
    while (cap > 0 && wanted.filter((tier) => tier >= cap).length > SYMBOL_BUDGET[cap]) cap -= 1;
    const routed = pieces.length > 0;
    const shapes: { on: PlanShape[]; off: PlanShape[] } = { on: [], off: [] };
    const overhead: { on: Point[][]; off: Point[][] } = { on: [], off: [] };
    const footprintsByColour = new Map<string, { key: string; rings: Point[][]; fill: string; edge: string; opacity: number }>();
    let targetRing: Point[] | null = null;
    assets.forEach((asset, i) => {
      if (wanted[i] === -2) return;
      const isTarget = map?.target?.asset_id === asset.id;
      const angle = placed.get(asset.id)?.angle ?? (asset.footprint.rotation_deg * Math.PI) / 180;
      const ring = assetRect(asset.position, { ...asset.footprint, rotation_deg: (angle * 180) / Math.PI });
      if (isTarget) targetRing = ring;
      const way = routed && !onWay.has(asset.space_id) && !isTarget ? 'off' : 'on';
      const tier = Math.min(wanted[i], cap);
      if (tier < 0) {
        const style = assetStyle(asset.category ?? '');
        const key = `${style.top}|${way}`;
        const group = footprintsByColour.get(key);
        if (group) group.rings.push(ring);
        else footprintsByColour.set(key, { key, rings: [ring], fill: style.top, edge: style.edge, opacity: way === 'off' ? 0.28 : 1 });
        return;
      }
      const symbol = symbols[i][tier];
      shapes[way].push(...symbol.shapes);
      overhead[way].push(...symbol.overhead);
    });
    const layers = (list: PlanShape[]) => layered(list).map((layer) => ({ key: layer.key, d: d(layer.rings), fill: layer.fill }));

    const stairsShown = stairs.filter((stair) => stair.voids.concat(stair.treads.map((tread) => tread.ring)).some((ring) =>
      ring.some((p) => onScreen(p, 1))));
    return {
      walls: d(bands),
      doors: ppm >= DOOR_PX ? { leaves: lines(doors.map((door) => door.leaf)), swings: lines(doors.map((door) => door.swing)) } : null,
      footprints: [...footprintsByColour.values()].map((group) => ({ ...group, d: d(group.rings) })),
      things: layers(shapes.on),
      thingsOff: layers(shapes.off),
      overhead: d(overhead.on),
      overheadOff: d(overhead.off),
      target: targetRing ? d([targetRing]) : null,
      stairs: {
        voids: d(stairsShown.flatMap((stair) => stair.voids)),
        treads: layers(stairsShown.flatMap((stair) => stair.treads)),
        above: d(stairsShown.flatMap((stair) => stair.above)),
        breaks: lines(stairsShown.flatMap((stair) => stair.breaks)),
        arrows: lines(stairsShown.flatMap((stair) => stair.arrows.flatMap((arrow) => [arrow.line, arrow.head]))),
        tags: ppm >= TAG_PX ? stairsShown.flatMap((stair) => stair.arrows.map((arrow) => ({
          key: `${stair.id}-${arrow.up ? 'up' : 'dn'}`, at: toScreen(transform, arrow.tag), text: arrow.up ? 'UP' : 'DN',
        }))) : [],
      },
    };
  }, [transform, width, height, assets, symbols, placed, pieces, onWay, map, bands, doors, stairs]);

  // The route draws itself in.
  const draw = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    draw.setValue(0);
    Animated.timing(draw, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [draw, pieces]);

  const routeLengthPx = pieces.reduce((sum, piece) => sum + lineLength(piece.points) * transform.scale, 0) || 1;
  const dashOffset = draw.interpolate({ inputRange: [0, 1], outputRange: [routeLengthPx, 0] });
  const edge = Math.min(0.9, Math.max(0.4, transform.scale * 0.05));
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
                <Path key={space.id} d={polygonPath(transform, space.polygon)} fill={style.fill} stroke={style.edge} strokeOpacity={0.6}
                      strokeWidth={edge} />
              );
            })}
            </G>
            <G testID="plan-stairs">
              {scene.stairs.voids ? <Path d={scene.stairs.voids} fill={colourOf('void')} /> : null}
              {scene.stairs.treads.map((layer) => (
                <Path key={`tread-${layer.key}`} d={layer.d} fill={layer.fill} stroke={shade(layer.fill, 0.4)}
                      strokeWidth={0.6} />
              ))}
              {scene.stairs.above ? <Path d={scene.stairs.above} fill="none" stroke={mapColours.label} strokeOpacity={0.45}
                                          strokeWidth={0.6} strokeDasharray={[3, 2.5]} /> : null}
              {scene.stairs.breaks ? <Path d={scene.stairs.breaks} fill="none" stroke={mapColours.label} strokeWidth={0.9} /> : null}
              {scene.stairs.arrows ? <Path d={scene.stairs.arrows} fill="none" stroke={mapColours.chromeText} strokeWidth={1.4}
                                           strokeLinecap="round" strokeLinejoin="round" /> : null}
              {scene.stairs.tags.map((tag) => (
                <G key={tag.key}>
                  <SvgText x={tag.at[0]} y={tag.at[1] + 3} fontSize={9} fontWeight="700" fontFamily={LABEL_FONT} textAnchor="middle"
                           fill={mapColours.background} stroke={mapColours.background} strokeWidth={2.5}>{tag.text}</SvgText>
                  <SvgText x={tag.at[0]} y={tag.at[1] + 3} fontSize={9} fontWeight="700" fontFamily={LABEL_FONT} textAnchor="middle"
                           fill={mapColours.chromeText}>{tag.text}</SvgText>
                </G>
              ))}
            </G>
            <G opacity={dim}>
            {scene.target ? <Path d={scene.target} fill={colours.accentSoft} stroke={colours.accent} strokeWidth={4} strokeOpacity={0.35} /> : null}
            {scene.footprints.map((group) => (
              <Path key={`foot-${group.key}`} d={group.d} fill={group.fill} stroke={group.edge} strokeWidth={0.6} opacity={group.opacity} />
            ))}
            <G opacity={0.28}>
              {scene.thingsOff.map((layer) => (
                <Path key={`off-${layer.key}`} d={layer.d} fill={layer.fill} stroke={shade(layer.fill, 0.6)} strokeWidth={0.5} />
              ))}
              {scene.overheadOff ? <Path d={scene.overheadOff} fill="none" stroke={mapColours.label} strokeOpacity={0.5} strokeWidth={0.6}
                                         strokeDasharray={[3, 2]} /> : null}
            </G>
            <G testID="plan-things">
              {scene.things.map((layer) => (
                <Path key={`on-${layer.key}`} d={layer.d} fill={layer.fill} stroke={shade(layer.fill, 0.6)} strokeWidth={0.5} />
              ))}
              {scene.overhead ? <Path d={scene.overhead} fill="none" stroke={mapColours.label} strokeOpacity={0.5} strokeWidth={0.6}
                                      strokeDasharray={[3, 2]} /> : null}
            </G>
            {scene.target ? <Path d={scene.target} fill="none" stroke={colours.accent} strokeWidth={1.5} testID="target-thing" /> : null}
            <Path d={scene.walls} fill={mapColours.wall2d} stroke={mapColours.wall2d} strokeWidth={0.5} testID="plan-walls" />
            {scene.doors && (
              <G testID="plan-doors">
                <Path d={scene.doors.swings} fill="none" stroke={mapColours.label} strokeOpacity={0.45} strokeWidth={0.7} />
                <Path d={scene.doors.leaves} fill="none" stroke={mapColours.label} strokeWidth={1.2} strokeLinecap="round" />
              </G>
            )}
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
