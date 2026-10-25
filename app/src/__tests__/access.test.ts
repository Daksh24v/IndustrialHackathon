import { codeFrom } from '../access';

describe('access code from a shared link', () => {
  it('reads ?code= wherever it is in the address', () => {
    expect(codeFrom('?code=abc123')).toBe('abc123');
    expect(codeFrom('?building=proc-factory-dev-003&code=x%2By')).toBe('x+y');
    expect(codeFrom('?building=b')).toBeNull();
    expect(codeFrom('')).toBeNull();
  });
});
