/** What the things in the rooms are made of, in each look: [dark, light]. Flat colours only (one per face, shaded by
 * the light), so a fridge reads as white enamel, a desk as wood, a forklift as safety yellow. Orange stays for you
 * and your way and red for closed, so no material uses them (but the fire extinguisher, which is meant to be found). */
import { themeName } from '../theme';

const MATERIALS = {
  wood: ['#8A6A4A', '#C9A27A'],
  woodDark: ['#5E4630', '#8E6A4A'],
  woodLight: ['#A88B66', '#E2C9A6'],
  white: ['#C9D3DE', '#FAFBFC'], // enamel: fridges, stoves, washing machines
  porcelain: ['#D5DEE8', '#FFFFFF'],
  steel: ['#7F8C9B', '#B8C2CD'],
  steelDark: ['#4C5663', '#7E8996'],
  chrome: ['#A9B6C4', '#D9E0E7'],
  black: ['#1A1F26', '#33383F'], // screens, burners, tyres
  plastic: ['#3A4350', '#5C6673'],
  fabric: ['#4D6A8F', '#7E9CC2'], // chairs and sofas
  fabricWarm: ['#8A5A6A', '#C98E9E'],
  cushion: ['#5D7DA6', '#9DB7D8'],
  linen: ['#B9C2CC', '#F2F0EA'], // sheets and pillows
  duvet: ['#4E7FA8', '#86B3D9'],
  glass: ['#7FB8E0', '#A9D4F0'],
  water: ['#5FA7D9', '#9ACCEE'],
  leaf: ['#3F9A5C', '#6CC07F'],
  leafDark: ['#2C7445', '#4FA163'],
  pot: ['#A8603E', '#D2845E'],
  red: ['#D63A2F', '#E5483C'], // fire safety only
  green: ['#2E9E5B', '#3DB36B'], // first aid, eyewash, exit
  yellow: ['#E3B428', '#F5C842'], // industrial safety yellow
  hazard: ['#2A2A2A', '#3A3A3A'], // the black of black and yellow stripes
  machine: ['#5E7F7A', '#8FB3AD'], // the grey-green of machine tools
  machineLight: ['#A7B9B6', '#DCE6E4'],
  rackBlue: ['#2F5FA8', '#4F82CF'],
  rackOrange: ['#C9672A', '#E98A47'], // a rust orange, darker than the route's
  pallet: ['#9C7B52', '#CFAE80'],
  cardboard: ['#B08A5C', '#D9B888'],
  rubber: ['#20252B', '#2E343B'],
  paper: ['#C7CDD4', '#F5F5F0'],
  led: ['#5CE08A', '#2FBF63'],
  screenOn: ['#3D7FC2', '#6FA8E0'],
  books1: ['#A84B4B', '#D27474'],
  books2: ['#3F6FA8', '#6E98CC'],
  books3: ['#4F8F5A', '#78B581'],
  tile: ['#9FB4C6', '#DDE8F0'],
  stair: ['#6F8399', '#E7EBF0'], // concrete steps
  stairDeep: ['#34414F', '#B9C2CD'], // the flight going down, in the shadow of the slab
  void: ['#04070A', '#8F99A6'], // the opening in the floor the stairs go down through
  lift: ['#8FA6BE', '#C9D3DE'],
  wall: ['#2C3B4E', '#E6E9EE'],
  wallCap: ['#8FB3D9', '#3B4452'], // where a wall is cut: light on the dark map, dark (the architect's poché) on the light one
  floorMat: ['#3C4552', '#6B7480'],
} as const;

export type Mat = keyof typeof MATERIALS;

/** A material's colour in the look in use (hex). */
export const colourOf = (mat: Mat): string => MATERIALS[mat][themeName() === 'dark' ? 0 : 1];

/** See-through materials and how much of them shows. */
export const alphaOf = (mat: Mat): number => (mat === 'glass' ? 0.42 : mat === 'water' ? 0.8 : 1);

export const MATERIAL_NAMES = Object.keys(MATERIALS) as Mat[];
