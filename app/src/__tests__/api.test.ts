import { api, ApiError, pickBuilding } from '../api';

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

describe('where the backend is', () => {
  const { defaultApiUrl } = require('../api');

  it('is the site itself when the backend serves the site', () => {
    expect(defaultApiUrl({ origin: 'https://finni.example.com', port: '' })).toBe('https://finni.example.com');
    expect(defaultApiUrl({ origin: 'http://192.168.1.5:8000', port: '8000' })).toBe('http://192.168.1.5:8000');
  });

  it('is localhost:8000 while developing, and off the web', () => {
    expect(defaultApiUrl({ origin: 'http://localhost:8081', port: '8081' })).toBe('http://localhost:8000');
    expect(defaultApiUrl(undefined)).toBe('http://localhost:8000');
  });
});
