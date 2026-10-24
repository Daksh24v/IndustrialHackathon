import { api, ApiError, pickBuilding, placeOf } from '../api';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({ ok: status < 400, status, statusText: 'x', json: async () => body }) as Response) as typeof fetch;
}

describe('api', () => {
  it('parses a chat reply', async () => {
    const reply = await api.chat('s1', 'hi', fakeFetch(200, { reply: 'Hello', question: null, map: null }));
    expect(reply.reply).toBe('Hello');
  });

  it('turns server errors into ApiError with the detail', async () => {
    await expect(api.chat('s1', 'hi', fakeFetch(404, { detail: 'Unknown or expired session' }))).rejects.toEqual(
      new ApiError('Unknown or expired session', 404),
    );
  });

  it('reports an unreachable server', async () => {
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(api.buildings(down)).rejects.toMatchObject({ status: 0 });
  });

  it('sends a tapped point as the position and draws the dot there', async () => {
    let sent: RequestInit | undefined;
    const position = { space_id: 'S1', floor_id: 'F0', label: 'Lab 0.21 (Ground floor)', point: [3, 4], source: 'phone', floor: 'Ground floor' };
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent = init;
      return { ok: true, status: 200, statusText: 'x', json: async () => position } as Response;
    }) as unknown as typeof fetch;
    const placed = await api.setPositionAt('s1', 'F0', [3, 4], fetcher);
    expect(JSON.parse(String(sent?.body))).toEqual({ floor: 'F0', x: 3, y: 4 });
    expect(placeOf(placed, { spaces: [{ id: 'S1', anchor: [9, 9] }] }).position).toEqual([3, 4]);
    expect(placeOf({ ...placed, point: null }, { spaces: [{ id: 'S1', anchor: [9, 9] }] }).position).toEqual([9, 9]);
  });

  it('picks the building to open', () => {
    expect(pickBuilding(['osm-1', 'proc-factory-dev-003', 'b'], undefined)).toBe('proc-factory-dev-003');
    expect(pickBuilding(['osm-1', 'b'], 'b')).toBe('b');
    expect(pickBuilding(['osm-1'], 'missing')).toBe('osm-1');
  });
});

describe('position (for the AR camera)', () => {
  it('posts where the person is', async () => {
    let seen: { url: string; body: string } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ space_id: 'S1', label: 'Lab', floor_id: 'F0' }) };
    }) as unknown as typeof fetch;
    const placed = await api.setPosition('s1', 'Quality lab 0.21', fetcher);
    expect(placed.floor_id).toBe('F0');
    expect(seen!.url).toMatch(/\/sessions\/s1\/position$/);
    expect(JSON.parse(seen!.body)).toEqual({ space: 'Quality lab 0.21' });
  });
});

describe('spoken turns', () => {
  it('tells the backend when a turn was said into the mic', async () => {
    const bodies: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ reply: 'Kitchen 2.04, 40 m.', question: null, map: null }) };
    }) as unknown as typeof fetch;
    await api.chat('s1', 'coffee?', fetcher);
    await api.chat('s1', 'coffee?', fetcher, true);
    expect(bodies.map((body) => JSON.parse(body).spoken)).toEqual([false, true]);
  });
});
