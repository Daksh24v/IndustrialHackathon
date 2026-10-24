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
