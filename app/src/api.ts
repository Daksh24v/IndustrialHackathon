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
  space_id: string;
  floor_id: string;
  position: Point;
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

export interface MapView {
  you_are_here: Place | null;
  target: Place | null;
  route: { length_m: number; pieces: RoutePiece[] } | null;
  focus_floor_id: string | null;
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

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');

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
  buildings: (fetcher?: typeof fetch) => call<{ id: string; split: string }[]>('/buildings', undefined, fetcher),
  building: (id: string, fetcher?: typeof fetch) => call<BuildingDetail>(`/buildings/${id}`, undefined, fetcher),
  outline: (id: string, fetcher?: typeof fetch) => call<Outline>(`/buildings/${id}/outline`, undefined, fetcher),
  startSession: (buildingId: string, fetcher?: typeof fetch) =>
    call<{ session_id: string; building_name: string }>(
      '/sessions',
      { method: 'POST', body: JSON.stringify({ building_id: buildingId }) },
      fetcher,
    ),
  chat: (sessionId: string, text: string, fetcher?: typeof fetch) =>
    call<ChatReply>(`/sessions/${sessionId}/chat`, { method: 'POST', body: JSON.stringify({ text }) }, fetcher),
  /** Where the person is (the AR camera will call this): from then on Finni doesn't ask. */
  setPosition: (sessionId: string, space: string, fetcher?: typeof fetch) =>
    call<{ space_id: string; label: string; floor_id: string }>(
      `/sessions/${sessionId}/position`,
      { method: 'POST', body: JSON.stringify({ space }) },
      fetcher,
    ),
};

/** The building to open: EXPO_PUBLIC_BUILDING if set, else the first factory, else the first building. */
export function pickBuilding(ids: string[], preferred = process.env.EXPO_PUBLIC_BUILDING): string | undefined {
  if (preferred && ids.includes(preferred)) return preferred;
  return ids.find((id) => id.includes('factory')) ?? ids[0];
}
