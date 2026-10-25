/** The building from outside, like the block style of a map: each floor a dark block with glowing edges and a lit
 * band of windows, stacked by elevation,
 * drawn as an isometric view with SVG (no 3D engine, so it runs the same on every phone and on the web).
 * When a floor is chosen (by the agent, or a click on its block) the view zooms onto it, the floors above
 * fade away, and onArrived() hands over to the floor view. Around it, dimmer, the real neighbourhood from
 * OpenStreetMap when the building has one: streets, green, water and the buildings next door. */
import { type ComponentRef, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import Svg, { Defs, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import type { Context, Outline, Point } from '../api';
import { boundsOf, centre, grow, isoDepth, isoProject, nearby, pointInPolygon, ribbon, signedArea, type Iso } from '../geometry';
import { map as mapColours } from '../theme';

const ZOOM_MS = 1300;
const ZOOM_SCALE = 2.4;
const FLOOR_GAP = 0.08; // fraction of a floor's height left as a visible seam
const VIEW_ANGLE = Math.PI / 9; // a slight turn so two sides of the building show
const WINDOW_ROW_M = 3.5; // one row of windows per this much height
const GRID_M = 5;
const GRID_REACH_M = 25; // how far the ground grid reaches beyond the building
const NEAR_REACH_M = 250; // how much of the neighbourhood is drawn

interface Props {
  outline: Outline;
  context?: Context | null;
  focusFloorId: string | null;
  onArrived?: () => void;
  /** A click (tap) on a floor's block. */
  onPickFloor?: (floorId: string) => void;
  width: number;
  height: number;
}

interface Face {
  d: string;
  points: Point[]; // on screen
  fill: string;
  depth: number;
  bands?: string[]; // lit lines of windows along a wall, one per row
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
  windows: boolean;
}

const OURS: Look = { wall: mapColours.block, wallDark: mapColours.blockDark, top: mapColours.blockTop, windows: true };
const NEXT_DOOR: Look = { wall: mapColours.near, wallDark: mapColours.nearDark, top: mapColours.nearTop, windows: false };

/** Faces of one floor block in drawing order: the walls facing the viewer (far to near), then the top. */
function floorFaces(iso: Iso, footprints: Point[][], bottom: number, top: number, toScreen: (p: Point) => Point,
                    look: Look = OURS): Face[] {
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
      const rows = look.windows ? Math.max(1, Math.round((top - bottom) / WINDOW_ROW_M)) : 0;
      const bands = Array.from({ length: rows }, (_, row) => {
        const z = bottom + ((row + 0.55) * (top - bottom)) / rows;
        const [w0, w1] = [isoProject(iso, a, z), isoProject(iso, b, z)].map(toScreen);
        return `M${w0[0].toFixed(1)} ${w0[1].toFixed(1)} L${w1[0].toFixed(1)} ${w1[1].toFixed(1)}`;
      });
      walls.push({ d: path(quad), points: quad, fill: shade, depth: (isoDepth(iso, a) + isoDepth(iso, b)) / 2, bands });
    }
    const roof = ring.map((p) => toScreen(isoProject(iso, p, top)));
    tops.push({ d: path(roof), points: roof, fill: look.top, depth: Infinity });
  }
  walls.sort((x, y) => x.depth - y.depth);
  return [...walls, ...tops];
}

export function BuildingBlocks({ outline, context, focusFloorId, onArrived, onPickFloor, width, height }: Props) {
  const floors = useMemo(() => [...outline.floors].sort((a, b) => a.elevation_m - b.elevation_m), [outline]);
  const all = useMemo(() => floors.flatMap((floor) => floor.footprints.flat()), [floors]);
  const plan = boundsOf(all);
  const iso: Iso = { angle: VIEW_ANGLE, centre: [(plan.minX + plan.maxX) / 2, (plan.minY + plan.maxY) / 2] };

  // Fit the whole projected building into the view.
  const projected = floors.flatMap((floor) =>
    floor.footprints.flat().flatMap((p) => [isoProject(iso, p, floor.elevation_m), isoProject(iso, p, floor.elevation_m + floor.height_m)]));
  const box = boundsOf(projected);
  const scale = Math.min((width * 0.82) / Math.max(box.maxX - box.minX, 1), (height * 0.7) / Math.max(box.maxY - box.minY, 1));
  const toScreen = ([x, y]: Point): Point => [
    width / 2 + (x - (box.minX + box.maxX) / 2) * scale,
    height / 2 + (y - (box.minY + box.maxY) / 2) * scale,
  ];

  const blocks = floors.map((floor) => ({
    id: floor.id,
    faces: floorFaces(iso, floor.footprints, floor.elevation_m, floor.elevation_m + floor.height_m * (1 - FLOOR_GAP), toScreen),
  }));
  const frame = useRef<ComponentRef<typeof View>>(null);

  // A faint grid on the ground around the building.
  const area = grow(plan, GRID_REACH_M);
  const gridLine = (a: Point, b: Point) => {
    const [p, q] = [isoProject(iso, a, 0), isoProject(iso, b, 0)].map(toScreen);
    return `M${p[0].toFixed(1)} ${p[1].toFixed(1)} L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  };
  const grid: string[] = [];
  for (let x = Math.ceil(area.minX / GRID_M) * GRID_M; x <= area.maxX; x += GRID_M) grid.push(gridLine([x, area.minY], [x, area.maxY]));
  for (let y = Math.ceil(area.minY / GRID_M) * GRID_M; y <= area.maxY; y += GRID_M) grid.push(gridLine([area.minX, y], [area.maxX, y]));

  // The neighbourhood: what is on screen, the buildings next door far to near.
  const around = useMemo(() => {
    if (!context) return null;
    const near = nearby(context, plan, NEAR_REACH_M);
    const onScreen = (points: Point[]) => {
      const b = boundsOf(points);
      return b.maxX > 0 && b.minX < width && b.maxY > 0 && b.minY < height;
    };
    const ground = (polygon: Point[]) => {
      const screen = polygon.map((p) => toScreen(isoProject(iso, p, 0)));
      return screen.length > 2 && onScreen(screen) ? path(screen) : null;
    };
    const live = (d: string | null): d is string => !!d;
    const neighbours = near.buildings
      .map((item) => ({ item, depth: isoDepth(iso, centre(item.polygon)) }))
      .sort((a, b) => a.depth - b.depth)
      .flatMap(({ item }) => {
        const faces = floorFaces(iso, [item.polygon], 0, item.height_m, toScreen, NEXT_DOOR);
        return faces.some((face) => onScreen(face.points)) ? [faces] : [];
      });
    return {
      green: near.green.map(ground).filter(live),
      water: near.water.map(ground).filter(live),
      roads: near.roads.map((road) => ({ d: ground(ribbon(road.line, road.width_m / 2)), rail: road.kind === 'rail' }))
        .filter((road): road is { d: string; rail: boolean } => !!road.d),
      neighbours,
    };
  }, [context, outline, width, height]); // the projection follows from the outline and the view size

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

  // Zoom towards the chosen floor's top face.
  const target = focus ? toScreen(isoProject(iso, iso.centre, focus.elevation_m + focus.height_m)) : [width / 2, height / 2];
  const scaleAnim = zoom.interpolate({ inputRange: [0, 1], outputRange: [1, ZOOM_SCALE] });
  const shiftX = zoom.interpolate({ inputRange: [0, 1], outputRange: [0, (width / 2 - target[0]) * ZOOM_SCALE] });
  const shiftY = zoom.interpolate({ inputRange: [0, 1], outputRange: [0, (height / 2 - target[1]) * ZOOM_SCALE] });
  const fadeAbove = zoom.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: 'clamp' });
  const pick = onPickFloor && !focus
    ? ({ nativeEvent }: { nativeEvent: { pageX: number; pageY: number } }) =>
        frame.current?.measureInWindow((left, top) => {
          const floorId = floorAt(blocks, [nativeEvent.pageX - left, nativeEvent.pageY - top]);
          if (floorId) onPickFloor(floorId);
        })
    : undefined;

  return (
    <View ref={frame} style={{ width, height, backgroundColor: mapColours.background, overflow: 'hidden' }} testID="building-blocks">
      <Pressable testID="pick-floor" accessibilityLabel="Open a floor" onPress={pick} disabled={!pick}
                 style={{ width, height }}>
        <Animated.View style={{ width, height, transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale: scaleAnim }] }}>
          <Svg width={width} height={height}>
            <Path d={grid.join(' ')} stroke={mapColours.slabEdge} strokeOpacity={0.6} strokeWidth={0.6} fill="none" />
            {around && (
              <AnimatedG opacity={fadeAbove}>
                {around.green.map((d, i) => <Path key={`green-${i}`} d={d} fill={mapColours.green} />)}
                {around.water.map((d, i) => <Path key={`water-${i}`} d={d} fill={mapColours.water} />)}
                {around.roads.map((road, i) => (
                  <Path key={`road-${i}`} d={road.d} fill={road.rail ? mapColours.rail : mapColours.road}
                        stroke={mapColours.roadEdge} strokeWidth={0.4} />
                ))}
                {around.neighbours.map((faces, i) => (
                  <G key={`near-${i}`}>
                    {faces.map((face, j) => (
                      <Path key={j} d={face.d} fill={face.fill} stroke={mapColours.nearEdge} strokeWidth={0.5} strokeLinejoin="round" />
                    ))}
                  </G>
                ))}
              </AnimatedG>
            )}
            {/* a soft shadow under the building */}
            <Path
              d={path(floors[0]?.footprints[0]?.map((p) => toScreen(isoProject(iso, [p[0] + 1.5, p[1] - 1.5], 0))) ?? [])}
              fill={mapColours.shadow}
            />
            {floors.map((floor, i) => {
              const faces = blocks[i].faces;
              const above = !!focus && floor.elevation_m > focus.elevation_m;
              const content = faces.map((face, index) => (
                <G key={index}>
                  <Path d={face.d} fill={face.fill} stroke={mapColours.blockEdge} strokeWidth={0.8} strokeLinejoin="round" />
                  {face.bands?.map((band, row) => (
                    <Path key={row} d={band} stroke={mapColours.window} strokeWidth={Math.max(1.5, scale * 0.7)}
                          strokeDasharray={[scale * 0.9, scale * 0.6]} fill="none" />
                  ))}
                </G>
              ));
              return above ? (
                <AnimatedG key={floor.id} opacity={fadeAbove}>{content}</AnimatedG>
              ) : (
                <G key={floor.id}>{content}</G>
              );
            })}
            {/* the neighbourhood fades into the dark at the edges */}
            {around && (
              <>
                <Defs>
                  <RadialGradient id="vignette" cx="50%" cy="50%" r="60%">
                    <Stop offset="0.55" stopColor={mapColours.background} stopOpacity={0} />
                    <Stop offset="1" stopColor={mapColours.background} stopOpacity={1} />
                  </RadialGradient>
                </Defs>
                <Rect x={0} y={0} width={width} height={height} fill="url(#vignette)" />
              </>
            )}
          </Svg>
        </Animated.View>
      </Pressable>
    </View>
  );
}
