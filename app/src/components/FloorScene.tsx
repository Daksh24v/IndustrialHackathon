/** One floor in 3D: the camera looks down at an angle with perspective, rooms are tiles on a floor slab with the
 * floor they really have (tiles in the bathrooms, a checkerboard in the kitchen, planks at home), walls with
 * thickness stand full height on the far side and cut down elsewhere so you see into the rooms (the cut drawn as a
 * cap, as on an architect's plan), doors stand open with their swing on the floor, stairs are real steps up (and down
 * into the floor below), and every thing in the rooms is a small block model of what it is (models/catalog.ts):
 * the closer you get, the more detail. The route is an orange band on the floor with arrows flowing along it, the
 * target is a pin and you are an orange disc on the floor. Below, on the ground, the OpenStreetMap neighbourhood
 * when there is one: streets, green, water and next door's outlines.
 * Drawn with SVG (no 3D engine: those crash Expo Go on iPhones). Drag to turn (mouse) or move (touch), Shift+drag
 * or right-drag to move, wheel / pinch / +/− to zoom. */
import { type ComponentRef, type MutableRefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Path, Rect, Text as SvgText } from 'react-native-svg';

import type { BuildingDetail, Context, MapView, Point } from '../api';
import { assetsOn, changesOn } from '../changes';
import { finishOf, finishPattern } from '../finishes';
import {
  assetRect, boundsOf, chooseCamera, clipNear, depthOf, fitCamera, grow, moveCamera, nearby, recentre, pixelsPerMetre, pointInPolygon,
  project3d, ribbon, rotateAbout, signedArea, unproject3d, type Camera, type Point3,
} from '../geometry';
import { useMapGestures } from '../gestures';
import { modelOf, SITS_ON_SURFACE, surfaceOf } from '../models/catalog';
import type { Part } from '../models/kit';
import { colourOf } from '../models/materials';
import { cameraView, modelFaces } from '../models/render';
import { flatStairs, layoutStairs, liftCar, stairClimb, stairInput } from '../stairs';
import { colours, map as mapColours, nearStyle, roomStyle } from '../theme';
import { doorLeaves, entranceMarks, floorWalls, leafParts, wallHeight, type WallMode, wallParts, wallShadow } from '../walls';
import type { MapHandle } from '../ui/MapControls';
import { safetyMarks } from '../safety';
import { landmarkNames, routeSpaces, routeSteps } from '../steps';
import { ChangeMarks, HereMarker, SafetyMarks, TargetPin, useLoop } from './Markers';
import { GroundLayers, groundOf } from './Neighbourhood';

export const TILT = (52 * Math.PI) / 180;
/** The bird's-eye view: almost straight down, the walls still standing so the rooms read. */
export const TOP_TILT = (8 * Math.PI) / 180;
const WALL_M = 1.1;
const SLAB_M = 0.5;
const FOCUS_MARGIN_M = 4;
const MIN_LABEL_PX = 38;
const MARGIN_PX = 120; // drawn beyond the edges, so dragging doesn't show blank space
const TURN_MS = 450;
const MIN_ASSET_PX = 3; // things smaller than this on screen aren't drawn
/** Pixels per metre where a thing shows more: below the first only its footprint, then its shape, then the
 * model, then the small details (handles, burners, books). */
const DETAIL_PX = [5, 13, 30];
const DETAIL_BUDGET = [Infinity, 900, 260]; // at most this many things with the model / with every detail
const FINISH_PX = 16; // floor tiles and planks show from this close
const SHARP_MS = 140; // after turning or flying stops, the scene is drawn once more in full detail
/** More faces than this (a whole big floor) and the faces of one colour are drawn as one shape, far to near by
 * colour rather than face by face: hundreds of shapes instead of thousands, so it stays smooth. */
const FACE_BUDGET = 2400;
const FACE_BUDGET_BUSY = 1200;
const CHAIRS = new Set(['chair', 'office_chair', 'dining_chair', 'outdoor_chair', 'armchair']);
const TABLES = new Set(['desk', 'meeting_table', 'dining_table', 'seminar_table', 'canteen_table', 'reading_table', 'coffee_table',
                        'outdoor_table', 'lab_bench', 'workbench', 'reception_desk', 'lecture_seating_row']);
const GRID_M = 5;
const GRID_REACH_M = 40; // how far the ground grid reaches beyond the building
const NEAR_REACH_M = 150; // how much of the neighbourhood is drawn
const DRAG_TURN = 0.006; // radians per pixel of a turning drag
const TAP_SLOP_PX = 5;
const DRAG_TILT = 0.005; // radians per pixel dragged up or down: down looks more from above, up more from the side
const TILT_MAX = (72 * Math.PI) / 180;

/** The camera turned by `angle` and leaned to `tilt` about a plan point that stays where it is on the screen. */
export function orbit(cam: Camera, pivot: Point, angle: number, tilt: number): Camera {
  const turned = rotateAbout(cam, pivot, angle);
  const leaned = { ...turned, tilt: Math.min(TILT_MAX, Math.max(0, tilt)) };
  const [x0, y0] = project3d(turned, pivot);
  const [x1, y1] = project3d(leaned, pivot);
  return { ...leaned, ox: leaned.ox + x0 - x1, oy: leaned.oy + y0 - y1 };
} // a click that moves less than this is a tap ("I'm here")
const FLY_MS = 700; // walking through the steps: the camera moves to the next one
const STEP_MARGIN_M = 3;
export const SAFETY_DIM = 0.28; // how much of the map stays visible in safety mode
const STEP_MIN_M = 10; // a step is shown with at least this much floor around it
const ROOM_MARGIN_M = 1.5; // a double-clicked room is framed with this much around it
const DOUBLE_MS = 260; // a click waits this long for a second one (a double-click flies there instead of "I'm here")
/** How far you can zoom, from the fitted view: out to see it all small, in to a chair's armrest. */
export const ZOOM_OUT = 0.3;
export const ZOOM_IN = 40;

/** A zoom by k, cut short so the scale stays between ZOOM_OUT and ZOOM_IN times the fitted one. */
export function limitZoom(k: number, scale: number, fittedScale: number): number {
  const next = Math.min(fittedScale * ZOOM_IN, Math.max(fittedScale * ZOOM_OUT, scale * k));
  return next / scale;
}

/** A move (zoom about a point, which shifts the view too) with its zoom cut short at the limits: the shift is cut
 * by as much, so at the limit the wheel stops instead of sliding the map away. */
export function limitMove({ k, tx, ty }: { k: number; tx: number; ty: number }, scale: number, fittedScale: number) {
  const limited = limitZoom(k, scale, fittedScale);
  if (Math.abs(k - 1) < 1e-9 || Math.abs(limited - k) < 1e-9) return { k, tx, ty };
  const cut = (1 - limited) / (1 - k);
  return { k: limited, tx: tx * cut, ty: ty * cut };
}

/** The room under a plan point: the smallest one, so a room inside a hall wins over the hall. */
export function roomAt<T extends { polygon: Point[]; area_m2: number; type: string }>(spaces: T[], point: Point): T | null {
  const under = spaces.filter((space) => space.type !== 'outdoor' && pointInPolygon(point, space.polygon));
  return under.reduce<T | null>((best, space) => (!best || space.area_m2 < best.area_m2 ? space : best), null);
}

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
  context?: Context | null;
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
  /** Safety mode: everything dims but exits, extinguishers, defibrillators, eyewash stations and the stairs. */
  safety?: boolean;
  /** How the walls stand: cut away so you see in (default), all low, or all full height. */
  walls?: WallMode;
}

type SignKind = 'wc' | 'kitchen' | 'stairs' | 'lift' | 'meeting' | 'exit';

/** The rooms people look for get a small sign by their name (exit: a room with a way out of the building). */
function signOf(space: { id: string; type: string; room_type: string }, exits: Set<string>): SignKind | null {
  if (exits.has(space.id)) return 'exit';
  if (space.room_type === 'toilet' || space.room_type === 'bathroom') return 'wc';
  if (space.room_type === 'kitchen' || space.room_type === 'canteen') return 'kitchen';
  if (space.type === 'stair' || space.room_type === 'stairwell') return 'stairs';
  if (space.type === 'lift') return 'lift';
  if (space.room_type === 'meeting_room' || space.room_type === 'seminar_room') return 'meeting';
  return null;
}

const SIGN_COLOURS: Record<SignKind, string> = {
  wc: '#2F80ED', kitchen: '#B565D9', stairs: '#2E9E5B', lift: '#3B82F6', meeting: '#5B6CFF', exit: '#1E8E4E',
};
/** Exits and stairs are the way out: their names go first after the target's. */
const ESCAPE = new Set<SignKind>(['exit', 'stairs']);

/** A round sign: WC, a cup, steps, a lift's arrows, a table. */
function Sign({ kind, x, y, size }: { kind: SignKind; x: number; y: number; size: number }) {
  const r = size / 2;
  const s = r * 0.55;
  const glyph: Record<SignKind, string> = {
    wc: '',
    kitchen: `M${x - s * 0.7} ${y - s * 0.5} L${x + s * 0.5} ${y - s * 0.5} L${x + s * 0.35} ${y + s * 0.7} L${x - s * 0.55} ${y + s * 0.7} Z ` +
             `M${x + s * 0.5} ${y - s * 0.2} L${x + s * 0.95} ${y - s * 0.2} L${x + s * 0.95} ${y + s * 0.3} L${x + s * 0.4} ${y + s * 0.3}`,
    stairs: `M${x - s} ${y + s * 0.8} L${x - s * 0.4} ${y + s * 0.8} L${x - s * 0.4} ${y + s * 0.2} L${x + s * 0.2} ${y + s * 0.2} ` +
            `L${x + s * 0.2} ${y - s * 0.4} L${x + s * 0.8} ${y - s * 0.4} L${x + s * 0.8} ${y - s}`,
    lift: `M${x} ${y - s} L${x + s * 0.6} ${y - s * 0.15} L${x - s * 0.6} ${y - s * 0.15} Z M${x} ${y + s} L${x + s * 0.6} ${y + s * 0.15} ` +
          `L${x - s * 0.6} ${y + s * 0.15} Z`,
    meeting: `M${x - s} ${y - s * 0.2} L${x + s} ${y - s * 0.2} M${x - s * 0.6} ${y - s * 0.2} L${x - s * 0.6} ${y + s * 0.8} ` +
             `M${x + s * 0.6} ${y - s * 0.2} L${x + s * 0.6} ${y + s * 0.8}`,
    // a door with an arrow going out through it
    exit: `M${x - s * 0.9} ${y + s} L${x - s * 0.9} ${y - s} L${x + s * 0.1} ${y - s} M${x + s * 0.1} ${y + s} L${x - s * 0.9} ${y + s} ` +
          `M${x - s * 0.3} ${y} L${x + s} ${y} M${x + s * 0.6} ${y - s * 0.4} L${x + s} ${y} L${x + s * 0.6} ${y + s * 0.4}`,
  };
  return (
    <G>
      <Circle cx={x} cy={y} r={r} fill={SIGN_COLOURS[kind]} stroke={mapColours.background} strokeWidth={1} />
      {kind === 'wc' ? (
        <SvgText x={x} y={y + r * 0.35} fontSize={r * 0.95} fontWeight="700" fontFamily={LABEL_FONT} textAnchor="middle" fill="#FFFFFF">WC</SvgText>
      ) : (
        <Path d={glyph[kind]} stroke="#FFFFFF" strokeWidth={Math.max(1, r * 0.18)} fill={kind === 'lift' ? '#FFFFFF' : 'none'}
              strokeLinejoin="round" strokeLinecap="round" />
      )}
    </G>
  );
}

/** Text with a halo in the map's background colour, so it reads over the models. */
function Halo({ x, y, size, fill, text, bold = false }: { x: number; y: number; size: number; fill: string; text: string; bold?: boolean }) {
  const common = { x, y, fontSize: size, fontFamily: LABEL_FONT, textAnchor: 'middle' as const, fontWeight: bold ? '700' : '400' };
  return (
    <>
      <SvgText {...common} fill={mapColours.background} stroke={mapColours.background} strokeWidth={2.5} strokeOpacity={0.85}>{text}</SvgText>
      <SvgText {...common} fill={fill}>{text}</SvgText>
    </>
  );
}

const n = (value: number) => (Math.round(value * 10) / 10).toString();

/** A rectangle grown by m on every side (about its middle). */
function grow4(rect: Point[], m: number): Point[] {
  const cx = rect.reduce((sum, p) => sum + p[0], 0) / rect.length;
  const cy = rect.reduce((sum, p) => sum + p[1], 0) / rect.length;
  return rect.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / l) * m, y + ((y - cy) / l) * m] as Point;
  });
}

function path(points: Point[], close = true): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join(' ') + (close ? ' Z' : '');
}

interface Solid {
  depth: number; // bigger = farther, drawn first
  faces: { d: string; fill: string; stroke: string; opacity?: number }[];
  opacity?: number; // things off the route fade
}

/** What is finally drawn: one path, maybe many faces of the same colour. */
interface Drawn {
  key: string;
  d: string;
  fill: string;
  fillOpacity: number;
  stroke: string;
  opacity: number;
}

const BANDS = 24; // past the budget: far to near in this many bands, one path per colour in each

/** The solids, far to near, as paths: face by face (faces next to each other in the same colour joined), or, past
 * the budget, one path per colour within each band of distance (so near things still cover far ones). */
export function drawSolids(solids: Solid[], budget: number): Drawn[] {
  const count = solids.reduce((sum, solid) => sum + solid.faces.length, 0);
  const out: Drawn[] = [];
  if (count > budget) {
    const per = Math.ceil(solids.length / BANDS);
    for (let band = 0; band * per < solids.length; band += 1) {
      const groups = new Map<string, Drawn>();
      for (const solid of solids.slice(band * per, (band + 1) * per)) {
        for (const face of solid.faces) {
          const key = `${band}|${face.fill}|${face.opacity ?? 1}|${solid.opacity ?? 1}`;
          const group = groups.get(key);
          if (group) group.d += ` ${face.d}`;
          else groups.set(key, { key, d: face.d, fill: face.fill, fillOpacity: face.opacity ?? 1, stroke: face.stroke, opacity: solid.opacity ?? 1 });
        }
      }
      out.push(...groups.values());
    }
    return out;
  }
  solids.forEach((solid, i) => {
    let last: Drawn | null = null;
    solid.faces.forEach((face, j) => {
      if (last && last.fill === face.fill && last.stroke === face.stroke && last.fillOpacity === (face.opacity ?? 1)) {
        last.d += ` ${face.d}`;
        return;
      }
      last = { key: `${i}-${j}`, d: face.d, fill: face.fill, fillOpacity: face.opacity ?? 1, stroke: face.stroke, opacity: solid.opacity ?? 1 };
      out.push(last);
    });
  });
  return out;
}

/** Where each thing stands and which way it looks: chairs turned to face their table (the data doesn't say which
 * way a chair faces), small appliances lifted onto the counter or desk they stand on. */
export function placeThings<T extends { id: string; type: string; space_id: string; position: Point;
                                        footprint: { width_m: number; depth_m: number; rotation_deg: number } }>(assets: T[]) {
  const surfaces = assets.filter((asset) => surfaceOf(asset.type) !== null);
  const tables = assets.filter((asset) => TABLES.has(asset.type));
  return new Map(assets.map((asset) => {
    let angle = (asset.footprint.rotation_deg * Math.PI) / 180;
    let z = 0;
    if (CHAIRS.has(asset.type)) {
      let best: { d: number; to: Point } | null = null;
      for (const table of tables) {
        if (table.space_id !== asset.space_id) continue;
        const to: Point = [table.position[0] - asset.position[0], table.position[1] - asset.position[1]];
        const reach = 1.5 + Math.max(table.footprint.width_m, table.footprint.depth_m) / 2;
        const d = Math.hypot(to[0], to[1]);
        if (d < reach && (!best || d < best.d)) best = { d, to };
      }
      if (best) {
        // face the table squarely: the front (-y) turned to the nearest quarter towards it
        // (half turns only for a chair that isn't square, so it keeps its footprint)
        const exact = Math.atan2(best.to[0], -best.to[1]);
        const step = Math.abs(asset.footprint.width_m - asset.footprint.depth_m) > 0.05 ? Math.PI : Math.PI / 2;
        angle += Math.round((exact - angle) / step) * step;
      }
    }
    if (SITS_ON_SURFACE.has(asset.type)) {
      for (const surface of surfaces) {
        if (surface === asset || surface.space_id !== asset.space_id) continue;
        if (pointInPolygon(asset.position, assetRect(surface.position, surface.footprint))) z = Math.max(z, surfaceOf(surface.type)!);
      }
    }
    return [asset.id, { angle, z }] as const;
  }));
}

const OFF_ROUTE = 0.28; // with a route: things in rooms you don't pass fade to this

export function FloorScene({ detail, floorId, map, footprints, context, width, height, onTapFloor, controls = true, handleRef,
                            inset = NO_INSET, highlight, focus, tilt = TILT, safety = false, walls: wallMode = 'cutaway' }: Props) {
  const marks = useMemo(() => (safety ? safetyMarks(detail, floorId) : []), [safety, detail, floorId]);
  // Along a route: the things in the rooms you pass stay bright, the thing you're looking for turns orange with its
  // name, a landmark named in the steps gets its name too; everything else fades.
  const onWay = useMemo(() => routeSpaces(map, detail), [map, detail]);
  const named = useMemo(() => landmarkNames(routeSteps(map, detail)), [map, detail]);
  const dim = safety ? SAFETY_DIM : 1;
  const spaces = useMemo(() => detail.spaces.filter((space) => space.floor_id === floorId), [detail, floorId]);
  const openings = useMemo(() => detail.openings.filter((opening) => opening.floor_id === floorId), [detail, floorId]);
  const changes = useMemo(() => changesOn(detail, map, floorId), [detail, map, floorId]);
  const newDoors = map?.changes?.new_doors;
  const storey = detail.floors.find((floor) => floor.id === floorId)?.height_m ?? 3;
  const walls = useMemo(() => {
    const added = (newDoors ?? []).filter((door) => door.floor_id === floorId); // a new door cuts a gap too
    return floorWalls(spaces, [...openings, ...added], footprints);
  }, [spaces, openings, newDoors, floorId, footprints]);
  const leaves = useMemo(() => doorLeaves(openings, spaces, walls), [openings, spaces, walls]);
  const entrances = useMemo(() => entranceMarks(openings, spaces, walls), [openings, spaces, walls]);
  const wallShadows = useMemo(() => walls.map((wall) => ({ centre: wall.centre, ring: wallShadow(wall) })), [walls]);
  const stairs = useMemo(() => spaces.flatMap((space) => {
    if (space.type !== 'stair') return [];
    const laid = layoutStairs(stairInput(detail, space));
    return laid ? [{ id: space.id, ...laid }] : [];
  }), [spaces, detail]);
  // Stairwells too irregular for real flights: flat treads and an arrow.
  const flatStairwells = useMemo(() => spaces.flatMap((space) => {
    if (space.type !== 'stair' && space.room_type !== 'stairwell') return [];
    if (stairs.some((stair) => stair.id === space.id)) return [];
    const flat = flatStairs(stairInput(detail, space));
    return flat ? [{ id: space.id, centre: space.anchor, ...flat }] : [];
  }), [spaces, detail, stairs]);
  const lifts = useMemo(() => spaces.flatMap((space) => {
    if (space.type !== 'lift') return [];
    const doors = detail.openings.filter((opening) => opening.space_ids.includes(space.id)).map((opening) => opening.position);
    const car = liftCar(space.polygon, doors);
    return car ? [car] : [];
  }), [spaces, detail]);
  const assets = useMemo(() => assetsOn(detail, map, floorId), [detail, map, floorId]);
  const exits = useMemo(() => new Set(openings.filter((opening) => opening.kind === 'entrance').flatMap((opening) => opening.space_ids)),
    [openings]);
  const placed = useMemo(() => placeThings(assets), [assets]);
  const roomOf = useMemo(() => new Map(spaces.map((space) => [space.id, space.room_type])), [spaces]);
  const finishes = useMemo(() => spaces.flatMap((space) => {
    const finish = finishOf(space);
    return finish ? [{ id: space.id, anchor: space.anchor, ...finishPattern(space, finish), kind: finish.kind }] : [];
  }), [spaces]);
  // Walls and door leaves as parts, kept per height (the cut changes as the view turns).
  const wallCache = useMemo(() => new Map<string, Part[]>(), [walls]);
  // Turning by hand or flying: drawn with a little less detail, then once more sharp when it stops.
  const busy = useRef(false);
  const [sharp, setSharp] = useState(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moving = () => {
    busy.current = true;
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      busy.current = false;
      setSharp((k) => k + 1);
    }, SHARP_MS);
  };
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);
  const around = useMemo(
    () => (context && footprints.length ? nearby(context, boundsOf(footprints.flat()), NEAR_REACH_M) : null),
    [context, footprints],
  );
  const pieces = useMemo(() => (map?.route?.pieces ?? []).filter((piece) => piece.floor_id === floorId), [map, floorId]);
  // The route on this floor, with its way up or down the stairs following the steps: on the flight up when it goes
  // on to the floor above, rising out of the opening when it came up from the floor below (and the other way down).
  const ways = useMemo(() => {
    const all = map?.route?.pieces ?? [];
    const elevation = new Map(detail.floors.map((floor) => [floor.id, floor.elevation_m]));
    const polygonOf = new Map(spaces.map((space) => [space.id, space.polygon]));
    const wellAt = (p: Point | undefined) => (p ? stairs.find((stair) => pointInPolygon(p, polygonOf.get(stair.id) ?? [])) : undefined);
    const higher = (a: string, b: string) => (elevation.get(a) ?? 0) > (elevation.get(b) ?? 0);
    return all.flatMap((piece, i) => {
      if (piece.floor_id !== floorId) return [];
      let flat = piece.points;
      const climbs: Point3[][] = [];
      const to = piece.then?.kind === 'stairs' ? piece.then.to_floor_id : undefined;
      const goingWell = to ? wellAt(flat[flat.length - 1]) : undefined;
      const going = to && goingWell?.arrows.find((arrow) => arrow.up === higher(to, floorId));
      if (goingWell && going) {
        const way = stairClimb(flat, polygonOf.get(goingWell.id)!, going.points, true);
        flat = way.flat;
        if (way.climb.length) climbs.push(way.climb);
      }
      const before = all[i - 1];
      const from = before?.then?.kind === 'stairs' && before.floor_id !== floorId ? before.floor_id : undefined;
      const comingWell = from ? wellAt(flat[0]) : undefined;
      const coming = from && comingWell?.arrows.find((arrow) => arrow.up === higher(from, floorId)); // up from below: out of the opening
      if (comingWell && coming) {
        const way = stairClimb(flat, polygonOf.get(comingWell.id)!, coming.points, false);
        flat = way.flat;
        if (way.climb.length) climbs.push(way.climb);
      }
      return [{ flat, climbs }];
    });
  }, [map, detail, spaces, stairs, floorId]);
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
  // A tap says "I'm here", a double tap flies to the room: so a tap waits a moment for a second one.
  const lastTap = useRef<{ at: [number, number]; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => () => {
    if (lastTap.current) clearTimeout(lastTap.current.timer);
  }, []);
  const tapped = onTapFloor
    ? ([pageX, pageY]: [number, number]) =>
        frame.current?.measureInWindow((left, top) => {
          const point = unproject3d(camera.current, [pageX - left, pageY - top]);
          const before = lastTap.current;
          if (before) clearTimeout(before.timer);
          if (before && Math.hypot(before.at[0] - pageX, before.at[1] - pageY) < 30) {
            lastTap.current = null;
            flyToRoomRef.current(point);
            return;
          }
          lastTap.current = { at: [pageX, pageY], timer: setTimeout(() => {
            lastTap.current = null;
            onTapFloor(floorId, point);
          }, DOUBLE_MS) };
        })
    : undefined;
  const fittedScale = useRef(fitted.scale);
  fittedScale.current = fitted.scale;
  const gestures = useMapGestures(width, height, (move) => setCam((current) => {
    const { k, tx, ty } = limitMove(move, current.scale, fittedScale.current);
    return recentre(moveCamera(current, k, tx, ty, width, height), middleRef.current());
  }), tapped, frame);
  const zoomBy = (k: number) =>
    setCam((current) => recentre(moveCamera(current, limitZoom(k, current.scale, fittedScale.current), 0, 0, width, height),
                                 middleRef.current()));

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
      moving();
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
        return (angle) => {
          moving();
          setCam(rotateAbout(start, pivot, angle));
        };
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

  // Fly the camera to a box on the plan, from the side `yaw` looks, leaning `lean`.
  const flying = useRef<number | null>(null);
  const flyTo = (box: ReturnType<typeof boundsOf>, yaw: number, lean: number) => {
    const corners: Point3[] = [];
    for (const x of [box.minX, box.maxX]) for (const y of [box.minY, box.maxY]) corners.push([x, y, 0], [x, y, WALL_M]);
    const goal = inside(fitCamera(corners, width - inset.left - inset.right, height - inset.top - inset.bottom, yaw, lean, 24), inset);
    const from = camera.current;
    const turnBy = wrapAngle(goal.yaw - from.yaw);
    const began = Date.now();
    const mix = (x: number, y: number, t: number) => x + (y - x) * t;
    const step = () => {
      const t = Easing.inOut(Easing.cubic)(Math.min(1, (Date.now() - began) / FLY_MS));
      moving();
      setCam({
        ...goal, yaw: from.yaw + turnBy * t, tilt: mix(from.tilt, goal.tilt, t),
        target: [mix(from.target[0], goal.target[0], t), mix(from.target[1], goal.target[1], t)],
        distance: mix(from.distance, goal.distance, t), scale: mix(from.scale, goal.scale, t), ox: mix(from.ox, goal.ox, t),
        oy: mix(from.oy, goal.oy, t),
      });
      flying.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    if (flying.current !== null) cancelAnimationFrame(flying.current);
    flying.current = requestAnimationFrame(step);
  };
  useEffect(() => () => {
    if (flying.current !== null) cancelAnimationFrame(flying.current);
    flying.current = null;
  }, []);

  // Walking through the steps: fly to the stretch, turned so that it goes up the screen (the way you walk).
  useEffect(() => {
    if (!focus?.length) return;
    const [a, b] = [focus[0], focus[focus.length - 1]];
    const along = Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5;
    flyTo(atLeast(grow(boundsOf(focus), STEP_MARGIN_M), STEP_MIN_M), along ? Math.atan2(b[0] - a[0], b[1] - a[1]) : camera.current.yaw, tilt);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps -- a new stretch only

  // A double-click on a room flies to it, keeping the way you look.
  const flyToRoom = (point: Point) => {
    const room = roomAt(spaces, point);
    if (room) flyTo(grow(boundsOf(room.polygon), ROOM_MARGIN_M), camera.current.yaw, camera.current.tilt);
  };
  const flyToRoomRef = useRef(flyToRoom);
  flyToRoomRef.current = flyToRoom;

  // Hover (web): the room under the mouse lights up, and a pill names the thing (and its room) or the room.
  const [hover, setHover] = useState<{ x: number; y: number; text: string; roomId: string | null } | null>(null);
  const hoverAt = (point: Point, x: number, y: number) => {
    const room = roomAt(spaces, point);
    let thing: { name: string; area: number } | null = null;
    for (const asset of assets) {
      const angle = placed.get(asset.id)?.angle ?? (asset.footprint.rotation_deg * Math.PI) / 180;
      if (!pointInPolygon(point, assetRect(asset.position, { ...asset.footprint, rotation_deg: (angle * 180) / Math.PI }))) continue;
      const area = asset.footprint.width_m * asset.footprint.depth_m;
      if (!thing || area < thing.area) thing = { name: asset.name, area };
    }
    const text = thing ? (room ? `${thing.name} · ${room.name}` : thing.name) : room?.name;
    setHover((current) => (text ? (current?.text === text && current.roomId === (room?.id ?? null) && Math.abs(current.x - x) < 1
      && Math.abs(current.y - y) < 1 ? current : { x, y, text, roomId: room?.id ?? null }) : null));
  };
  const hoverRef = useRef(hoverAt);
  hoverRef.current = hoverAt;

  // With a mouse: hold and drag to turn it all the way round; Shift+drag or right-drag moves it; a click without
  // dragging is "I'm here". On a touch screen one finger moves it and a two-finger twist turns it.
  const tapRef = useRef<((point: Point) => void) | null>(null);
  tapRef.current = onTapFloor ? (point) => onTapFloor(floorId, point) : null;
  useEffect(() => {
    const node = frame.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    let drag: { mode: 'turn' | 'move'; x: number; y: number; start: Camera; pivot: Point; id: number; moved: boolean } | null = null;
    const pivotOf = (cam: Camera) => unproject3d(cam, middleRef.current());
    node.style.cursor = 'grab';
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const mode = event.button === 2 ? 'move' : event.button === 0 && !event.shiftKey ? 'turn' : null;
      if (!mode) return; // Shift+drag: the usual pan
      event.preventDefault(); // the drag is ours (no pan underneath)
      drag = { mode, x: event.clientX, y: event.clientY, start: camera.current, pivot: pivotOf(camera.current), id: event.pointerId, moved: false };
      node.setPointerCapture?.(event.pointerId);
      node.style.cursor = 'grabbing';
    };
    let hoverFrame: number | null = null;
    const onMove = (event: PointerEvent) => {
      if (!drag && event.pointerType === 'mouse') {
        const [cx, cy] = [event.clientX, event.clientY];
        if (hoverFrame === null) hoverFrame = requestAnimationFrame(() => {
          hoverFrame = null;
          const box = node.getBoundingClientRect();
          const at: Point = [cx - box.left, cy - box.top];
          hoverRef.current(unproject3d(camera.current, at), at[0], at[1]);
        });
      }
      if (drag) setHover(null);
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP_PX) drag.moved = true;
      if (!drag.moved) return;
      moving();
      if (drag.mode === 'turn') setCam(orbit(drag.start, drag.pivot, dx * DRAG_TURN, drag.start.tilt - dy * DRAG_TILT));
      else setCam(recentre(moveCamera(drag.start, 1, dx, dy, size.current.width, size.current.height), middleRef.current()));
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const was = drag;
      drag = null;
      node.style.cursor = 'grab';
      if (was.mode === 'turn' && !was.moved && tapRef.current) {
        const box = node.getBoundingClientRect();
        const point = unproject3d(camera.current, [event.clientX - box.left, event.clientY - box.top]);
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          tapRef.current?.(point);
        }, DOUBLE_MS);
      }
    };
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onDouble = (event: MouseEvent) => {
      if (pending) clearTimeout(pending); // not "I'm here": the double-click flies there
      pending = null;
      const box = node.getBoundingClientRect();
      flyToRoomRef.current(unproject3d(camera.current, [event.clientX - box.left, event.clientY - box.top]));
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
      else {
        moving();
        setCam(rotateAbout(twist.start, twist.pivot, twist.angle - touchAngle(event)));
      }
    };
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('contextmenu', noMenu);
    node.addEventListener('dblclick', onDouble);
    const onLeave = () => setHover(null);
    node.addEventListener('pointerleave', onLeave);
    node.addEventListener('touchmove', onTouch, { passive: true });
    node.addEventListener('touchend', onTouch);
    return () => {
      if (pending) clearTimeout(pending);
      node.removeEventListener('dblclick', onDouble);
      node.removeEventListener('pointerleave', onLeave);
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
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

    // A faint grid on the ground around the building.
    const area = grow(boundsOf(footprints.flat()), GRID_REACH_M);
    const grid: string[] = [];
    const gridLine = (a: Point, b: Point) => {
      const seen = clipNear(cam, [a, b], -SLAB_M);
      if (seen.length < 2) return;
      const [p, q] = seen.map((point) => project3d(cam, point, -SLAB_M));
      grid.push(`M${n(p[0])} ${n(p[1])} L${n(q[0])} ${n(q[1])}`);
    };
    for (let x = Math.ceil(area.minX / GRID_M) * GRID_M; x <= area.maxX; x += GRID_M) gridLine([x, area.minY], [x, area.maxY]);
    for (let y = Math.ceil(area.minY / GRID_M) * GRID_M; y <= area.maxY; y += GRID_M) gridLine([area.minX, y], [area.maxX, y]);

    // The neighbourhood on the ground, under the slab; next door as flat outlines, so it never hides the floor.
    const ground = (polygon: Point[]) => (polygon.length > 2 ? flat(polygon, -SLAB_M) : null);
    const near = around && {
      ground: groundOf(around, ground, (p) => (depthOf(cam, p, -SLAB_M) > cam.distance * 0.3
        ? { at: project3d(cam, p, -SLAB_M), ppm: pixelsPerMetre(cam, p, -SLAB_M) } : null)),
      buildings: around.buildings.flatMap((item) => {
        const d = ground(item.polygon);
        return d ? [{ d, ...nearStyle(item.kind) }] : [];
      }),
    };

    const view = cameraView(cam);
    const seen = (p: Point) => depthOf(cam, p) > cam.distance * 0.3;
    const tiles = spaces.map((space) => {
      const closed = changes.closedSpaces.has(space.id);
      const style = roomStyle(space);
      return { id: space.id, d: flat(space.polygon), closed, fill: closed ? mapColours.closedFaint : style.fill,
               edge: closed ? colours.closed : style.edge };
    }).filter((tile) => tile.d);

    // The floor finishes, close up: lines (and a checkerboard's dark squares) clipped to the room.
    const tileOf = new Map(tiles.map((tile) => [tile.id, tile.d!]));
    const floorings = finishes.flatMap((finish) => {
      const room = tileOf.get(finish.id);
      if (!room || !seen(finish.anchor) || pixelsPerMetre(cam, finish.anchor) < FINISH_PX) return [];
      const lines = finish.lines.filter(([a, b]) => seen(a) && seen(b))
        .map(([a, b]) => path([project3d(cam, a, 0.005), project3d(cam, b, 0.005)], false)).join(' ');
      const squares = finish.squares.filter((square) => square.every(seen))
        .map((square) => path(square.map((p) => project3d(cam, p, 0.005)))).join(' ');
      return [{ id: finish.id, clip: room, lines, squares, kind: finish.kind }];
    });

    const lit = highlight && highlight.length > 1 ? flat(ribbon(highlight, 0.5), 0.035) : null;
    const routes = ways.map((way) => ({
      glow: flat(ribbon(way.flat, 1.1), 0.02),
      band: flat(ribbon(way.flat, 0.42), 0.03),
      line: path(way.flat.filter((p) => depthOf(cam, p) > cam.distance * 0.3).map((p) => project3d(cam, p, 0.04)), false),
    }));
    // On the stairs: the band step by step at each tread's height, drawn over the steps.
    const climbs = ways.flatMap((way) => way.climbs).map((climb) => {
      const steps = climb.slice(1).map((b, i) => {
        const a = climb[i];
        return flat(ribbon([[a[0], a[1]], [b[0], b[1]]], 0.42), Math.max(a[2], b[2]) + 0.03);
      }).filter(Boolean).join(' ');
      const line = path(climb.filter(([x, y]) => depthOf(cam, [x, y]) > cam.distance * 0.3)
        .map(([x, y, z]) => project3d(cam, [x, y], z + 0.04)), false);
      return { steps, line };
    });

    const solids: Solid[] = [];
    const facesOf = (faces: ReturnType<typeof modelFaces>) => faces.map(({ d, fill, stroke, opacity }) => ({ d, fill, stroke, opacity }));
    const nearPpm = pixelsPerMetre(cam, cam.target);
    const wallDetail = nearPpm < DETAIL_PX[1] ? 0 : nearPpm < DETAIL_PX[2] ? 1 : 2;

    // Walls: full height on the far side of the building (with its windows), cut down elsewhere, far to near.
    for (const wall of walls) {
      if (!seen(wall.a) || !seen(wall.b)) continue;
      const tall = wallHeight(wall, view.toViewer(wall.centre), wallMode, storey);
      const ends = [project3d(cam, wall.a, 0), project3d(cam, wall.b, 0), project3d(cam, wall.a, tall), project3d(cam, wall.b, tall)];
      if (!onScreen(ends)) continue;
      const key = `${wall.key}|${tall.toFixed(2)}`;
      let parts = wallCache.get(key);
      if (!parts) {
        parts = wallParts(wall, tall);
        wallCache.set(key, parts);
      }
      solids.push({ faces: facesOf(modelFaces(`wall|${wall.length.toFixed(2)}|${wall.outer}|${key}`, parts,
                                               { at: wall.centre, angle: wall.angle }, view, wallDetail)),
                    depth: depthOf(cam, wall.a) + depthOf(cam, wall.b) });
    }

    // The soft shadow along the foot of every wall, close up: it grounds them.
    const wallFeet = nearPpm < DETAIL_PX[1] ? '' : wallShadows.filter((foot) => seen(foot.centre))
      .map((foot) => flat(foot.ring, 0.003)).filter(Boolean).join(' ');
    // Entrances: a doormat inside, and a green tick outside when you can come in without a step.
    const mats: string[] = [];
    const ticks: { key: string; x: number; y: number; r: number }[] = [];
    for (const entrance of entrances) {
      if (!seen(entrance.mat[0])) continue;
      const ppm = pixelsPerMetre(cam, entrance.mat[0]);
      if (ppm < DETAIL_PX[0]) continue;
      const mat = flat(entrance.mat, 0.006);
      if (mat) mats.push(mat);
      if (entrance.tick && seen(entrance.tick)) {
        const [x, y] = project3d(cam, entrance.tick, 0.02);
        ticks.push({ key: entrance.key, x, y, r: Math.min(11, Math.max(6, ppm * 0.35)) });
      }
    }

    // Open doors, cut at the walls' height, and the arc each swings through.
    const swings: string[] = [];
    const leafHeight = wallMode === 'low' ? 0.4 : wallMode === 'full' ? Math.min(2.1, storey - 0.2) : 1.2;
    for (const leaf of leaves) {
      if (!seen(leaf.centre)) continue;
      const ppm = pixelsPerMetre(cam, leaf.centre);
      if (ppm * leaf.width < 6) continue;
      if (ppm >= DETAIL_PX[1]) swings.push(path(leaf.arc.map((p) => project3d(cam, p, 0.01)), false) +
        ` L${n(project3d(cam, leaf.centre, 0.01)[0])} ${n(project3d(cam, leaf.centre, 0.01)[1])}`);
      const key = `${leaf.key}|${leafHeight}`;
      let parts = wallCache.get(key);
      if (!parts) {
        parts = leafParts(leaf, leafHeight);
        wallCache.set(key, parts);
      }
      solids.push({ faces: facesOf(modelFaces(`leaf|${leaf.width.toFixed(2)}|${leafHeight}`, parts,
                                               { at: leaf.centre, angle: leaf.angle }, view, 1)),
                    depth: 2 * depthOf(cam, leaf.centre) - 0.01 });
    }

    // Stairs: the steps, the opening going down, and what is drawn over them (outlines above the cut, rails, arrows).
    const voids: string[] = [];
    const stairLines: { d: string; kind: 'ghost' | 'rail' | 'break' | 'arrow' | 'tread' }[] = [];
    const stairTags: { id: string; x: number; y: number; text: string }[] = [];
    const line3 = (points: Point3[], close = false) => path(points.map(([x, y, z]) => project3d(cam, [x, y], z)), close);
    for (const stair of stairs) {
      if (!seen(stair.centre)) continue;
      const ppm = pixelsPerMetre(cam, stair.centre);
      for (const hole of stair.voids) {
        const d = flat(hole, 0.004);
        if (d) voids.push(d);
      }
      solids.push({ faces: facesOf(modelFaces(stair.key, stair.parts, { at: stair.centre, angle: stair.angle }, view, 2)),
                    depth: 2 * depthOf(cam, stair.centre) });
      if (ppm < DETAIL_PX[0]) continue;
      for (const ring of stair.ghosts) stairLines.push({ d: line3(ring, true), kind: 'ghost' });
      for (const rail of stair.rails) stairLines.push({ d: line3(rail), kind: 'rail' });
      for (const cut of stair.breaks) stairLines.push({ d: line3(cut), kind: 'break' });
      for (const arrow of stair.arrows) {
        stairLines.push({ d: line3(arrow.points), kind: 'arrow' });
        const [a, b] = arrow.points.slice(-2);
        const [p, q] = [project3d(cam, [a[0], a[1]], a[2]), project3d(cam, [b[0], b[1]], b[2])];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        const [ux, uy] = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
        const head = Math.min(9, Math.max(4, ppm * 0.25));
        stairLines.push({ d: `M${n(q[0] - ux * head - uy * head * 0.6)} ${n(q[1] - uy * head + ux * head * 0.6)} L${n(q[0])} ${n(q[1])} ` +
                             `L${n(q[0] - ux * head + uy * head * 0.6)} ${n(q[1] - uy * head - ux * head * 0.6)}`, kind: 'arrow' });
        if (ppm >= DETAIL_PX[1]) {
          const [x, y] = project3d(cam, [arrow.points[0][0], arrow.points[0][1]], arrow.points[0][2]);
          stairTags.push({ id: `${stair.id}-${arrow.up ? 'up' : 'dn'}`, x, y, text: arrow.up ? 'UP' : 'DN' });
        }
      }
    }

    // Lift cars, with their doors and the up / down pictogram.
    for (const car of lifts) {
      if (!seen(car.centre) || pixelsPerMetre(cam, car.centre) < DETAIL_PX[0]) continue;
      solids.push({ faces: facesOf(modelFaces(car.key, car.parts, { at: car.centre, angle: car.angle }, view, wallDetail)),
                    depth: 2 * depthOf(cam, car.centre) });
    }

    for (const well of flatStairwells) {
      if (!seen(well.centre)) continue;
      const ppm = pixelsPerMetre(cam, well.centre);
      if (ppm < DETAIL_PX[0]) continue;
      const onFloor = (points: Point[]) => path(points.filter(seen).map((p) => project3d(cam, p, 0.01)), false);
      stairLines.push({ d: well.treads.map(onFloor).join(' '), kind: 'tread' });
      stairLines.push({ d: `${onFloor(well.arrow.line)} ${onFloor(well.arrow.head)}`, kind: 'arrow' });
      if (ppm >= DETAIL_PX[1] && seen(well.arrow.tag)) {
        const [x, y] = project3d(cam, well.arrow.tag, 0.01);
        stairTags.push({ id: `${well.id}-flat`, x, y, text: well.arrow.up ? 'UP' : 'DN' });
      }
    }

    // Things in the rooms: each a small model of what it is, more detailed the closer you are.
    const flats: { id: string; d: string; fill: string; stroke: string; opacity: number }[] = [];
    const shadows: string[] = [];
    const glows: string[] = [];
    const tags: { id: string; x: number; y: number; text: string; target: boolean }[] = [];
    const routed = pieces.length > 0;
    const wanted = assets.map((asset) => {
      if (!seen(asset.position)) return -2;
      const ppm = pixelsPerMetre(cam, asset.position);
      if (Math.min(asset.footprint.width_m, asset.footprint.depth_m) * ppm < MIN_ASSET_PX) return -2;
      const tier = ppm < DETAIL_PX[0] ? -1 : ppm < DETAIL_PX[1] ? 0 : ppm < DETAIL_PX[2] ? 1 : 2;
      return busy.current && tier > 0 ? tier - 1 : tier;
    });
    // Too many detailed things at once (a big floor seen whole): the detail steps down, so it stays smooth.
    let cap = 2;
    while (cap > 0 && wanted.filter((tier) => tier >= cap).length > DETAIL_BUDGET[cap]) cap -= 1;
    const shadowAt: Point = [0.07 * Math.cos(cam.yaw) + 0.07 * Math.sin(cam.yaw), 0.07 * Math.sin(cam.yaw) - 0.07 * Math.cos(cam.yaw)];
    assets.forEach((asset, i) => {
      const isTarget = map?.target?.asset_id === asset.id;
      const where = placed.get(asset.id) ?? { angle: (asset.footprint.rotation_deg * Math.PI) / 180, z: 0 };
      const model = modelOf(asset.type, asset.category, asset.footprint.width_m, asset.footprint.depth_m,
                            { room: roomOf.get(asset.space_id), ceiling: storey });
      const opacity = routed && !onWay.has(asset.space_id) && !isTarget ? OFF_ROUTE : 1;
      if ((isTarget || named.has(asset.name)) && seen(asset.position)) {
        const [x, y] = project3d(cam, asset.position, where.z + model.height + 0.4);
        tags.push({ id: asset.id, x, y, text: asset.name, target: isTarget });
      }
      const tier = Math.min(wanted[i], cap);
      if (tier === -2) return;
      const rect = assetRect(asset.position, { ...asset.footprint, rotation_deg: (where.angle * 180) / Math.PI });
      if (isTarget) {
        const glow = flat(grow4(rect, 0.25), 0.015);
        if (glow) glows.push(glow);
      }
      if (tier === -1 && !isTarget) { // far away: its footprint, in its main colour
        const d = flat(rect, 0.02);
        const top = colourOf(model.parts[0]?.mat ?? 'steel');
        if (d) flats.push({ id: asset.id, d, fill: top, stroke: top, opacity });
        return;
      }
      if (model.height > 0.3 && where.z === 0) {
        const shadow = flat(rect.map(([x, y]) => [x + shadowAt[0], y + shadowAt[1]] as Point), 0.01);
        if (shadow) shadows.push(shadow);
      }
      const faces = facesOf(modelFaces(model.key, model.parts, { at: asset.position, angle: where.angle, z: where.z }, view,
                                       Math.max(0, isTarget ? Math.max(tier, 1) : tier)));
      if (faces.length) solids.push({ faces, depth: 2 * depthOf(cam, asset.position) - where.z * 0.01, opacity });
    });
    solids.sort((x, y) => y.depth - x.depth);
    const drawn = drawSolids(solids, busy.current ? FACE_BUDGET_BUSY : FACE_BUDGET);
    // the far things' footprints, one path per colour
    const flatGroups = new Map<string, { key: string; d: string; fill: string; opacity: number }>();
    for (const thing of flats) {
      const key = `${thing.fill}|${thing.opacity}`;
      const group = flatGroups.get(key);
      if (group) group.d += ` ${thing.d}`;
      else flatGroups.set(key, { key, d: thing.d, fill: thing.fill, opacity: thing.opacity });
    }

    // Room names: the ones people look for first (with a small sign), then the big rooms; a name that would
    // overlap one already placed is left out, so they never pile up.
    const candidates = spaces.flatMap((space) => {
      if (space.type === 'outdoor' || depthOf(cam, space.anchor) < cam.distance * 0.3) return [];
      const ppm = pixelsPerMetre(cam, space.anchor);
      const side = Math.sqrt(space.area_m2) * ppm;
      const icon = signOf(space, exits);
      if (side < (icon ? MIN_LABEL_PX * 0.6 : MIN_LABEL_PX)) return [];
      const [x, y] = project3d(cam, space.anchor);
      if (x < -40 || x > width + 40 || y < -20 || y > height + 20) return [];
      const text = side > 110 || !space.ref ? space.name : space.ref;
      const size = Math.min(13, Math.max(8.5, ppm * 0.9));
      // target, then the way out, then what people look for, then the big rooms
      const rank = (map?.target?.space_id === space.id ? 8 : 0) + (icon && ESCAPE.has(icon) ? 4 : icon ? 2 : 0) + Math.min(1.9, space.area_m2 / 200);
      return [{ id: space.id, x, y, text, size, icon, rank }];
    }).sort((a, b) => b.rank - a.rank);
    const placedBoxes: [number, number, number, number][] = [];
    const labels = candidates.filter((label) => {
      const w = label.text.length * label.size * 0.56 + (label.icon ? label.size * 1.6 : 0) + 6;
      const h = label.size * 1.5;
      const box: [number, number, number, number] = [label.x - w / 2, label.y - h / 2, label.x + w / 2, label.y + h / 2];
      if (placedBoxes.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) return false;
      placedBoxes.push(box);
      return true;
    });
    return { slabSides, slabTops, grid, near, tiles, floorings, voids, swings, wallFeet, mats, ticks, climbs, shadows, glows, flats: [...flatGroups.values()], routes,
             drawn, stairLines, stairTags, labels, lit, tags };
  }, [cam, footprints, around, spaces, assets, pieces, walls, width, height, changes, highlight, map, onWay, named, finishes,
      leaves, stairs, placed, roomOf, storey, wallMode, wallCache, sharp, exits, wallShadows, entrances, lifts, flatStairwells, ways]);

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
    <Animated.View ref={frame} style={[styles.frame, { width, height, opacity: appear, backgroundColor: mapColours.background }]} testID="floor-scene">
      <Animated.View {...gestures.panHandlers} style={[{ width, height }, gestures.style]}>
        <Svg width={width + 2 * MARGIN_PX} height={height + 2 * MARGIN_PX} style={{ position: 'absolute', left: -MARGIN_PX, top: -MARGIN_PX }}>
          <G transform={`translate(${MARGIN_PX} ${MARGIN_PX})`}>
            <Path d={scene.grid.join(' ')} stroke={mapColours.slabEdge} strokeOpacity={0.5} strokeWidth={0.6} fill="none" />
            {scene.near && (
              <>
                <GroundLayers ground={scene.near.ground} flatten={flatten} />
                {scene.near.buildings.map((item, i) => (
                  <Path key={`near-${i}`} d={item.d} fill={item.top} stroke={mapColours.nearEdge} strokeWidth={0.8} />
                ))}
              </>
            )}
            {scene.slabSides.map((side, i) => (
              <Path key={`slab-${i}`} d={side.d} fill={mapColours.slabSide} stroke={mapColours.slabEdge} strokeWidth={0.6} />
            ))}
            {scene.slabTops.map((d, i) => (
              <Path key={`top-${i}`} d={d} fill={mapColours.slabTop} stroke={mapColours.blockEdge} strokeWidth={1} />
            ))}
            <G opacity={dim}>
              {scene.tiles.map((tile) => (
                <Path key={tile.id} d={tile.d!} fill={tile.fill} testID={tile.closed ? 'closed-space' : undefined}
                      stroke={tile.edge} strokeOpacity={tile.closed ? 1 : 0.55} strokeWidth={tile.closed ? 1.5 : 0.8} />
              ))}
              {scene.floorings.length > 0 && (
                <Defs>
                  {scene.floorings.map((floor) => (
                    <ClipPath key={floor.id} id={`floor-${floor.id}`}><Path d={floor.clip} /></ClipPath>
                  ))}
                </Defs>
              )}
              {scene.floorings.map((floor) => (
                <G key={`finish-${floor.id}`} clipPath={`url(#floor-${floor.id})`}>
                  {floor.squares ? <Path d={floor.squares} fill={mapColours.label} fillOpacity={0.13} /> : null}
                  {floor.lines ? <Path d={floor.lines} stroke={mapColours.label} strokeOpacity={floor.kind === 'panels' ? 0.18 : 0.22}
                                       strokeWidth={floor.kind === 'panels' ? 0.8 : 0.5} fill="none" /> : null}
                </G>
              ))}
              {scene.wallFeet ? <Path d={scene.wallFeet} fill={mapColours.shadow} fillOpacity={0.5} /> : null}
              {scene.mats.length > 0 && <Path d={scene.mats.join(' ')} fill={colourOf('floorMat')} testID="entrance-mat" />}
              {scene.voids.length > 0 && <Path d={scene.voids.join(' ')} fill={colourOf('void')} testID="stair-opening" />}
              {scene.swings.length > 0 && (
                <Path d={scene.swings.join(' ')} stroke={mapColours.label} strokeOpacity={0.45} strokeWidth={0.7} fill="none"
                      strokeDasharray={[3, 2]} />
              )}
              {scene.glows.length > 0 && <Path d={scene.glows.join(' ')} fill={colours.accentSoft} />}
              {scene.shadows.length > 0 && <Path d={scene.shadows.join(' ')} fill={mapColours.shadow} fillOpacity={0.55} />}
              {scene.flats.map((thing) => (
                <Path key={thing.key} d={thing.d} fill={thing.fill} opacity={thing.opacity} />
              ))}
            </G>
            {scene.routes.map((route, i) => (
              <G key={`route-${i}`} testID="route-line">
                {route.glow && <Path d={route.glow} fill={colours.accentFaint} />}
                {route.band && <Path d={route.band} fill={colours.accent} />}
                <AnimatedPath d={route.line} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round"
                              strokeLinejoin="round" fill="none" strokeDasharray={[6, 18]} strokeDashoffset={dashOffset} />
              </G>
            ))}
            {scene.lit && <Path d={scene.lit} fill="#B54F00" fillOpacity={0.6} testID="route-highlight" />}
            {scene.drawn.map((face) => (
              <Path key={face.key} d={face.d} fill={face.fill} fillOpacity={face.fillOpacity} stroke={face.stroke} strokeWidth={0.5}
                    strokeOpacity={face.fillOpacity >= 1 ? 1 : 0.5} strokeLinejoin="round" opacity={dim * face.opacity} />
            ))}
            {scene.climbs.map((climb, i) => (
              <G key={`climb-${i}`} testID="route-on-stairs">
                {climb.steps ? <Path d={climb.steps} fill={colours.accent} /> : null}
                <AnimatedPath d={climb.line} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round"
                              strokeLinejoin="round" fill="none" strokeDasharray={[6, 18]} strokeDashoffset={dashOffset} />
              </G>
            ))}
            <G opacity={safety ? 1 : dim} testID="stairs">
              {scene.stairLines.map((line, i) => (
                <Path key={`stair-${i}`} d={line.d} fill="none" strokeLinejoin="round" strokeLinecap="round"
                      stroke={line.kind === 'rail' ? colourOf('steel') : line.kind === 'arrow' ? mapColours.chromeText : mapColours.label}
                      strokeOpacity={line.kind === 'ghost' ? 0.5 : line.kind === 'rail' ? 0.8 : line.kind === 'tread' ? 0.6 : 0.95}
                      strokeWidth={line.kind === 'rail' ? 1.1 : line.kind === 'arrow' ? 1.6 : 0.8}
                      strokeDasharray={line.kind === 'ghost' ? [3, 2.5] : undefined} />
              ))}
              {scene.stairTags.map((tag) => (
                <Halo key={tag.id} x={tag.x} y={tag.y + 3} size={9} bold fill={mapColours.chromeText} text={tag.text} />
              ))}
            </G>
            <G opacity={dim}>
              {scene.labels.map((label) => {
                const shift = label.icon ? label.size * 0.8 : 0;
                return (
                  <G key={`label-${label.id}`}>
                    {label.icon && <Sign kind={label.icon} x={label.x - (label.text.length * label.size * 0.28) - shift + 2} y={label.y}
                                         size={label.size * 1.35} />}
                    <Halo x={label.x + shift} y={label.y + label.size / 3} size={label.size} fill={mapColours.label} text={label.text} />
                  </G>
                );
              })}
            </G>
            {hover?.roomId && (() => {
              const tile = scene.tiles.find((item) => item.id === hover.roomId);
              return tile ? <Path d={tile.d!} fill={colours.accentFaint} stroke={colours.accent} strokeWidth={1.5} strokeOpacity={0.7}
                                  pointerEvents="none" testID="hover-room" /> : null;
            })()}
            {/* the route seen through the walls, faintly, so it never disappears behind one */}
            {scene.routes.map((route, i) => (
              <Path key={`ghost-${i}`} d={route.line} stroke={colours.accent} strokeOpacity={0.35} strokeWidth={2.5}
                    strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ))}
            {scene.ticks.map((tick) => (
              <G key={tick.key} testID="step-free">
                <Circle cx={tick.x} cy={tick.y} r={tick.r} fill="#2E9E5B" stroke={mapColours.background} strokeWidth={1} />
                <Path d={`M${n(tick.x - tick.r * 0.45)} ${n(tick.y)} L${n(tick.x - tick.r * 0.1)} ${n(tick.y + tick.r * 0.35)} ` +
                         `L${n(tick.x + tick.r * 0.5)} ${n(tick.y - tick.r * 0.35)}`}
                      stroke="#FFFFFF" strokeWidth={Math.max(1.2, tick.r * 0.22)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </G>
            ))}
            <ChangeMarks changes={changes} project={(p) => project3d(cam, p)} fontFamily={LABEL_FONT}
                         visible={(p) => depthOf(cam, p) > cam.distance * 0.3} />
            {scene.tags.map((tag) => (
              <G key={`tag-${tag.id}`} testID={tag.target ? 'target-thing' : 'landmark-thing'}>
                <SvgText x={tag.x} y={tag.y} fontSize={tag.target ? 12 : 11} fontWeight="700" fontFamily={LABEL_FONT}
                         textAnchor="middle" fill={mapColours.background} stroke={mapColours.background} strokeWidth={3}>
                  {tag.text}
                </SvgText>
                <SvgText x={tag.x} y={tag.y} fontSize={tag.target ? 12 : 11} fontWeight="700" fontFamily={LABEL_FONT}
                         textAnchor="middle" fill={tag.target ? colours.accent : mapColours.chromeText}>
                  {tag.text}
                </SvgText>
              </G>
            ))}
            {safety && (
              <SafetyMarks marks={marks} project={(p) => project3d(cam, p, 0.05)} fontFamily={LABEL_FONT}
                           visible={(p) => depthOf(cam, p) > cam.distance * 0.3} />
            )}
            {targetPx && (
              <TargetPin x={targetPx.at[0]} y={targetPx.at[1]} height={Math.min(48, Math.max(30, targetPx.ppm * 2.6))}
                         flatten={flatten} />
            )}
            {hover && (() => {
              const w = hover.text.length * 6.6 + 18;
              const x = Math.min(hover.x + 14, width - w - 4);
              const y = Math.max(4, hover.y - 34);
              return (
                <G pointerEvents="none" testID="hover-pill">
                  <Rect x={x} y={y} width={w} height={24} rx={12} fill={mapColours.chrome} stroke={mapColours.chromeEdge} strokeWidth={0.8} />
                  <SvgText x={x + w / 2} y={y + 16} fontSize={12} fontWeight="600" fontFamily={LABEL_FONT} textAnchor="middle"
                           fill={mapColours.chromeText}>{hover.text}</SvgText>
                </G>
              );
            })()}
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
            <Path d="M0 9 L4 0 L-4 0 Z" fill={mapColours.chromeMuted} />
          </Svg>
        </Pressable>
      </View>}
    </Animated.View>
  );
}

export const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: mapColours.background },
  controls: { position: 'absolute', right: 12, top: 60, gap: 8 },
  button: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: mapColours.chrome, alignItems: 'center',
    justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: mapColours.chromeEdge,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  buttonText: { fontSize: 20, color: mapColours.chromeText },
});
