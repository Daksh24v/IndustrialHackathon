/** The building as a floor stack: every floor a thin slab with its own rooms drawn on it, the slabs pulled apart
 * so each one shows, drawn as an isometric view with SVG (no 3D engine, so it runs the same on every phone and
 * on the web). A route runs across the slabs, up the stairs from one to the next. Drag to turn it all the way
 * round (it also turns slowly by itself until touched); the floor under the cursor turns grey with its name,
 * and a click (tap) opens it. When a floor is chosen (by the agent or a click) the view zooms onto it, the
 * floors above fade away, and onArrived() hands over to the floor view. Under it, on the ground, the real
 * neighbourhood from OpenStreetMap when the building has one: land use, streets, trees and the buildings next door. */
import { type ComponentRef, type MutableRefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Path, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import type { Context, MapView, Outline, Point, Space } from '../api';
import {
  boundsOf, centre as centreOf, grow, ISO_PITCH, isoDepth, isoProject, nearby, pointInPolygon, signedArea, type Iso,
} from '../geometry';
import { colours, map as mapColours, nearStyle, roomStyle } from '../theme';
import type { MapHandle } from '../ui/MapControls';
import { type Inset, LABEL_FONT, NO_INSET, wrapAngle } from './FloorScene';
import { GroundLayers, groundOf } from './Neighbourhood';

const ZOOM_MS = 1300;
const ZOOM_SCALE = 2.4;
const FLOOR_GAP = 0.08; // fraction of a floor's height left as a visible seam
const VIEW_ANGLE = Math.PI / 9; // a slight turn so two sides of the building show
const DRAG_TURN = 0.008; // radians per pixel dragged sideways
const DRAG_TILT = 0.005; // radians per pixel dragged up or down: down looks more from above, up more from the side
const PITCH_MIN = 0.2;
const PITCH_MAX = 1.2;
const clampPitch = (pitch: number) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch));
const SPIN_PER_S = (2 * Math.PI) / 90; // the idle turn: once round in 90 s
const SPIN_PAUSE_MS = 5000; // after a touch the building holds still this long
const TAP_SLOP_PX = 5;
const TURN_MS = 450;
const HOVER_TOP = '#34465C';
const HOVER_WALL = '#2B3A4C';
const GRID_M = 5;
const GRID_REACH_M = 25; // how far the ground grid reaches beyond the building
const NEAR_REACH_M = 120; // how much of the neighbourhood is drawn (it is redrawn as the building turns)

const STACK_GAP = 0.2; // the slabs are this share of the building's width apart
const SLAB = 0.1; // a slab's thickness, as a share of the gap
const LABEL_PX = 84; // room kept on the right for the floor names

interface Props {
  outline: Outline;
  /** The OpenStreetMap neighbourhood, drawn on the ground around the stack. */
  context?: Context | null;
  /** The rooms, drawn on each slab. */
  spaces?: Space[];
  /** The route across the floors, you and the target. */
  map?: MapView | null;
  inset?: Inset;
  /** For the map buttons: turn (45° steps, or by hand with the compass) and back to the first view. */
  handleRef?: MutableRefObject<MapHandle | null>;
  focusFloorId: string | null;
  onArrived?: () => void;
  /** A click (tap) on a floor's block. */
  onPickFloor?: (floorId: string) => void;
  /** Turn slowly by itself while nobody touches it (the backdrop behind FINNI). */
  spin?: boolean;
  width: number;
  height: number;
}

/** How big the building may be drawn so that it fits at every angle (it never jumps while turning). */
export function fitScale(floors: { elevation_m: number; height_m: number; footprints: Point[][] }[], centre: Point,
                         width: number, height: number, widthShare = 0.82, heightShare = 0.7, pitch?: number): number {
  let spanX = 1;
  let spanY = 1;
  for (let step = 0; step < 24; step += 1) {
    const iso: Iso = { angle: (step / 24) * 2 * Math.PI, centre, pitch };
    const box = boundsOf(floors.flatMap((floor) => floor.footprints.flat().flatMap((p) => [
      isoProject(iso, p, floor.elevation_m), isoProject(iso, p, floor.elevation_m + floor.height_m)])));
    spanX = Math.max(spanX, box.maxX - box.minX);
    spanY = Math.max(spanY, box.maxY - box.minY);
  }
  return Math.min((width * widthShare) / spanX, (height * heightShare) / spanY);
}

interface Face {
  d: string;
  points: Point[]; // on screen
  fill: string;
  depth: number;
}

/** The floor whose block is drawn at a screen point: the highest one there, as it is drawn on top. */
export function floorAt(floors: { id: string; faces: { points: Point[] }[] }[], point: Point): string | null {
  for (let i = floors.length - 1; i >= 0; i -= 1) {
    if (floors[i].faces.some((face) => pointInPolygon(point, face.points))) return floors[i].id;
  }
  return null;
}

const AnimatedG = Animated.createAnimatedComponent(G);

function path(points: Point[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ' Z';
}

interface Look {
  wall: string;
  wallDark: string;
  top: string;
}

const SLABS: Look = { wall: mapColours.block, wallDark: mapColours.blockDark, top: mapColours.blockTop };

/** Faces of one floor block in drawing order: the walls facing the viewer (far to near), then the top. */
function floorFaces(iso: Iso, footprints: Point[][], bottom: number, top: number, toScreen: (p: Point) => Point,
                    look: Look = SLABS): Face[] {
  const walls: Face[] = [];
  const tops: Face[] = [];
  for (const raw of footprints) {
    const ring = signedArea(raw) >= 0 ? raw : [...raw].reverse(); // counter-clockwise
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      // The outward normal of a counter-clockwise ring's edge is (dy, -dx). Turned like the building, a wall
      // faces the viewer when the normal points towards the viewer, i.e. towards -x and -y.
      const nx = b[1] - a[1];
      const ny = -(b[0] - a[0]);
      const rx = nx * Math.cos(iso.angle) - ny * Math.sin(iso.angle);
      const ry = nx * Math.sin(iso.angle) + ny * Math.cos(iso.angle);
      if (rx + ry >= 0) continue;
      const quad = [isoProject(iso, a, bottom), isoProject(iso, b, bottom), isoProject(iso, b, top), isoProject(iso, a, top)]
        .map(toScreen);
      const shade = rx < ry ? look.wall : look.wallDark; // left-facing walls lighter, right-facing darker
      walls.push({ d: path(quad), points: quad, fill: shade, depth: (isoDepth(iso, a) + isoDepth(iso, b)) / 2 });
    }
    const roof = ring.map((p) => toScreen(isoProject(iso, p, top)));
    tops.push({ d: path(roof), points: roof, fill: look.top, depth: Infinity });
  }
  walls.sort((x, y) => x.depth - y.depth);
  return [...walls, ...tops];
}

export function BuildingBlocks({ outline, context, spaces = [], map = null, focusFloorId, onArrived, onPickFloor, spin = false,
                               width, height, inset = NO_INSET, handleRef }: Props) {
  const floors = useMemo(() => [...outline.floors].sort((a, b) => a.elevation_m - b.elevation_m), [outline]);
  const all = useMemo(() => floors.flatMap((floor) => floor.footprints.flat()), [floors]);
  const plan = boundsOf(all);
  const centre: Point = [(plan.minX + plan.maxX) / 2, (plan.minY + plan.maxY) / 2];
  const [angle, setAngle] = useState(VIEW_ANGLE);
  const [pitch, setPitch] = useState(ISO_PITCH);
  const iso: Iso = { angle, centre, pitch };

  // Pulled apart: each floor a thin slab, one gap above the other, whatever their real heights.
  const gap = Math.min(28, Math.max(5, Math.max(plan.maxX - plan.minX, plan.maxY - plan.minY) * STACK_GAP));
  const slab = Math.max(0.4, gap * SLAB);
  const stacked = useMemo(() => floors.map((floor, i) => ({ ...floor, z: i * gap, top: i * gap + slab })), [floors, gap, slab]);
  const level = (floorId: string | undefined) => stacked.find((floor) => floor.id === floorId);

  // The same size at every angle, centred in the free part of the screen (it turns in place).
  const labels = width < 600 ? LABEL_PX * 0.75 : LABEL_PX;
  const free = { w: width - inset.left - inset.right - labels, h: height - inset.top - inset.bottom };
  const scale = useMemo(
    () => fitScale(stacked.map((floor) => ({ elevation_m: floor.z, height_m: slab, footprints: floor.footprints })), centre,
                   free.w, free.h, 0.86, 0.72, pitch),
    [stacked, slab, centre[0], centre[1], free.w, free.h, pitch]);
  const top = stacked.length ? stacked[stacked.length - 1].top : 0;
  const middle = isoProject(iso, centre, top / 2); // the stack's middle: the turning axis
  const mid: Point = [inset.left + free.w / 2, inset.top + free.h / 2];
  const toScreen = ([x, y]: Point): Point => [mid[0] + (x - middle[0]) * scale, mid[1] + (y - middle[1]) * scale];
  const at = (p: Point, z: number) => toScreen(isoProject(iso, p, z));

  const blocks = stacked.map((floor) => ({ id: floor.id, faces: floorFaces(iso, floor.footprints, floor.z, floor.top, toScreen) }));
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const frame = useRef<ComponentRef<typeof View>>(null);

  // The ground under the stack: a faint grid and the neighbourhood, next door's buildings far to near.
  const ground = -slab;
  const near = useMemo(() => (context && all.length ? nearby(context, plan, NEAR_REACH_M) : null), [context, all]); // eslint-disable-line react-hooks/exhaustive-deps -- plan follows from all
  const area = grow(plan, GRID_REACH_M);
  const gridLine = (a: Point, b: Point) => {
    const [p, q] = [at(a, ground), at(b, ground)];
    return `M${p[0].toFixed(1)} ${p[1].toFixed(1)} L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  };
  const grid: string[] = [];
  for (let x = Math.ceil(area.minX / GRID_M) * GRID_M; x <= area.maxX; x += GRID_M) grid.push(gridLine([x, area.minY], [x, area.maxY]));
  for (let y = Math.ceil(area.minY / GRID_M) * GRID_M; y <= area.maxY; y += GRID_M) grid.push(gridLine([area.minX, y], [area.maxX, y]));
  const onScreen = (points: Point[]) => {
    const b = boundsOf(points);
    return b.maxX > 0 && b.minX < width && b.maxY > 0 && b.minY < height;
  };
  const around = near && {
    ground: groundOf(near, (polygon) => {
      const screen = polygon.map((p) => at(p, ground));
      return screen.length > 2 && onScreen(screen) ? path(screen) : null;
    }, (p) => {
      const point = at(p, ground);
      return onScreen([point]) ? { at: point, ppm: scale } : null;
    }),
    buildings: near.buildings
      .map((item) => ({ item, depth: isoDepth(iso, centreOf(item.polygon)) }))
      .sort((a, b) => a.depth - b.depth)
      .flatMap(({ item }) => {
        const faces = floorFaces(iso, [item.polygon], ground, ground + item.height_m, toScreen, nearStyle(item.kind));
        return faces.some((face) => onScreen(face.points)) ? [faces] : [];
      }),
  };

  // What is drawn on the slabs: the rooms, the route (up the stairs between slabs), you and the target.
  const rooms = useMemo(() => {
    const byFloor = new Map<string, Space[]>();
    for (const space of spaces) if (space.type !== 'outdoor') byFloor.set(space.floor_id, [...(byFloor.get(space.floor_id) ?? []), space]);
    return byFloor;
  }, [spaces]);
  const pieces = map?.route?.pieces ?? [];
  const routeFloors = new Set(pieces.map((piece) => piece.floor_id));

  const focus = floors.find((floor) => floor.id === focusFloorId);
  const zoom = useRef(new Animated.Value(0)).current;
  const arrived = useRef(onArrived);
  arrived.current = onArrived;
  useEffect(() => {
    if (!focus) {
      zoom.setValue(0);
      return;
    }
    Animated.timing(zoom, { toValue: 1, duration: ZOOM_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: false })
      .start(({ finished }) => finished && arrived.current?.());
  }, [focus, zoom]);

  // Turning: by itself while untouched, by dragging otherwise.
  const touched = useRef(0);

  // The map buttons: turn by 45°, by hand (dragging the compass), or back to the first view; the compass follows.
  const angleRef = useRef(angle);
  angleRef.current = angle;
  const watchers = useRef(new Set<(yaw: number) => void>());
  useLayoutEffect(() => watchers.current.forEach((watch) => watch(angle - VIEW_ANGLE)), [angle]);
  const turning = useRef<number | null>(null);
  useEffect(() => () => {
    if (turning.current !== null) cancelAnimationFrame(turning.current);
  }, []);
  useEffect(() => {
    if (!handleRef) return;
    const animate = (by: number) => {
      if (turning.current !== null) cancelAnimationFrame(turning.current);
      const start = angleRef.current;
      const began = Date.now();
      const step = () => {
        touched.current = Date.now();
        const t = Math.min(1, (Date.now() - began) / TURN_MS);
        setAngle(start + by * Easing.inOut(Easing.cubic)(t));
        turning.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      turning.current = requestAnimationFrame(step);
    };
    const mine: MapHandle = {
      zoomBy: () => {},
      north: () => animate(-wrapAngle(angleRef.current - VIEW_ANGLE)),
      turnBy: animate,
      beginTurn: () => {
        const start = angleRef.current;
        return (by) => {
          touched.current = Date.now();
          setAngle(start + by);
        };
      },
      watchYaw: (watch) => {
        watchers.current.add(watch);
        watch(angleRef.current - VIEW_ANGLE);
        return () => watchers.current.delete(watch);
      },
    };
    handleRef.current = mine;
    return () => {
      if (handleRef.current === mine) handleRef.current = null; // the next view may have set its own already
    };
  }, [handleRef]);
  useEffect(() => {
    if (!spin || focus) return;
    let raf = 0;
    let last = Date.now();
    const step = () => {
      const now = Date.now();
      if (now - touched.current > SPIN_PAUSE_MS) setAngle((a) => a + SPIN_PER_S * Math.min(0.1, (now - last) / 1000));
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [spin, focus]);

  const pickRef = useRef(onPickFloor);
  pickRef.current = onPickFloor;
  const focused = useRef(!!focus);
  focused.current = !!focus;
  const pitchRef = useRef(pitch);
  pitchRef.current = pitch;
  const responder = useMemo(() => {
    let startAngle = 0;
    let startPitch = ISO_PITCH;
    let moved = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !focused.current,
      onMoveShouldSetPanResponder: () => !focused.current,
      onPanResponderGrant: () => {
        touched.current = Date.now();
        moved = 0;
        startPitch = pitchRef.current;
        setAngle((a) => {
          startAngle = a;
          return a;
        });
      },
      onPanResponderMove: (_, g) => {
        touched.current = Date.now();
        moved = Math.max(moved, Math.abs(g.dx) + Math.abs(g.dy));
        setAngle(startAngle + g.dx * DRAG_TURN);
        setPitch(clampPitch(startPitch + g.dy * DRAG_TILT));
      },
      onPanResponderRelease: (event) => {
        touched.current = Date.now();
        if (moved > TAP_SLOP_PX || !pickRef.current) return;
        const { pageX, pageY } = event.nativeEvent;
        frame.current?.measureInWindow((left, topY) => {
          const floorId = floorAt(blocksRef.current, [pageX - left, pageY - topY]);
          if (floorId) pickRef.current?.(floorId);
        });
      },
    });
  }, []);

  // Hover (web): the floor under the cursor turns grey and says which it is.
  const [hover, setHover] = useState<{ id: string; at: Point } | null>(null);
  useEffect(() => {
    const node = frame.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !node || typeof node.addEventListener !== 'function') return;
    const onMove = (event: PointerEvent) => {
      if (focused.current || event.buttons) return setHover(null);
      const box = node.getBoundingClientRect();
      const point: Point = [event.clientX - box.left, event.clientY - box.top];
      const id = floorAt(blocksRef.current, point);
      node.style.cursor = id ? 'pointer' : 'grab';
      setHover((current) => (id ? { id, at: point } : current ? null : current));
    };
    const onLeave = () => setHover(null);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
    };
  }, []);
  const hovered = hover && !focus ? floors.find((floor) => floor.id === hover.id) : undefined;

  // Zoom towards the chosen floor's top face.
  const goal = focus ? at(iso.centre, level(focus.id)!.top) : mid;
  const scaleAnim = zoom.interpolate({ inputRange: [0, 1], outputRange: [1, ZOOM_SCALE] });
  const shiftX = zoom.interpolate({ inputRange: [0, 1], outputRange: [0, (mid[0] - goal[0]) * ZOOM_SCALE] });
  const shiftY = zoom.interpolate({ inputRange: [0, 1], outputRange: [0, (mid[1] - goal[1]) * ZOOM_SCALE] });
  const fadeAbove = zoom.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: 'clamp' });

  const routeOn = (floorId: string, z: number) => pieces.filter((piece) => piece.floor_id === floorId).map((piece) =>
    piece.points.map((p, i) => `${i ? 'L' : 'M'}${at(p, z).map((v) => v.toFixed(1)).join(' ')}`).join(' '));
  const climbs = pieces.flatMap((piece, i) => {
    const next = pieces[i + 1];
    const a = level(piece.floor_id);
    const b = level(next?.floor_id);
    if (!next || !a || !b || !piece.points.length || !next.points.length) return [];
    const [x1, y1] = at(piece.points[piece.points.length - 1], a.top + 0.05);
    const [x2, y2] = at(next.points[0], b.top + 0.05);
    return [`M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`];
  });
  const here = map?.you_are_here;
  const target = map?.target;

  return (
    <View ref={frame} style={{ width, height, backgroundColor: mapColours.background, overflow: 'hidden' }} testID="building-blocks"
          {...responder.panHandlers}>
      <View testID="pick-floor" accessibilityLabel="Turn the building, or open a floor" style={{ width, height }}>
        <Animated.View style={{ width, height, transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale: scaleAnim }] }}>
          <Svg width={width} height={height}>
            <Path d={grid.join(' ')} stroke={mapColours.slabEdge} strokeOpacity={0.6} strokeWidth={0.6} fill="none" />
            {around && (
              <AnimatedG opacity={fadeAbove}>
                <GroundLayers ground={around.ground} flatten={Math.sin(pitch)} />
                {around.buildings.map((faces, i) => (
                  <G key={`near-${i}`}>
                    {faces.map((face, j) => (
                      <Path key={j} d={face.d} fill={face.fill} stroke={mapColours.nearEdge} strokeWidth={0.5} strokeLinejoin="round" />
                    ))}
                  </G>
                ))}
              </AnimatedG>
            )}
            {/* a soft shadow under the stack */}
            <Path d={path(floors[0]?.footprints[0]?.map((p) => at([p[0] + 1.5, p[1] - 1.5], -slab)) ?? [])} fill={mapColours.shadow} />
            {stacked.map((floor, i) => {
              const faces = blocks[i].faces;
              const above = !!focus && floor.elevation_m > focus.elevation_m;
              const lit = hovered?.id === floor.id;
              const onRoute = routeFloors.has(floor.id);
              const tops = faces.filter((face) => face.depth === Infinity);
              const label = tops.length ? tops.flatMap((face) => face.points).reduce((best, p) => (p[0] > best[0] ? p : best)) : null;
              const content = (
                <>
                  {faces.map((face, index) => (
                    <Path key={index} d={face.d}
                          fill={lit ? (face.depth === Infinity ? HOVER_TOP : HOVER_WALL) : face.fill}
                          stroke={lit ? colours.accent : onRoute ? '#F3B27A' : mapColours.blockEdge} strokeWidth={lit ? 1.2 : 0.7}
                          strokeLinejoin="round" />
                  ))}
                  {(rooms.get(floor.id) ?? []).map((space) => (
                    <Path key={space.id} d={path(space.polygon.map((p) => at(p, floor.top)))}
                          fill={lit ? 'transparent' : roomStyle(space).fill} stroke={roomStyle(space).edge} strokeOpacity={0.5}
                          strokeWidth={0.5} />
                  ))}
                  {routeOn(floor.id, floor.top + 0.05).map((d, k) => (
                    <Path key={`r${k}`} d={d} stroke={colours.accent} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"
                          fill="none" testID="stack-route" />
                  ))}
                  {here?.floor_id === floor.id && (() => {
                    const [x, y] = at(here.position, floor.top + 0.05);
                    return <Circle cx={x} cy={y} r={5} fill={colours.accent} stroke="#FFFFFF" strokeWidth={2} />;
                  })()}
                  {target?.floor_id === floor.id && (() => {
                    const [x, y] = at(target.position, floor.top + 0.05);
                    return <Circle cx={x} cy={y} r={5} fill="#FFFFFF" stroke={colours.accent} strokeWidth={3} />;
                  })()}
                  {label && (
                    <SvgText x={label[0] + 12} y={label[1] + 4} fontSize={12} fontWeight="700" fontFamily={LABEL_FONT}
                             fill={lit || onRoute ? colours.accent : mapColours.label}>
                      {floor.name}
                    </SvgText>
                  )}
                </>
              );
              return above ? (
                <AnimatedG key={floor.id} opacity={fadeAbove}>{content}</AnimatedG>
              ) : (
                <G key={floor.id} testID={`block-${floor.level}`}>{content}</G>
              );
            })}
            {climbs.map((d, k) => (
              <Path key={`c${k}`} d={d} stroke={colours.accent} strokeWidth={2} strokeDasharray={[4, 4]} fill="none" />
            ))}
            {/* the neighbourhood fades into the dark at the edges */}
            {around && (
              <>
                <Defs>
                  <RadialGradient id="vignette" cx="50%" cy="50%" r="60%">
                    <Stop offset="0.7" stopColor={mapColours.background} stopOpacity={0} />
                    <Stop offset="1" stopColor={mapColours.background} stopOpacity={1} />
                  </RadialGradient>
                </Defs>
                <Rect x={0} y={0} width={width} height={height} fill="url(#vignette)" pointerEvents="none" />
              </>
            )}
          </Svg>
        </Animated.View>
      </View>
      {hovered && hover && (
        <View pointerEvents="none" testID="floor-hint"
              style={[styles.hint, { left: Math.min(hover.at[0] + 14, width - 190), top: Math.max(hover.at[1] - 34, 8) }]}>
          <Text style={styles.hintText}>{hovered.name} · click to open</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { position: 'absolute', backgroundColor: mapColours.chrome, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
          borderWidth: StyleSheet.hairlineWidth, borderColor: mapColours.chromeEdge, shadowColor: '#000', shadowOpacity: 0.3,
          shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  hintText: { fontSize: 12, fontWeight: '600', color: mapColours.chromeText },
});
