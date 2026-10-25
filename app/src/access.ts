/** The access code of a shared link (…/?code=abc): read once from the address, kept for the visit, sent with
 * every call that costs credits (the server checks it when FINNI_ACCESS_CODE is set). */
const KEY = 'finni-code';
export const ACCESS_HEADER = 'x-finni-code';

let cached: string | null | undefined;

export function codeFrom(search: string): string | null {
  const match = /[?&]code=([^&#]+)/.exec(search);
  return match ? decodeURIComponent(match[1]) : null;
}

export function accessCode(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof window === 'undefined' || !window.location) return cached;
  cached = codeFrom(window.location.search ?? '');
  try {
    if (cached) window.sessionStorage?.setItem(KEY, cached);
    else cached = window.sessionStorage?.getItem(KEY) ?? null;
  } catch {
    // private mode: the code from the address is enough
  }
  return cached;
}

/** Headers to add to a request: the code, if this visit has one. */
export function accessHeaders(): Record<string, string> {
  const code = accessCode();
  return code ? { [ACCESS_HEADER]: code } : {};
}
