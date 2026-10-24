/** The building from outside, like the block style of a map: each floor a white block, stacked by elevation,
 * drawn as an isometric view with SVG (no 3D engine, so it runs the same on every phone and on the web).
 * When a floor is chosen the view zooms onto it, the floors above fade away, and onArrived() hands over to
 * the 2D floor view. */
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

import type { Outline, Point } from '../api';
import { boundsOf, isoDepth, isoProject, signedArea, type Iso } from '../geometry';
import { colours } from '../theme';

const ZOOM_MS = 1300;
const ZOOM_SCALE = 2.4;
const FLOOR_GAP = 0.08; // fraction of a floor's height left as a visible seam
const VIEW_ANGLE = Math.PI / 9; // a slight turn so two sides of the building show

interface Props {
  outline: Outline;
  focusFloorId: string | null;
  onArrived?: () => void;
  width: number;
  height: number;
}

interface Face {
  d: string;
  fill: string;
  depth: number;
}

const AnimatedG = Animated.createAnimatedComponent(G);

function path(points: Point[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ' Z';
}

/** Faces of one floor block in drawing order: the walls facing the viewer (far to near), then the top. */
function floorFaces(iso: Iso, footprints: Point[][], bottom: number, top: number, toScreen: (p: Point) => Point): Face[] {
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
      const shade = rx < ry ? colours.block : colours.blockSide; // left-facing walls lighter, right-facing darker
      walls.push({ d: path(quad), fill: shade, depth: (isoDepth(iso, a) + isoDepth(iso, b)) / 2 });
    }
    tops.push({ d: path(ring.map((p) => toScreen(isoProject(iso, p, top)))), fill: colours.blockTop, depth: Infinity });
  }
  walls.sort((x, y) => x.depth - y.depth);
  return [...walls, ...tops];
}

export function BuildingBlocks({ outline, focusFloorId, onArrived, width, height }: Props) {
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

  return (
    <View style={{ width, height, backgroundColor: colours.background, overflow: 'hidden' }} testID="building-blocks">
      <Animated.View style={{ width, height, transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale: scaleAnim }] }}>
        <Svg width={width} height={height}>
          {/* a soft shadow under the building */}
          <Path
            d={path(floors[0]?.footprints[0]?.map((p) => toScreen(isoProject(iso, [p[0] + 1.5, p[1] - 1.5], 0))) ?? [])}
            fill={colours.blockShadow}
          />
          {floors.map((floor) => {
            const faces = floorFaces(iso, floor.footprints, floor.elevation_m,
                                     floor.elevation_m + floor.height_m * (1 - FLOOR_GAP), toScreen);
            const above = !!focus && floor.elevation_m > focus.elevation_m;
            const content = faces.map((face, index) => (
              <Path key={index} d={face.d} fill={face.fill} stroke={colours.blockEdge} strokeWidth={0.7} strokeLinejoin="round" />
            ));
            return above ? (
              <AnimatedG key={floor.id} opacity={fadeAbove}>{content}</AnimatedG>
            ) : (
              <G key={floor.id}>{content}</G>
            );
          })}
        </Svg>
      </Animated.View>
    </View>
  );
}
