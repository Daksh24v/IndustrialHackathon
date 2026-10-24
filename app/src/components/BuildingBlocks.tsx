/** The building from outside, like the block style of a map: one white block per floor, stacked by elevation,
 * slowly turning. When a floor is chosen the camera flies down onto it (the floors above fade away) and
 * onArrived() hands over to the 2D floor view. */
import { useMemo, useRef } from 'react';
import { View } from 'react-native';
import * as THREE from 'three';

import type { Outline } from '../api';
import { Canvas, useFrame } from '../three/Canvas';
import { colours } from '../theme';

const FLY_SECONDS = 1.6;
const FLOOR_GAP = 0.06; // fraction of a floor's height left as a visible seam

interface Props {
  outline: Outline;
  focusFloorId: string | null;
  onArrived?: () => void;
  width: number;
  height: number;
}

interface Extent {
  centre: THREE.Vector3;
  size: number;
}

function extentOf(outline: Outline): Extent {
  const box = new THREE.Box3();
  for (const floor of outline.floors) {
    for (const part of floor.footprints) {
      for (const [x, y] of part) {
        box.expandByPoint(new THREE.Vector3(x, floor.elevation_m, -y));
        box.expandByPoint(new THREE.Vector3(x, floor.elevation_m + floor.height_m, -y));
      }
    }
  }
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { centre, size: Math.max(size.x, size.y, size.z, 10) };
}

function FloorBlock({ footprints, elevation, height, faded }: {
  footprints: [number, number][][]; elevation: number; height: number; faded: boolean;
}) {
  const geometries = useMemo(
    () =>
      footprints.map((points) => {
        const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: height * (1 - FLOOR_GAP), bevelEnabled: false });
        geometry.rotateX(-Math.PI / 2); // plan (x, y) lies flat; the extrusion points up
        return { geometry, edges: new THREE.EdgesGeometry(geometry, 30) };
      }),
    [footprints, height],
  );
  return (
    <group position={[0, elevation, 0]}>
      {geometries.map(({ geometry, edges }, index) => (
        <group key={index}>
          <mesh geometry={geometry}>
            <meshLambertMaterial color={colours.block} transparent opacity={faded ? 0.08 : 1} />
          </mesh>
          <lineSegments geometry={edges}>
            <lineBasicMaterial color={colours.blockEdge} transparent opacity={faded ? 0.15 : 1} />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}

function Rig({ extent, outline, focusFloorId, onArrived }: {
  extent: Extent; outline: Outline; focusFloorId: string | null; onArrived?: () => void;
}) {
  const angle = useRef(Math.PI / 4);
  const flight = useRef<{ from: THREE.Vector3; started: number; done: boolean } | null>(null);
  const look = useRef(extent.centre.clone());
  const floor = outline.floors.find((item) => item.id === focusFloorId);

  useFrame(({ camera, clock, size: screen }) => {
    const { centre, size } = extent;
    // On a portrait phone the screen is narrow: step back so the whole building fits across it.
    const fitWidth = Math.max(1, screen.height / Math.max(screen.width, 1));
    if (!floor) {
      flight.current = null;
      angle.current += 0.0015; // slow turn while nothing is chosen
      const radius = size * 1.3 * fitWidth;
      camera.position.set(
        centre.x + Math.cos(angle.current) * radius,
        centre.y + radius * 0.8,
        centre.z + Math.sin(angle.current) * radius,
      );
      look.current.lerp(centre, 0.1);
      camera.lookAt(look.current);
      return;
    }
    if (!flight.current) flight.current = { from: camera.position.clone(), started: clock.elapsedTime, done: false };
    const t = Math.min((clock.elapsedTime - flight.current.started) / FLY_SECONDS, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    const top = new THREE.Vector3(centre.x, floor.elevation_m + size * 0.9 * fitWidth, centre.z + 0.01);
    camera.position.lerpVectors(flight.current.from, top, ease);
    look.current.lerp(new THREE.Vector3(centre.x, floor.elevation_m, centre.z), 0.15);
    camera.lookAt(look.current);
    if (t >= 1 && !flight.current.done) {
      flight.current.done = true;
      onArrived?.();
    }
  });
  return null;
}

export function BuildingBlocks({ outline, focusFloorId, onArrived, width, height }: Props) {
  const extent = useMemo(() => extentOf(outline), [outline]);
  const focus = outline.floors.find((floor) => floor.id === focusFloorId);
  return (
    <View style={{ width, height, backgroundColor: colours.background }} testID="building-blocks">
      {/* flat: no film-style tone mapping, so white stays white */}
      <Canvas flat camera={{ fov: 40, near: 0.5, far: extent.size * 40 }} style={{ width, height }}>
        <color attach="background" args={[colours.background]} />
        <ambientLight intensity={2.2} />
        <directionalLight position={[extent.size, extent.size * 2, extent.size * 0.6]} intensity={0.9} />
        <directionalLight position={[-extent.size, extent.size * 0.5, -extent.size]} intensity={0.25} />
        {outline.floors.map((floor) => (
          <FloorBlock
            key={floor.id}
            footprints={floor.footprints}
            elevation={floor.elevation_m}
            height={floor.height_m}
            faded={!!focus && floor.elevation_m > focus.elevation_m}
          />
        ))}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[extent.centre.x, -0.05, extent.centre.z]}>
          <planeGeometry args={[extent.size * 6, extent.size * 6]} />
          <meshBasicMaterial color="#FBFBFB" />
        </mesh>
        <Rig extent={extent} outline={outline} focusFloorId={focusFloorId} onArrived={onArrived} />
      </Canvas>
    </View>
  );
}
