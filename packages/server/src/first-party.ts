import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingTouch } from '@datahash/store';

/**
 * First-party cookie set by OUR server on the brand's own tracking address (for example track.brand.com).
 *
 * It holds the visitor's recent ad clicks, signed so it cannot be edited in the browser. Nothing is stored on our side:
 * the cookie lives in the visitor's browser, and the server only reads it back when the visitor identifies themselves
 * (phone or email) on a later request to the same address. This keeps the "store nothing until identified" rule.
 */
export interface CookieTouch {
  clickedAt: number;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  fbc?: string;
  ctwaClid?: string;
  utm?: Record<string, string>;
}

export const MAX_COOKIE_TOUCHES = 5;
/** Browsers drop a cookie larger than about 4096 bytes (name and value together). Stay clear of that. */
export const MAX_COOKIE_BYTES = 3800;
const ID_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ctwaClid'] as const;

export const cookieName = (siteKey: string) => `dh_c_${siteKey.replace(/[^A-Za-z0-9_]/g, '_')}`;

/** Same click = same IDs, whenever it was seen. */
export const clickIdentity = (t: Pick<CookieTouch, (typeof ID_KEYS)[number]>) => ID_KEYS.map((k) => t[k] ?? '').join('|');

const mac = (secret: Buffer | string, body: string) => createHmac('sha256', secret).update(`v1.${body}`).digest('base64url');

export function sealTouches(touches: CookieTouch[], secret: Buffer | string): string {
  const body = Buffer.from(JSON.stringify(touches)).toString('base64url');
  return `v1.${body}.${mac(secret, body)}`;
}

/** The touches in a cookie value, or [] if it is missing, edited, or not ours. */
export function openTouches(value: string | undefined, secret: Buffer | string): CookieTouch[] {
  if (!value) return [];
  const [version, body, signature] = value.split('.');
  if (version !== 'v1' || !body || !signature) return [];
  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return [];
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is CookieTouch => Boolean(t) && typeof t === 'object' && typeof (t as CookieTouch).clickedAt === 'number')
      .slice(0, 10);
  } catch {
    return [];
  }
}

/** Add a click. A click already in the cookie keeps its original time; the first click and the latest ones are kept. */
export function addTouch(existing: CookieTouch[], incoming: CookieTouch): CookieTouch[] {
  if (existing.some((t) => clickIdentity(t) === clickIdentity(incoming))) return existing;
  const all = [...existing, incoming].sort((a, b) => a.clickedAt - b.clickedAt);
  return all.length <= MAX_COOKIE_TOUCHES ? all : [all[0]!, ...all.slice(all.length - (MAX_COOKIE_TOUCHES - 1))];
}

/**
 * Seal the touches into a cookie value that is guaranteed to fit. If it would be too big, the less useful parts go
 * first: campaign (utm) details of older clicks, then of all clicks, then the clicks between the first and the latest.
 * Returns null if even one click on its own does not fit.
 */
export function sealWithinLimit(name: string, touches: CookieTouch[], secret: Buffer | string, maxBytes = MAX_COOKIE_BYTES): { value: string; touches: CookieTouch[] } | null {
  const fits = (t: CookieTouch[]) => name.length + 1 + sealTouches(t, secret).length <= maxBytes;
  const withoutUtm = (t: CookieTouch): CookieTouch => {
    const { utm: _utm, ...rest } = t;
    return rest;
  };
  let current = touches;
  if (!fits(current)) current = current.map((t, i) => (i === current.length - 1 ? t : withoutUtm(t)));
  if (!fits(current)) current = current.map(withoutUtm);
  while (!fits(current) && current.length > 2) current = [current[0]!, ...current.slice(2)]; // drop the second oldest
  if (!fits(current) && current.length === 2) current = [current[1]!]; // keep the newest click
  return fits(current) ? { value: sealTouches(current, secret), touches: current } : null;
}

/** Combine clicks from two places (browser storage and the cookie) without duplicates; the earlier time wins. */
export function mergeClicks<T extends CookieTouch | IncomingTouch>(a: T[], b: T[], limit = 10): T[] {
  const byClick = new Map<string, T>();
  for (const t of [...a, ...b]) {
    const key = clickIdentity(t as CookieTouch);
    const seen = byClick.get(key);
    const time = (x: T) => (x.clickedAt instanceof Date ? x.clickedAt.getTime() : Number(x.clickedAt));
    if (!seen || time(t) < time(seen)) byClick.set(key, t);
  }
  return [...byClick.values()].sort((x, y) => Number(x.clickedAt) - Number(y.clickedAt)).slice(0, limit);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Host-only (no Domain), HttpOnly, SameSite=Lax: sent to the tracking address by the brand's own pages, not readable by scripts. */
export function setCookieHeader(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  return `${name}=${value}; Max-Age=${opts.maxAgeSec}; Path=/; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}

export function clearCookieHeader(name: string, secure: boolean): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
