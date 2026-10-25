import type { Point } from '../api';
import { type Camera } from '../geometry';
import { MODELLED, modelOf, rawParts } from '../models/catalog';
import { box, type Part } from '../models/kit';
import { cameraView, isoView, modelFaces, paintOrder } from '../models/render';

// Every kind of thing in the buildings, with its typical size (width x depth, from the data).
const KINDS: [string, string, number, number][] = [
  ['chair', 'furniture', 0.5, 0.5], ['desk', 'furniture', 1.4, 0.7], ['wardrobe', 'furniture', 1.2, 0.6],
  ['nightstand', 'furniture', 0.45, 0.4], ['plant', 'furniture', 0.4, 0.4], ['toilet', 'fixture', 0.45, 0.66],
  ['office_chair', 'furniture', 0.6, 0.6], ['sink', 'fixture', 0.6, 0.45], ['kitchen_counter', 'fixture', 2.35, 0.6],
  ['shelf', 'furniture', 1, 0.4], ['bookshelf', 'furniture', 0.9, 0.35], ['dining_chair', 'furniture', 0.45, 0.45],
  ['single_bed', 'furniture', 0.9, 2], ['bed', 'furniture', 1.6, 2], ['fire_extinguisher', 'equipment', 0.3, 0.3],
  ['fridge', 'equipment', 0.6, 0.65], ['outdoor_chair', 'furniture', 0.5, 0.5], ['stove', 'equipment', 0.6, 0.6],
  ['filing_cabinet', 'furniture', 0.5, 0.6], ['coffee_machine', 'equipment', 0.4, 0.4], ['bathtub', 'fixture', 1.64, 0.71],
  ['seminar_table', 'furniture', 1.4, 0.6], ['coffee_table', 'furniture', 1, 0.6], ['sofa', 'furniture', 2, 0.9],
  ['tv_stand', 'furniture', 1.5, 0.4], ['server_rack', 'equipment', 0.6, 1.2], ['pallet_rack', 'furniture', 2.7, 1.1],
  ['microwave', 'equipment', 0.5, 0.4], ['dishwasher', 'equipment', 0.6, 0.6], ['outdoor_table', 'furniture', 0.8, 0.8],
  ['armchair', 'furniture', 0.8, 0.8], ['whiteboard', 'equipment', 1.8, 0.1], ['lab_bench', 'furniture', 3, 0.8],
  ['dining_table', 'furniture', 1.6, 0.9], ['microscope', 'equipment', 0.5, 0.5], ['shower', 'fixture', 0.9, 0.83],
  ['meeting_table', 'furniture', 2.4, 1.1], ['display_screen', 'equipment', 1.6, 0.3], ['locker', 'furniture', 0.9, 0.5],
  ['projector', 'equipment', 0.4, 0.3], ['projector_screen', 'equipment', 2.4, 0.15], ['coat_rack', 'furniture', 0.6, 0.3],
  ['fume_hood', 'equipment', 1.5, 0.8], ['oscilloscope_station', 'equipment', 1.2, 0.7], ['shoe_cabinet', 'furniture', 0.8, 0.35],
  ['lecture_seating_row', 'furniture', 5, 0.8], ['assembly_station', 'furniture', 2.4, 1.2], ['bench', 'furniture', 1.5, 0.4],
  ['tool_cabinet', 'furniture', 1, 0.6], ['washing_machine', 'equipment', 0.6, 0.6], ['3d_printer', 'machine', 0.6, 0.6],
  ['hand_dryer', 'equipment', 0.3, 0.2], ['canteen_table', 'furniture', 1.8, 0.8], ['workbench', 'furniture', 2, 0.8],
  ['chemical_cabinet', 'furniture', 1, 0.5], ['eyewash_station', 'equipment', 0.5, 0.4], ['ups_unit', 'equipment', 0.6, 0.8],
  ['multifunction_printer', 'equipment', 0.8, 0.7], ['packing_station', 'furniture', 2, 1], ['reading_table', 'furniture', 1.6, 0.8],
  ['forklift', 'machine', 2.5, 1.2], ['vending_machine', 'equipment', 0.9, 0.8], ['paper_shelf', 'furniture', 1, 0.4],
  ['welding_station', 'equipment', 2, 2], ['pallet_jack', 'equipment', 1.6, 0.7], ['drill_press', 'machine', 0.8, 0.8],
  ['electrical_panel', 'equipment', 1, 0.3], ['industrial_3d_printer', 'machine', 1.5, 1.2],
  ['forklift_charging_station', 'equipment', 1.5, 1], ['printer', 'equipment', 0.6, 0.5], ['cnc_mill', 'machine', 3, 2.5],
  ['built_in_wardrobe', 'furniture', 1.2, 0.6], ['internal_stairs', 'fixture', 1.4, 0.98],
  ['injection_moulding_machine', 'machine', 5, 2], ['cnc_lathe', 'machine', 3.5, 2], ['milling_machine', 'machine', 2, 1.8],
  ['soldering_station', 'equipment', 1.2, 0.6], ['press_brake', 'machine', 4, 1.8], ['defibrillator', 'equipment', 0.4, 0.2],
  ['inspection_bench', 'furniture', 2, 0.8], ['reception_desk', 'furniture', 2.5, 0.8], ['lectern', 'furniture', 0.6, 0.5],
  ['serving_counter', 'fixture', 4, 0.8], ['hvac_unit', 'machine', 2, 1.2], ['coordinate_measuring_machine', 'machine', 2, 1.5],
  ['boiler', 'machine', 1, 1], ['laser_cutter', 'machine', 1.4, 0.9], ['compressor', 'machine', 1.5, 1],
  ['water_dispenser', 'equipment', 0.4, 0.4], ['robot_cell', 'machine', 4, 4], ['waterjet_cutter', 'machine', 4, 3],
  ['conveyor', 'machine', 6, 1], ['waste_basket', 'furniture', 0.6, 0.6], ['curing_oven', 'machine', 1.2, 1],
  ['powder_station', 'equipment', 1.5, 1], ['atm', 'equipment', 0.6, 0.6],
];

const extent = (parts: Part[]) => {
  const points = parts.flatMap((part) => part.upright
    ? part.upright.outline.map(([u]) => (part.upright!.axis === 'y' ? [u, part.upright!.at] : [part.upright!.at, u]) as Point)
    : part.base);
  return {
    x: Math.max(...points.map((p) => Math.abs(p[0]))), y: Math.max(...points.map((p) => Math.abs(p[1]))),
    top: Math.max(...parts.map((part) => part.z1)), bottom: Math.min(...parts.map((part) => part.z0)),
  };
};

describe('the models of things', () => {
  it('has a model of its own for every kind of thing in the buildings', () => {
    for (const [type] of KINDS) expect(MODELLED).toContain(type);
  });

  it('keeps every model inside the real footprint, at real-world heights', () => {
    for (const [type, category, w, d] of KINDS) {
      for (const [sw, sd] of [[1, 1], [0.7, 0.8], [1.5, 1.3]]) {
        for (const room of ['office', 'kitchen', 'bathroom']) {
          const parts = rawParts(type, category, w * sw, d * sd, { room, ceiling: 3.5 });
          const e = extent(parts);
          expect([type, e.x <= (w * sw) / 2 + 1e-6, e.y <= (d * sd) / 2 + 1e-6]).toEqual([type, true, true]);
          expect([type, e.bottom >= 0, e.top <= 3.5 && e.top > 0]).toEqual([type, true, true]);
        }
      }
    }
  });

  it('stays under a low ceiling', () => {
    for (const [type, category, w, d] of KINDS) expect(modelOf(type, category, w, d, { ceiling: 2.2 }).height).toBeLessThanOrEqual(2.15 + 1e-9);
  });

  it('puts a fridge’s handle and a stove’s oven on the front (-y), the toilet’s cistern at the back (+y)', () => {
    const fridge = rawParts('fridge', 'equipment', 0.6, 0.65);
    const handles = fridge.filter((part) => part.mat === 'chrome');
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(Math.max(...handle.base.map((p) => p[1]))).toBeLessThan(0);
    expect(rawParts('stove', 'equipment', 0.6, 0.6).some((part) => part.upright && part.upright.at < 0 && part.mat === 'black')).toBe(true);
    const cistern = rawParts('toilet', 'fixture', 0.45, 0.66).find((part) => part.z1 >= 0.8)!;
    expect(Math.min(...cistern.base.map((p) => p[1]))).toBeGreaterThan(0);
  });

  it('falls back to a box by category for kinds it does not know', () => {
    expect(modelOf('time_machine', 'machine', 2, 2).parts.length).toBeGreaterThan(0);
    expect(modelOf('mystery', undefined, 1, 1).height).toBeGreaterThan(0);
  });
});

describe('drawing models', () => {
  const cam: Camera = { target: [0, 0], yaw: 0, tilt: (52 * Math.PI) / 180, distance: 40, scale: 30, ox: 200, oy: 300 };

  it('paints what stands on something after it, and the far part before the near one', () => {
    const table = box(-1, -1, 1, 1, 0, 0.75, 'wood');
    const vase = box(-0.1, -0.1, 0.1, 0.1, 0.75, 1, 'pot');
    expect(paintOrder([vase, table], [0, -1])).toEqual([1, 0]);
    const far = box(-0.5, 1, 0.5, 2, 0, 1, 'wood');
    const near = box(-0.5, -2, 0.5, -1, 0, 1, 'wood');
    expect(paintOrder([near, far], [0, -1])).toEqual([1, 0]); // the viewer is at -y: far (+y) first
    expect(paintOrder([near, far], [0, 1])).toEqual([0, 1]);
  });

  it('draws only the faces turned to the viewer, from the perspective camera and the isometric view alike', () => {
    const cube = [box(-0.5, -0.5, 0.5, 0.5, 0, 1, 'white', 0)];
    for (const yaw of [0, 0.7, 2, 4]) {
      const faces = modelFaces('cube', cube, { at: [0, 5], angle: 0 }, cameraView({ ...cam, yaw }), 2);
      expect(faces.length).toBeGreaterThanOrEqual(2); // one or two sides and the top
      expect(faces.length).toBeLessThanOrEqual(3);
    }
    const iso = isoView({ angle: 0.3, centre: [0, 0] }, (p) => p);
    expect(modelFaces('cube', cube, { at: [0, 0], angle: 0 }, iso, 2)).toHaveLength(3);
  });

  it('hides the details on a face turned away (the fridge handle seen from behind)', () => {
    const fridge = modelOf('fridge', 'equipment', 0.6, 0.65);
    const view = cameraView(cam); // the camera is at -y, looking north
    const front = modelFaces(fridge.key, fridge.parts, { at: [0, 0], angle: 0 }, view, 2);
    const back = modelFaces(fridge.key, fridge.parts, { at: [0, 0], angle: Math.PI }, view, 2);
    expect(front.length).toBeGreaterThan(back.length);
  });

  it('leaves the small details out when far away', () => {
    const stove = modelOf('stove', 'equipment', 0.6, 0.6);
    const view = cameraView(cam);
    expect(modelFaces(stove.key, stove.parts, { at: [0, 0], angle: 0 }, view, 0).length)
      .toBeLessThan(modelFaces(stove.key, stove.parts, { at: [0, 0], angle: 0 }, view, 2).length);
  });
});
