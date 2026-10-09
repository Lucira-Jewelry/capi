import {
  addTouch,
  cookieName,
  clearCookieHeader,
  openTouches,
  parseCookies,
  sealWithinLimit,
  setCookieHeader,
  type CookieTouch,
} from './first-party';
import { onTrackingHost, parseBody, validateTouch, type HandlerDeps, type HandlerResponse } from './identify';

const CLICK_FIELDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ctwaClid'] as const;

/**
 * The visitor landed from an ad: remember the click in a signed first-party cookie, set by our server on the brand's
 * own tracking address. Nothing is stored in the database. Also: GET returns what the cookie holds (for testing and
 * for the script), and `{ clear: true }` removes it.
 *
 * Only acts on the brand's tracking address. On the shared product address there is no first-party cookie to set, so it
 * answers "skipped" and the script keeps relying on browser storage.
 */
export async function handleTouch(
  input: {
    method: string;
    body?: unknown;
    query?: URLSearchParams;
    origin?: string | undefined;
    host?: string | undefined;
    cookieHeader?: string | undefined;
    secure: boolean;
  },
  deps: HandlerDeps,
): Promise<HandlerResponse> {
  const now = deps.now ? deps.now() : new Date();
  const isGet = input.method === 'GET';
  const body = isGet ? ({ key: input.query?.get('key') } as Record<string, unknown>) : (parseBody(input.body) as Record<string, unknown> | null);
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid_json' } };

  const site = typeof body.key === 'string' ? await deps.findSite(body.key) : null;
  if (!site) return { status: 401, body: { error: 'unknown_key' } };
  if (site.origins.length > 0 && !(input.origin && site.origins.includes(input.origin))) {
    return { status: 403, body: { error: 'origin_not_allowed' } };
  }
  if (!deps.cookieSecret || !onTrackingHost(site, input.host)) {
    return { status: 200, body: { status: 'skipped', reason: 'not_first_party_host' } };
  }

  const name = cookieName(body.key as string);
  // Clicks older than the brand's retention period are not kept or used, even though the cookie may still hold them.
  const cutoff = now.getTime() - site.retentionDays * 86_400_000;
  const existing = openTouches(parseCookies(input.cookieHeader)[name], deps.cookieSecret).filter((t) => t.clickedAt >= cutoff);

  if (isGet) return { status: 200, body: { status: 'ok', touches: existing } };
  if (body.clear === true) return { status: 200, body: { status: 'cleared' }, setCookie: clearCookieHeader(name, input.secure) };

  // Same consent rule as identify: an opt-in brand needs an explicit yes, an opt-out brand needs no "no".
  const consent = body.consent;
  if ((site.consentMode === 'opt_in' && consent !== true) || (site.consentMode === 'opt_out' && consent === false)) {
    return { status: 202, body: { status: 'skipped', reason: 'no_consent' } };
  }

  const checked = validateTouch((body.touch ?? {}) as Record<string, unknown>, now);
  if (!checked.ok) return { status: 400, body: { error: checked.error } };
  if (!CLICK_FIELDS.some((f) => checked.touch[f])) return { status: 400, body: { error: 'no_click_id' } };

  const touch: CookieTouch = { clickedAt: checked.touch.clickedAt as number };
  for (const f of [...CLICK_FIELDS, 'fbc'] as const) if (checked.touch[f]) touch[f] = checked.touch[f];
  if (checked.touch.utm) touch.utm = checked.touch.utm;

  if (touch.clickedAt < cutoff) return { status: 200, body: { status: 'skipped', reason: 'expired' } };

  const sealed = sealWithinLimit(name, addTouch(existing, touch), deps.cookieSecret);
  if (!sealed) return { status: 400, body: { error: 'touch_too_large' } };
  return {
    status: 200,
    body: { status: 'ok', touches: sealed.touches.length },
    setCookie: setCookieHeader(name, sealed.value, { maxAgeSec: site.retentionDays * 86_400, secure: input.secure }),
  };
}
