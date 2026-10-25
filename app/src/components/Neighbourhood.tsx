/** The OpenStreetMap neighbourhood's ground, shared by the outside view and the 3D floor view: land use tinted by
 * kind, green, water, roads by class (rail dashed) and trees as small discs. Each view projects it its own way
 * and draws next door's buildings itself. */
import { G, Path } from 'react-native-svg';

import type { Context, Point } from '../api';
import { ribbon } from '../geometry';
import { areaFill, map as mapColours, roadStyle } from '../theme';

export interface Ground {
  areas: { d: string; fill: string }[];
  green: string[];
  water: string[];
  roads: { d: string; fill: string; edge: string; dashed?: boolean }[];
  trees: { x: number; y: number; r: number }[];
}

const TREE_M = 2.2; // a tree's crown radius

/** The ground's shapes on the screen. `flat` gives a polygon's path (null when off screen); `point` a plan point on
 * the screen with pixels per metre there (null when off screen). */
export function groundOf(near: Context, flat: (polygon: Point[]) => string | null,
                         point: (p: Point) => { at: Point; ppm: number } | null): Ground {
  const live = <T,>(item: T | null): item is T => item !== null;
  return {
    areas: (near.areas ?? []).map((area) => {
      const d = flat(area.polygon);
      return d ? { d, fill: areaFill(area.kind) } : null;
    }).filter(live),
    green: near.green.map(flat).filter(live),
    water: near.water.map(flat).filter(live),
    roads: near.roads.map((road) => {
      const d = flat(ribbon(road.line, road.width_m / 2));
      return d ? { d, ...roadStyle(road.kind) } : null;
    }).filter(live),
    trees: (near.trees ?? []).map((tree) => {
      const seen = point(tree);
      return seen && seen.ppm * TREE_M >= 1.2 ? { x: seen.at[0], y: seen.at[1], r: seen.ppm * TREE_M } : null;
    }).filter(live),
  };
}

export function GroundLayers({ ground, flatten = 1 }: { ground: Ground; flatten?: number }) {
  return (
    <G testID="neighbourhood">
      {ground.areas.map((area, i) => <Path key={`area-${i}`} d={area.d} fill={area.fill} />)}
      {ground.green.map((d, i) => <Path key={`green-${i}`} d={d} fill={mapColours.green} />)}
      {ground.water.map((d, i) => <Path key={`water-${i}`} d={d} fill={mapColours.water} stroke="#1E4466" strokeWidth={0.6} />)}
      {ground.roads.map((road, i) => (
        <Path key={`road-${i}`} d={road.d} fill={road.fill} stroke={road.edge} strokeWidth={road.dashed ? 0.9 : 0.5}
              strokeDasharray={road.dashed ? [3, 3] : undefined} />
      ))}
      {ground.trees.map((tree, i) => (
        <Path key={`tree-${i}`} fill={mapColours.tree} stroke={mapColours.treeEdge} strokeWidth={0.5}
              d={ellipse(tree.x, tree.y, tree.r, tree.r * flatten)} />
      ))}
    </G>
  );
}

/** An ellipse as a path (cheaper to batch than many Ellipse elements on the web). */
function ellipse(x: number, y: number, rx: number, ry: number): string {
  const f = (v: number) => v.toFixed(1);
  return `M${f(x - rx)} ${f(y)} a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0 a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0 Z`;
}
