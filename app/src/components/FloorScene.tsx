/** One floor in 3D: the camera looks down at an angle with perspective, rooms are tiles on a floor slab, walls
 * stand up (low, so you can see into the rooms) with gaps at the doors, the route is an orange band on the
 * floor with arrows flowing along it, the target is a pin and you are an orange disc on the floor.
 * Drawn with SVG (no 3D engine: those crash Expo Go on iPhones). Drag to move, pinch or +/− to zoom, ⟳ to turn. */
import { type ComponentRef, type MutableRefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { G, Path, Text as SvgText } from 'react-native-svg';

import type { BuildingDetail, MapView, Point } from '../api';
import { changesOn } from '../changes';
import {
  boundsOf, chooseCamera, clipNear, depthOf, fitCamera, grow, moveCamera, pixelsPerMetre, project3d, ribbon, rotateAbout,
  signedArea, unproject3d, wallSegments, type Camera, type Point3,
} from '../geometry';
import { useMapGestures } from '../gestures';
import { colours, spaceFill } from '../theme';
import type { MapHandle } from '../ui/MapControls';
import { ChangeMarks, HereMarker, TargetPin, useLoop } from './Markers';

export const TILT = (52 * Math.PI) / 180;
/** The bird's-eye view: almost straight down, the walls still standing so the rooms read. */
export const TOP_TILT = (8 * Math.PI) / 180;
const WALL_M = 1.1;
const SLAB_M = 0.5;
const FOCUS_MARGIN_M = 4;
const MIN_LABEL_PX = 38;
const MARGIN_PX = 120; // drawn beyond the edges, so dragging doesn't show blank space
const TURN_MS = 450;
const DRAG_TURN = 0.006; // radians per pixel of a turning drag
const FLY_MS = 700; // walking through the steps: the camera moves to the next one
const STEP_MARGIN_M = 3;
const STEP_MIN_M = 10; // a step is shown with at least this much floor around it

/** The box grown about its middle to at least size x size metres. */
export function atLeast(box: ReturnType<typeof boundsOf>, size: number): ReturnType<typeof boundsOf> {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const hx = Math.max(box.maxX - box.minX, size) / 2;
  const hy = Math.max(box.maxY - box.minY, size) / 2;
  return { minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy };
}

/** Space on the screen that is covered (the answer panel, the search bar): the map frames around it. */
export interface Inset { left: number; top: number; right: number; bottom: number }
export const NO_INSET: Inset = { left: 0, top: 0, right: 0, bottom: 0 };

/** A camera fitted into the uncovered part of the screen. */
function inside(cam: Camera, inset: Inset): Camera {
  return { ...cam, ox: cam.ox + inset.left, oy: cam.oy + inset.top };
}

/** An angle in (-π, π]: the shortest way back to north. */
export function wrapAngle(angle: number): number {
  const turned = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return turned > Math.PI ? turned - 2 * Math.PI : turned;
}

const AnimatedPath = Animated.createAnimatedComponent(Path);
export const LABEL_FONT = Platform.select({ web: 'Helvetica, Arial, sans-serif', android: 'sans-serif', default: 'Helvetica' });

interface Props {
  detail: BuildingDetail;
  floorId: string;
  map: MapView | null;
  footprints: Point[][];
  width: number;
  height: number;
  /** A tap on the floor: where on it (metres), e.g. to say "I'm here". */
  onTapFloor?: (floorId: string, point: Point) => void;
  /** Its own zoom, turn and compass buttons (off when the screen has map controls of its own). */
  controls?: boolean;
  handleRef?: MutableRefObject<MapHandle | null>;
  inset?: Inset;
  /** A stretch of the route to stand out (the step under the cursor). */
  highlight?: Point[] | null;
  /** Frame this stretch, facing the way it goes (walking through the steps). */
  focus?: Point[] | null;
  /** How far the view leans: TILT (3D) or TOP_TILT (bird's eye). */
  tilt?: number;
}

const n = (value: number) => (Math.round(value * 10) / 10).toString();

function path(points: Point[], close = true): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join(' ') + (close ? ' Z' : '');
}

function grey(level: number): string {
  const v = Math.round(level).toString(16).padStart(2, '0');
  return `#${v}${v}${v}`;
}

export function FloorScene({ detail, floorId, map, footprints, width, height, onTapFloor, controls = true, handleRef,
                            inset = NO_INSET, highlight, focus, tilt = TILT }: Props) {
  const spaces = useMemo(() => detail.spaces.filter((space) => space.floor_id === floorId), [detail, floorId]);
  const openings = useMemo(() => detail.openings.filter((opening) => opening.floor_id === floorId), [detail, floorId]);
  const changes = useMemo(() => changesOn(detail, map, floorId), [detail, map, floorId]);
  const newDoors = map?.changes?.new_doors;
  const walls = useMemo(() => {
    const added = (newDoors ?? []).filter((door) => door.floor_id === floorId); // a new door cuts a gap too
    return wallSegments(spaces.map((space) => space.polygon), [...openings, ...added]);
  }, [spaces, openings, newDoors, floorId]);
  const pieces = useMemo(() => (map?.route?.pieces ?? []).filter((piece) => piece.floor_id === floorId), [map, floorId]);
  const here = map?.you_are_here?.floor_id === floorId ? map.you_are_here : null;
  const target = map?.target?.floor_id === floorId ? map.target : null;

  // Look at what matters (the route and the two places, else the whole floor), from the side that shows it
  // biggest, walking into the picture.
  const fitted = useMemo(() => {
    const focus: Point[] = pieces.flatMap((piece) => piece.points);
    if (here) focus.push(here.position);
    if (target) focus.push(target.position);
    const box = focus.length ? grow(boundsOf(focus), FOCUS_MARGIN_M) : boundsOf(spaces.flatMap((space) => space.polygon));
    const corners: Point3[] = [];
    for (const x of [box.minX, box.maxX]) for (const y of [box.minY, box.maxY]) corners.push([x, y, 0], [x, y, WALL_M]);
    return inside(chooseCamera(corners, width - inset.left - inset.right, height - inset.top - inset.bottom, tilt,
                               here?.position ?? pieces[0]?.points[0], target?.position ?? pieces[pieces.length - 1]?.points.slice(-1)[0]),
                  inset);
  }, [pieces, here, target, spaces, width, height, inset.left, inset.top, inset.right, inset.bottom, tilt]);
  const [cam, setCam] = useState<Camera>(fitted);
  useEffect(() => setCam(fitted), [fitted]);

  const frame = useRef<ComponentRef<typeof View>>(null);
  const camera = useRef(cam);
  const size = useRef({ width, height });
  size.current = { width, height };
  useLayoutEffect(() => {
    camera.current = cam;
  }, [cam]);
  const tapped = onTapFloor
    ? ([pageX, pageY]: [number, number]) =>
        frame.current?.measureInWindow((left, top) =>
          onTapFloor(floorId, unproject3d(camera.current, [pageX - left, pageY - top])))
    : undefined;
  const gestures = useMapGestures(width, height, ({ k, tx, ty }) =>
    setCam((current) => moveCamera(current, k, tx, ty, width, height)), tapped, frame);
  const zoomBy = (k: number) => setCam((current) => moveCamera(current, k, 0, 0, width, height));

  // Turn a quarter about whatever is in the middle of the screen.
  const turning = useRef<number | null>(null);
  useEffect(() => () => {
    if (turning.current !== null) cancelAnimationFrame(turning.current);
  }, []);
  // The middle of the part of the map you can see (not under the panel): the view turns about it.
  const middle = (): Point => {
    const box = insetRef.current;
    return [box.left + (size.current.width - box.left - box.right) / 2, box.top + (size.current.height - box.top - box.bottom) / 2];
  };
  const insetRef = useRef(inset);
  insetRef.current = inset;
  const turnBy = (angle: number) => {
    if (turning.current !== null) return;
    const start = camera.current;
    const pivot = unproject3d(start, middle());
    const began = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - began) / TURN_MS);
      setCam(rotateAbout(start, pivot, angle * Easing.inOut(Easing.cubic)(t)));
      turning.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    turning.current = requestAnimationFrame(step);
  };
  const turn = () => turnBy(Math.PI / 2);
  const north = () => turnBy(-wrapAngle(camera.current.yaw)); // the compass: north up again

  // The map controls outside the scene: zoom, north up, and the compass following the turn.
  const watchers = useRef(new Set<(yaw: number) => void>());
  useLayoutEffect(() => watchers.current.forEach((watch) => watch(cam.yaw)), [cam.yaw]);
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  const northRef = useRef(north);
  northRef.current = north;
  const turnRef = useRef(turnBy);
  turnRef.current = turnBy;
  const middleRef = useRef(middle);
  middleRef.current = middle;
  useEffect(() => {
    if (!handleRef) return;
    const mine: MapHandle = {
      zoomBy: (k) => zoomRef.current(k),
      north: () => northRef.current(),
      turnBy: (angle) => turnRef.current(angle),
      beginTurn: () => {
        const start = camera.current;
        const pivot = unproject3d(start, middleRef.current());
        return (angle) => setCam(rotateAbout(start, pivot, angle));
      },
      watchYaw: (watch) => {
        watchers.current.add(watch);
        watch(camera.current.yaw);
        return () => watchers.current.delete(watch);
      },
    };
    handleRef.current = mine;
    return () => {
      if (handleRef.current === mine) handleRef.current = null; // the next view may have set its own already
    };
  }, [handleRef]);

  // Walking through the steps: fly to the stretch, turned so that it goes up the screen (the way you walk).
  const flying = useRef<number | null>(null);
  useEffect(() => {
    if (!focus?.length) return;
    const [a, b] = [focus[0], focus[focus.length - 1]];
    const along = Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5;
    const yaw = along ? Math.atan2(b[0] - a[0], b[1] - a[1]) : camera.current.yaw;
    const box = atLeast(grow(boundsOf(focus), STEP_MARGIN_M), STEP_MIN_M);
    const corners: Point3[] = [];
    for (const x of [box.minX, box.maxX]) for (const y of [box.minY, box.maxY]) corners.push([x, y, 0], [x, y, WALL_M]);
    const goal = inside(fitCamera(corners, width - inset.left - inset.right, height - inset.top - inset.bottom, yaw, tilt, 24), inset);
    const from = camera.current;
    const turnBy = wrapAngle(goal.yaw - from.yaw);
    const began = Date.now();
    const mix = (x: number, y: number, t: number) => x + (y - x) * t;
    const step = () => {
      const t = Easing.inOut(Easing.cubic)(Math.min(1, (Date.now() - began) / FLY_MS));
      setCam({
        ...goal, yaw: from.yaw + turnBy * t, target: [mix(from.target[0], goal.target[0], t), mix(from.target[1], goal.target[1], t)],
        distance: mix(from.distance, goal.distance, t), scale: mix(from.scale, goal.scale, t), ox: mix(from.ox, goal.ox, t),
        oy: mix(from.oy, goal.oy, t),
      });
      flying.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    if (flying.current !== null) cancelAnimationFrame(flying.current);
    flying.current = requestAnimationFrame(step);
    return () => {
      if (flying.current !== null) cancelAnimationFrame(flying.current);
      flying.current = null;
    };
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps -- a new stretch only

  // Turn it all the way round like a map app: right-drag, Shift/Alt+drag (mouse) or a two-finger twist.
  useEffect(() => {
    const node = frame.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    let drag: { x: number; start: Camera; pivot: Point; id: number } | null = null;
    const pivotOf = (cam: Camera) => unproject3d(cam, middleRef.current());
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !(event.button === 2 || event.shiftKey || event.altKey)) return;
      event.preventDefault(); // no pan (and no "I'm here") while turning
      drag = { x: event.clientX, start: camera.current, pivot: pivotOf(camera.current), id: event.pointerId };
      node.setPointerCapture?.(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      setCam(rotateAbout(drag.start, drag.pivot, (event.clientX - drag.x) * DRAG_TURN));
    };
    const onUp = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.id) drag = null;
    };
    const noMenu = (event: MouseEvent) => event.preventDefault();
    let twist: { angle: number; start: Camera; pivot: Point } | null = null;
    const touchAngle = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]];
      return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    };
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        twist = null;
        return;
      }
      if (!twist) twist = { angle: touchAngle(event), start: camera.current, pivot: pivotOf(camera.current) };
      else setCam(rotateAbout(twist.start, twist.pivot, twist.angle - touchAngle(event)));
    };
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('contextmenu', noMenu);
    node.addEventListener('touchmove', onTouch, { passive: true });
    node.addEventListener('touchend', onTouch);
    return () => {
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('contextmenu', noMenu);
      node.removeEventListener('touchmove', onTouch);
      node.removeEventListener('touchend', onTouch);
    };
  }, []);

  const scene = useMemo(() => {
    const onScreen = (points: Point[]) => {
      const b = boundsOf(points);
      return b.maxX > -MARGIN_PX && b.minX < width + MARGIN_PX && b.maxY > -MARGIN_PX && b.minY < height + MARGIN_PX;
    };
    const flat = (polygon: Point[], z = 0) => {
      const clipped = clipNear(cam, polygon, z);
      if (clipped.length < 3) return null;
      const screen = clipped.map((p) => project3d(cam, p, z));
      return onScreen(screen) ? path(screen) : null;
    };
    const forward = (yaw: number, [dx, dy]: Point) => dx * Math.sin(yaw) + dy * Math.cos(yaw); // towards the far side

    // The slab the floor stands on: its near sides, then its top.
    const slabSides: { d: string; depth: number }[] = [];
    for (const raw of footprints) {
      const ring = signedArea(raw) >= 0 ? raw : [...raw].reverse();
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const outward: Point = [b[1] - a[1], -(b[0] - a[0])];
        if (forward(cam.yaw, outward) >= 0) return; // faces away from the viewer
        const side = clipNear(cam, [a, b], 0);
        if (side.length < 2) return;
        const quad = [project3d(cam, side[0], 0), project3d(cam, side[1], 0), project3d(cam, side[1], -SLAB_M),
                      project3d(cam, side[0], -SLAB_M)];
        if (onScreen(quad)) slabSides.push({ d: path(quad), depth: depthOf(cam, a) + depthOf(cam, b) });
      });
    }
    slabSides.sort((x, y) => y.depth - x.depth);
    const slabTops = footprints.map((ring) => flat(ring)).filter((d): d is string => !!d);

    const tiles = spaces.map((space) => ({
      id: space.id, d: flat(space.polygon), closed: changes.closedSpaces.has(space.id),
      fill: changes.closedSpaces.has(space.id) ? colours.closedFaint : spaceFill[space.type] ?? colours.room,
    })).filter((tile) => tile.d);

    const lit = highlight && highlight.length > 1 ? flat(ribbon(highlight, 0.5), 0.035) : null;
    const routes = pieces.map((piece) => ({
      glow: flat(ribbon(piece.points, 1.1), 0.02),
      band: flat(ribbon(piece.points, 0.42), 0.03),
      line: path(piece.points.filter((p) => depthOf(cam, p) > cam.distance * 0.3).map((p) => project3d(cam, p, 0.04)), false),
    }));

    // Walls far to near; lit from one side so their direction reads.
    const light: Point = [0.6, -0.8];
    const wallFaces: { d: string; fill: string; depth: number }[] = [];
    for (const [a, b] of walls) {
      const side = clipNear(cam, [a, b], WALL_M);
      if (side.length < 2) continue;
      const [p, q] = side;
      const quad = [project3d(cam, p, 0), project3d(cam, q, 0), project3d(cam, q, WALL_M), project3d(cam, p, WALL_M)];
      if (!onScreen(quad)) continue;
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const [ex, ey] = [-(q[1] - p[1]) / length, (q[0] - p[0]) / length]; // the wall's normal
      const c = Math.cos(cam.yaw);
      const s = Math.sin(cam.yaw);
      const lit = Math.abs((ex * c - ey * s) * light[0] + (ex * s + ey * c) * light[1]); // turned like the view
      wallFaces.push({ d: path(quad), fill: grey(236 - 26 * lit), depth: depthOf(cam, p) + depthOf(cam, q) });
    }
    wallFaces.sort((x, y) => y.depth - x.depth);

    const labels = spaces.flatMap((space) => {
      if (space.type === 'outdoor' || depthOf(cam, space.anchor) < cam.distance * 0.3) return [];
      const ppm = pixelsPerMetre(cam, space.anchor);
      const side = Math.sqrt(space.area_m2) * ppm;
      if (side < MIN_LABEL_PX) return [];
      const [x, y] = project3d(cam, space.anchor);
      if (x < -40 || x > width + 40 || y < -20 || y > height + 20) return [];
      const text = side > 110 || !space.ref ? space.name : space.ref;
      return [{ id: space.id, x, y, text, size: Math.min(13, Math.max(8.5, ppm * 0.9)) }];
    });
    return { slabSides, slabTops, tiles, routes, wallFaces, labels, lit };
  }, [cam, footprints, spaces, pieces, walls, width, height, changes, highlight]);

  // The route fades in; arrows flow along it.
  const flow = useLoop(900);
  const dashOffset = flow.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    appear.setValue(0);
    Animated.timing(appear, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [appear, floorId]);

  const marker = (p: Point) => ({ at: project3d(cam, p), ppm: pixelsPerMetre(cam, p) });
  const herePx = here && depthOf(cam, here.position) > cam.distance * 0.3 ? marker(here.position) : null;
  const targetPx = target && depthOf(cam, target.position) > cam.distance * 0.3 ? marker(target.position) : null;
  const flatten = Math.cos(tilt);

  return (
    <Animated.View ref={frame} style={[styles.frame, { width, height, opacity: appear }]} testID="floor-scene">
      <Animated.View {...gestures.panHandlers} style={[{ width, height }, gestures.style]}>
        <Svg width={width + 2 * MARGIN_PX} height={height + 2 * MARGIN_PX} style={{ position: 'absolute', left: -MARGIN_PX, top: -MARGIN_PX }}>
          <G transform={`translate(${MARGIN_PX} ${MARGIN_PX})`}>
            {scene.slabSides.map((side, i) => <Path key={`slab-${i}`} d={side.d} fill="#E2E2E2" stroke="#D2D2D2" strokeWidth={0.6} />)}
            {scene.slabTops.map((d, i) => <Path key={`top-${i}`} d={d} fill={colours.background} stroke="#D6D6D6" strokeWidth={1} />)}
            {scene.tiles.map((tile) => (
              <Path key={tile.id} d={tile.d!} fill={tile.fill} testID={tile.closed ? 'closed-space' : undefined}
                    stroke={tile.closed ? colours.closed : undefined} strokeWidth={tile.closed ? 1.5 : undefined} />
            ))}
            {scene.labels.map((label) => (
              <SvgText key={`label-${label.id}`} x={label.x} y={label.y + label.size / 3} fill={colours.label}
                       fontSize={label.size} fontFamily={LABEL_FONT} textAnchor="middle">
                {label.text}
              </SvgText>
            ))}
            {scene.routes.map((route, i) => (
              <G key={`route-${i}`} testID="route-line">
                {route.glow && <Path d={route.glow} fill={colours.accentFaint} />}
                {route.band && <Path d={route.band} fill={colours.accent} />}
                <AnimatedPath d={route.line} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round"
                              strokeLinejoin="round" fill="none" strokeDasharray={[6, 18]} strokeDashoffset={dashOffset} />
              </G>
            ))}
            {scene.lit && <Path d={scene.lit} fill="#B54F00" fillOpacity={0.6} testID="route-highlight" />}
            {scene.wallFaces.map((face, i) => (
              <Path key={`wall-${i}`} d={face.d} fill={face.fill} stroke="#C9C9C9" strokeWidth={0.6} strokeLinejoin="round" />
            ))}
            {/* the route seen through the walls, faintly, so it never disappears behind one */}
            {scene.routes.map((route, i) => (
              <Path key={`ghost-${i}`} d={route.line} stroke={colours.accent} strokeOpacity={0.35} strokeWidth={2.5}
                    strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ))}
            <ChangeMarks changes={changes} project={(p) => project3d(cam, p)} fontFamily={LABEL_FONT}
                         visible={(p) => depthOf(cam, p) > cam.distance * 0.3} />
            {targetPx && (
              <TargetPin x={targetPx.at[0]} y={targetPx.at[1]} height={Math.min(48, Math.max(30, targetPx.ppm * 2.6))}
                         flatten={flatten} />
            )}
            {herePx && (
              <HereMarker x={herePx.at[0]} y={herePx.at[1]} radius={Math.min(13, Math.max(7, herePx.ppm * 0.55))}
                          flatten={flatten} />
            )}
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
        <Pressable testID="turn" accessibilityLabel="Turn the view" style={styles.button} onPress={turn}>
          <Text style={[styles.buttonText, { fontSize: 18 }]}>⟳</Text>
        </Pressable>
        <Pressable testID="compass" accessibilityLabel="North up" style={styles.button} onPress={north}>
          <Svg width={22} height={22} viewBox="-11 -11 22 22"
               style={{ transform: [{ rotate: `${(-cam.yaw * 180) / Math.PI}deg` }] }}>
            <Path d="M0 -9 L4 0 L-4 0 Z" fill={colours.accent} />
            <Path d="M0 9 L4 0 L-4 0 Z" fill={colours.blockEdge} />
          </Svg>
        </Pressable>
      </View>}
    </Animated.View>
  );
}

export const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colours.background },
  controls: { position: 'absolute', right: 12, top: 60, gap: 8 },
  button: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colours.background, alignItems: 'center',
    justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  buttonText: { fontSize: 20, color: colours.text },
});
