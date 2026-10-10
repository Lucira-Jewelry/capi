import { normalizeFbp } from '@datahash/core';
import type { IdentifyInput, IdentifyResult } from '@datahash/store';
import { cookieName, mergeClicks, openTouches, parseCookies, clearCookieHeader } from './first-party';

/** What the browser endpoint needs to know about a site key. Comes from the tenant registry. */
export interface SiteLookup {
  tenantId: string;
  /** Allowed page origins, e.g. ["https://www.brand.com"]. Empty = any (development only). */
  origins: string[];
  consentMode: 'opt_in' | 'opt_out';
  retentionDays: number;
  defaultCountry: NonNullable<IdentifyInput['defaultCountry']>;
  /** The brand's own tracking address (see SiteKeyRecord.trackingHost). */
  trackingHost?: string;
}

export interface IdentifyStore {
  identify(input: IdentifyInput): Promise<IdentifyResult>;
  /** Record that the customer withdrew consent (see Store.withdraw). */
  withdraw?(
    contact: { phone?: string | null; email?: string | null; defaultCountry?: SiteLookup['defaultCountry'] },
    now?: Date,
  ): Promise<{ keys: number; personFound: boolean }>;
}

export interface HandlerDeps {
  /** Resolve a public site key; null if unknown or the brand is suspended. */
  findSite: (key: string) => Promise<SiteLookup | null>;
  storeFor: (site: SiteLookup) => IdentifyStore;
  now?: () => Date;
  /** Key that signs the first-party cookie. Without it the cookie is neither set nor read. */
  cookieSecret?: Buffer | string;
}

export interface HandlerResponse {
  status: number;
  body: Record<string, unknown>;
  /** A Set-Cookie header value to send with the response. */
  setCookie?: string;
}

/** Is this request arriving on the brand's own tracking address? Only then is the first-party cookie used. */
export function onTrackingHost(site: Pick<SiteLookup, 'trackingHost'>, host: string | undefined): boolean {
  return Boolean(site.trackingHost && host && host.toLowerCase() === site.trackingHost);
}

const MAX_TOUCHES = 10;
const MAX_STR = 512;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_STRING_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'ctwaClid', 'landingUrl'] as const;

const isStr = (v: unknown, max = MAX_STR): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseBody(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/** One touch from the browser or the cookie: times in range, strings short, only known fields. */
export function validateTouch(
  t: Record<string, unknown>,
  now: Date,
): { ok: true; touch: NonNullable<IdentifyInput['touches']>[number] } | { ok: false; error: string } {
  const clickedAt = t?.clickedAt;
  if (typeof clickedAt !== 'number' || clickedAt < now.getTime() - 400 * DAY_MS || clickedAt > now.getTime() + 5 * 60 * 1000) {
    return { ok: false, error: 'invalid_touch_time' };
  }
  const touch: NonNullable<IdentifyInput['touches']>[number] = { clickedAt };
  for (const key of TOUCH_STRING_KEYS) {
    const v = t[key];
    if (v === undefined) continue;
    if (!isStr(v)) return { ok: false, error: 'invalid_touch_field' };
    touch[key] = v;
  }
  if (t.utm && typeof t.utm === 'object') {
    const utm: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.utm as Record<string, unknown>)) {
      if (k.startsWith('utm_') && isStr(v, 256)) utm[k] = v;
    }
    if (Object.keys(utm).length) touch.utm = utm;
  }
  return { ok: true, touch };
}

export async function handleIdentify(
  input: { body: unknown; origin?: string | undefined; host?: string | undefined; cookieHeader?: string | undefined },
  deps: HandlerDeps,
): Promise<HandlerResponse> {
  const now = deps.now ? deps.now() : new Date();
  const body = parseBody(input.body) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid_json' } };

  const tenant = typeof body.key === 'string' ? await deps.findSite(body.key) : null;
  if (!tenant) return { status: 401, body: { error: 'unknown_key' } };
  if (tenant.origins.length > 0 && !(input.origin && tenant.origins.includes(input.origin))) {
    return { status: 403, body: { error: 'origin_not_allowed' } };
  }

  const phone = body.phone;
  const email = body.email;
  if ((phone !== undefined && !isStr(phone, 64)) || (email !== undefined && !isStr(email, 320))) {
    return { status: 400, body: { error: 'invalid_contact' } };
  }
  if (!phone && !email) return { status: 400, body: { error: 'missing_contact' } };

  const consentIn = body.consent as { ads?: unknown } | undefined;
  const adsConsent = typeof consentIn?.ads === 'boolean' ? consentIn.ads : undefined;
  // An explicit "no" is remembered as a suppression, so queued and future sales for this customer are not sent.
  if (adsConsent === false) {
    await deps.storeFor(tenant).withdraw?.(
      { ...(phone ? { phone: phone as string } : {}), ...(email ? { email: email as string } : {}), defaultCountry: tenant.defaultCountry },
      now,
    );
    return { status: 202, body: { status: 'skipped', reason: 'declined' } };
  }
  if (tenant.consentMode === 'opt_in' && adsConsent !== true) {
    // Nothing is stored without a clear yes where the tenant's policy requires opt-in.
    return { status: 202, body: { status: 'skipped', reason: 'no_consent' } };
  }

  const rawTouches = body.touches === undefined ? [] : body.touches;
  if (!Array.isArray(rawTouches) || rawTouches.length > MAX_TOUCHES) {
    return { status: 400, body: { error: 'invalid_touches' } };
  }

  // Clicks older than the brand's retention period are ignored (not an error: a returning visitor may still carry one).
  const cutoff = now.getTime() - tenant.retentionDays * DAY_MS;
  const touches: NonNullable<IdentifyInput['touches']> = [];
  for (const t of rawTouches as Record<string, unknown>[]) {
    if (typeof t?.clickedAt === 'number' && t.clickedAt < cutoff) continue;
    const checked = validateTouch(t, now);
    if (!checked.ok) return { status: 400, body: { error: checked.error } };
    touches.push(checked.touch);
  }

  // On the brand's own tracking address the browser also sends our signed cookie: use it as well, so a visitor whose
  // browser storage was cleared still keeps their click.
  if (deps.cookieSecret && onTrackingHost(tenant, input.host)) {
    const fromCookie = openTouches(parseCookies(input.cookieHeader)[cookieName(body.key as string)], deps.cookieSecret)
      .filter((t) => t.clickedAt >= cutoff && t.clickedAt <= now.getTime() + 5 * 60 * 1000)
      .map((t) => validateTouch(t as unknown as Record<string, unknown>, now))
      .flatMap((r) => (r.ok ? [r.touch] : []));
    touches.splice(0, touches.length, ...mergeClicks(touches as never[], fromCookie as never[], MAX_TOUCHES) as typeof touches);
  }

  const identifyInput: IdentifyInput = { now, touches };
  if (phone) identifyInput.phone = phone as string;
  if (email) identifyInput.email = email as string;
  identifyInput.defaultCountry = tenant.defaultCountry;
  if (adsConsent !== undefined) identifyInput.consent = { ads: adsConsent, source: 'tracker' };
  // Meta's browser ID: a malformed value is ignored rather than failing the whole call.
  if (typeof body.fbp === 'string' && normalizeFbp(body.fbp)) identifyInput.fbp = body.fbp.trim();

  const result = await deps.storeFor(tenant).identify(identifyInput);
  if (result.status === 'rejected') return { status: 422, body: { error: result.reason } };
  return {
    status: 200,
    body: { status: 'ok', created: result.created, merged: result.merged, touches: result.touchesWritten },
  };
}

/**
 * A visitor withdrew consent on the website. Only withdrawals are accepted here (a grant needs the full identify
 * call), and, like identify, the call needs a valid site key from an allowed origin.
 */
export async function handleWithdraw(
  input: { body: unknown; origin?: string | undefined; host?: string | undefined; secure?: boolean },
  deps: HandlerDeps,
): Promise<HandlerResponse> {
  const now = deps.now ? deps.now() : new Date();
  const body = parseBody(input.body) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid_json' } };

  const site = typeof body.key === 'string' ? await deps.findSite(body.key) : null;
  if (!site) return { status: 401, body: { error: 'unknown_key' } };
  if (site.origins.length > 0 && !(input.origin && site.origins.includes(input.origin))) {
    return { status: 403, body: { error: 'origin_not_allowed' } };
  }

  const { phone, email } = body;
  if ((phone !== undefined && !isStr(phone, 64)) || (email !== undefined && !isStr(email, 320)) || (!phone && !email)) {
    return { status: 400, body: { error: 'invalid_contact' } };
  }
  const store = deps.storeFor(site);
  if (!store.withdraw) return { status: 501, body: { error: 'not_supported' } };
  const r = await store.withdraw(
    { ...(phone ? { phone: phone as string } : {}), ...(email ? { email: email as string } : {}), defaultCountry: site.defaultCountry },
    now,
  );
  // The first-party cookie goes too, when this request came through the brand's tracking address.
  const clear = onTrackingHost(site, input.host) ? clearCookieHeader(cookieName(body.key as string), input.secure ?? false) : undefined;
  return { status: 200, body: { status: 'withdrawn', ...r }, ...(clear ? { setCookie: clear } : {}) };
}
