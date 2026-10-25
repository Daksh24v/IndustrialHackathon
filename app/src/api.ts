/** Typed client for the backend server (server/app.py). */

export type Point = [number, number];

export interface Floor {
  id: string;
  level: number;
  name: string;
  elevation_m: number;
  height_m?: number;
}

export interface Space {
  id: string;
  floor_id: string;
  type: string;
  room_type: string;
  name: string;
  ref: string | null;
  polygon: Point[];
  area_m2: number;
  anchor: Point;
}

export interface Opening {
  id: string;
  floor_id: string;
  space_ids: string[];
  kind: string;
  position: Point;
  width_m?: number;
  step_free?: boolean;
}

export interface Asset {
  id: string;
  name: string;
  type: string;
  category?: string; // machine, equipment, fixture or furniture
  space_id: string;
  floor_id: string;
  position: Point;
  footprint?: { width_m: number; depth_m: number; rotation_deg: number };
}

export interface BuildingDetail {
  building: { id: string; name: string };
  floors: Floor[];
  spaces: Space[];
  openings: Opening[];
  vertical_connectors: { id: string; kind: string; name: string; floor_ids: string[]; space_ids: string[] }[];
  assets: Asset[];
}

export interface OutlineFloor extends Floor {
  height_m: number;
  footprints: Point[][];
}

export interface Outline {
  building: { id: string; name: string };
  floors: OutlineFloor[];
}

export interface Place {
  label: string;
  floor_id: string;
  position: Point;
  space_id: string;
  asset_id?: string;
}

export interface RoutePiece {
  floor_id: string;
  points: Point[];
  then: null | { kind: string; via?: string; name?: string; to_floor_id?: string };
}

/** Edits a facility manager made to the building in this conversation (absent = none). */
export interface MapChanges {
  closed: string[]; // opening ids, connector ids or space ids
  new_doors: { id: string; floor_id: string; position: Point; width_m: number }[];
  moved: { asset_id: string; label: string; space_id: string; floor_id: string; position: Point }[];
}

export interface MapView {
  you_are_here: Place | null;
  target: Place | null;
  route: { length_m: number; pieces: RoutePiece[] } | null;
  focus_floor_id: string | null;
  changes?: MapChanges | null;
}

export interface Question {
  question: string;
  options: { label: string; description?: string }[];
  allow_free_text: boolean;
}

export interface ChatReply {
  reply: string;
  question: Question | null;
  map: MapView | null;
}

/** One row of GET /buildings. */
export interface BuildingRow {
  id: string;
  split: string;
  name?: string;
  source?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The backend. EXPO_PUBLIC_API_URL when set at build time (e.g. a separately hosted backend); otherwise the
 * site's own address when the backend serves the site (npm run build), or localhost:8000 while developing
 * (npx expo start --web on 8081). */
export function defaultApiUrl(location: { origin: string; port: string } | undefined): string {
  if (location && location.origin.startsWith('http') && location.port !== '8081') return location.origin;
  return 'http://localhost:8000';
}

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? defaultApiUrl(typeof window !== 'undefined' ? window.location : undefined)
).replace(/\/$/, '');

async function call<T>(path: string, init?: RequestInit, fetcher: typeof fetch = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${API_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(`Can't reach the server at ${API_URL}.`, 0);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail ?? detail;
    } catch {
      // keep the status text
    }
    throw new ApiError(String(detail), response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  buildings: (fetcher?: typeof fetch) => call<BuildingRow[]>('/buildings', undefined, fetcher),
  building: (id: string, fetcher?: typeof fetch) => call<BuildingDetail>(`/buildings/${id}`, undefined, fetcher),
  outline: (id: string, fetcher?: typeof fetch) => call<Outline>(`/buildings/${id}/outline`, undefined, fetcher),
  startSession: (buildingId: string, fetcher?: typeof fetch) =>
    call<{ session_id: string; building_name: string }>(
      '/sessions',
      { method: 'POST', body: JSON.stringify({ building_id: buildingId }) },
      fetcher,
    ),
  endSession: (sessionId: string, fetcher?: typeof fetch) =>
    call<{ ended: boolean }>(`/sessions/${sessionId}`, { method: 'DELETE' }, fetcher),
  /** One turn. spoken: said into the mic and read out, so Finni answers in one short sentence (and faster). */
  chat: (sessionId: string, text: string, fetcher?: typeof fetch, spoken = false) =>
    call<ChatReply>(`/sessions/${sessionId}/chat`, { method: 'POST', body: JSON.stringify({ text, spoken }) }, fetcher),
  /** Where the person is, by a place's name (the AR camera can call this too): from then on Finni doesn't ask. */
  setPosition: (sessionId: string, space: string, fetcher?: typeof fetch) =>
    call<Position>(`/sessions/${sessionId}/position`, { method: 'POST', body: JSON.stringify({ space }) }, fetcher),
  /** Where the person is, by a point on a floor: a tap on the map ("I'm here"). */
  setPositionAt: (sessionId: string, floorId: string, [x, y]: Point, fetcher?: typeof fetch) =>
    call<Position>(
      `/sessions/${sessionId}/position`,
      { method: 'POST', body: JSON.stringify({ floor: floorId, x, y }) },
      fetcher,
    ),
};

/** Where the person is, as the server took it; on a route, how far along they are. */
export interface Position {
  space_id: string;
  floor_id: string;
  label: string;
  point: Point | null;
  source: string;
  floor: string;
  on_route?: boolean;
  route_to?: string;
  arrived?: boolean;
  next?: string | null;
}

/** The map's "you are here" for a position: the exact point when known, else the room's centre. */
export function placeOf(position: Position, detail: { spaces: { id: string; anchor: Point }[] }): Place {
  const anchor = detail.spaces.find((space) => space.id === position.space_id)?.anchor ?? [0, 0];
  return { label: position.label, floor_id: position.floor_id, position: position.point ?? anchor,
           space_id: position.space_id };
}

/** ?building=<id> in the page's address (web only). */
export function buildingFromUrl(
  search = typeof window !== 'undefined' && window.location ? window.location.search : '',
): string | undefined {
  return new URLSearchParams(search).get('building') ?? undefined;
}

/** Put the open building in the page's address, so a reload (or a shared link) opens it again (web only). */
export function showBuildingInUrl(id: string) {
  if (typeof window === 'undefined' || !window.history?.replaceState || !window.location) return;
  const url = new URL(window.location.href);
  url.searchParams.set('building', id);
  window.history.replaceState(null, '', url.toString());
}

/** The building to open: EXPO_PUBLIC_BUILDING if set, else the first factory, else the first building. */
export function pickBuilding(ids: string[], preferred = process.env.EXPO_PUBLIC_BUILDING): string | undefined {
  if (preferred && ids.includes(preferred)) return preferred;
  return ids.find((id) => id.includes('factory')) ?? ids[0];
}
