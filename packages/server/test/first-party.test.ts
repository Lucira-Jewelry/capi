import { describe, expect, it, vi } from 'vitest';
import type { IdentifyInput, IdentifyResult } from '@datahash/store';
import {
  addTouch,
  clearCookieHeader,
  cookieName,
  handleIdentify,
  handleTouch,
  handleWithdraw,
  mergeClicks,
  openTouches,
  MAX_COOKIE_BYTES,
  parseCookies,
  sealTouches,
  sealWithinLimit,
  setCookieHeader,
  type CookieTouch,
  type SiteLookup,
} from '../src';

const NOW = new Date('2026-10-09T12:00:00Z');
const at = (days: number) => NOW.getTime() - days * 86_400_000;
const SECRET = 'cookie-secret';
const KEY = 'pk_aaaaaaaaaaaaaaaaaaaaaaaa';

describe('signed cookie', () => {
  const touches: CookieTouch[] = [{ clickedAt: at(3), gclid: 'G1', fbclid: 'F1', fbc: 'fb.1.1.F1' }];

  it('round-trips and uses only cookie-safe characters', () => {
    const value = sealTouches(touches, SECRET);
    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(openTouches(value, SECRET)).toEqual(touches);
  });

  it('rejects an edited cookie, the wrong secret, and junk', () => {
    const value = sealTouches(touches, SECRET);
    const [v, body, mac] = value.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify([{ clickedAt: at(1), gclid: 'STOLEN' }])).toString('base64url');
    expect(openTouches(`${v}.${forged}.${mac}`, SECRET)).toEqual([]);
    expect(openTouches(value, 'other-secret')).toEqual([]);
    expect(openTouches('garbage', SECRET)).toEqual([]);
    expect(openTouches(undefined, SECRET)).toEqual([]);
    expect(openTouches(`${v}.${body}.`, SECRET)).toEqual([]);
  });

  it('cookie names carry the site key; headers are host-only, HttpOnly and SameSite=Lax', () => {
    expect(cookieName(KEY)).toBe(`dh_c_${KEY}`);
    expect(cookieName('a.b-c')).toBe('dh_c_a_b_c');
    const header = setCookieHeader('n', 'v', { maxAgeSec: 100, secure: false });
    expect(header).toBe('n=v; Max-Age=100; Path=/; HttpOnly; SameSite=Lax');
    expect(header).not.toMatch(/Domain|Secure/);
    expect(setCookieHeader('n', 'v', { maxAgeSec: 100, secure: true })).toContain('; Secure');
    expect(clearCookieHeader('n', true)).toBe('n=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure');
  });

  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; dh_c_x=v1.abc.def; theme=dark')).toEqual({ a: '1', dh_c_x: 'v1.abc.def', theme: 'dark' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('adding and merging clicks', () => {
  it('a click that is already there keeps its original time; new ones are added in order', () => {
    const first = addTouch([], { clickedAt: at(5), gclid: 'G1' });
    expect(addTouch(first, { clickedAt: at(0), gclid: 'G1' })).toBe(first); // same click again: untouched
    expect(addTouch(first, { clickedAt: at(1), gclid: 'G2' }).map((t) => t.gclid)).toEqual(['G1', 'G2']);
  });

  it('keeps the first click and the latest ones when there are too many', () => {
    let list: CookieTouch[] = [];
    for (let i = 1; i <= 8; i++) list = addTouch(list, { clickedAt: at(10 - i), gclid: `G${i}` });
    expect(list.map((t) => t.gclid)).toEqual(['G1', 'G5', 'G6', 'G7', 'G8']);
  });

  it('mergeClicks combines two sources without duplicates; the earlier time wins', () => {
    const merged = mergeClicks([{ clickedAt: at(2), gclid: 'G1' }, { clickedAt: at(1), gclid: 'G2' }], [{ clickedAt: at(4), gclid: 'G1' }, { clickedAt: at(3), fbclid: 'F9' }]);
    expect(merged.map((t) => [t.gclid ?? t.fbclid, t.clickedAt])).toEqual([['G1', at(4)], ['F9', at(3)], ['G2', at(1)]]);
  });
});

const site = (over: Partial<SiteLookup> = {}): SiteLookup => ({
  tenantId: 'brand-a', origins: ['https://www.brand.com'], consentMode: 'opt_in', retentionDays: 90, defaultCountry: 'IN', trackingHost: 'track.brand.com', ...over,
});
const deps = (s: SiteLookup | null = site()) => ({ findSite: async (k: string) => (k === KEY ? s : null), storeFor: () => ({ identify: vi.fn(), withdraw: vi.fn(async () => ({ keys: 1, personFound: false })) }), now: () => NOW, cookieSecret: SECRET });
const base = { origin: 'https://www.brand.com', host: 'track.brand.com', secure: true };
const touchBody = (extra: object = {}) => ({ key: KEY, consent: true, touch: { clickedAt: at(0), gclid: 'G1', fbclid: 'F1', fbc: 'fb.1.1.F1', utm: { utm_source: 'google' } }, ...extra });

describe('handleTouch', () => {
  it('sets the signed cookie on the brand\'s tracking address, with the retention as its lifetime', async () => {
    const r = await handleTouch({ ...base, method: 'POST', body: touchBody() }, deps());
    expect(r).toMatchObject({ status: 200, body: { status: 'ok', touches: 1 } });
    expect(r.setCookie).toContain(`${cookieName(KEY)}=v1.`);
    expect(r.setCookie).toContain(`Max-Age=${90 * 86_400}`);
    expect(r.setCookie).toContain('Secure');
    const value = parseCookies(r.setCookie!.split('; ')[0])[cookieName(KEY)];
    expect(openTouches(value, SECRET)[0]).toMatchObject({ gclid: 'G1', fbclid: 'F1', fbc: 'fb.1.1.F1', utm: { utm_source: 'google' } });
  });

  it('adds to what is already in the cookie, and does not renew a click it already has', async () => {
    const existing = sealTouches([{ clickedAt: at(5), gclid: 'OLD' }], SECRET);
    const cookieHeader = `${cookieName(KEY)}=${existing}`;
    const add = await handleTouch({ ...base, method: 'POST', body: touchBody(), cookieHeader }, deps());
    expect(add.body).toMatchObject({ touches: 2 });

    const again = await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: at(0), gclid: 'OLD' } }), cookieHeader }, deps());
    const value = parseCookies(again.setCookie!.split('; ')[0])[cookieName(KEY)];
    expect(openTouches(value, SECRET)).toEqual([{ clickedAt: at(5), gclid: 'OLD' }]);
  });

  it('on any other address there is no first-party cookie to set', async () => {
    for (const host of ['collector.product.com', 'evil.example', undefined]) {
      const r = await handleTouch({ ...base, host, method: 'POST', body: touchBody() }, deps());
      expect(r).toEqual({ status: 200, body: { status: 'skipped', reason: 'not_first_party_host' } });
    }
    // a site key without a tracking address, and a server without a cookie secret
    expect((await handleTouch({ ...base, method: 'POST', body: touchBody() }, deps(site({ trackingHost: undefined })))).body).toMatchObject({ status: 'skipped' });
    expect((await handleTouch({ ...base, method: 'POST', body: touchBody() }, { ...deps(), cookieSecret: undefined })).body).toMatchObject({ status: 'skipped' });
  });

  it('applies the brand\'s consent rule and the usual key and origin checks', async () => {
    expect(await handleTouch({ ...base, method: 'POST', body: touchBody({ consent: undefined }) }, deps())).toMatchObject({ status: 202, body: { reason: 'no_consent' } });
    expect(await handleTouch({ ...base, method: 'POST', body: touchBody({ consent: false }) }, deps())).toMatchObject({ status: 202 });
    expect((await handleTouch({ ...base, method: 'POST', body: touchBody({ consent: undefined }) }, deps(site({ consentMode: 'opt_out' })))).status).toBe(200);
    expect((await handleTouch({ ...base, method: 'POST', body: touchBody({ consent: false }) }, deps(site({ consentMode: 'opt_out' })))).status).toBe(202);

    expect((await handleTouch({ ...base, method: 'POST', body: touchBody({ key: 'nope' }) }, deps())).status).toBe(401);
    expect((await handleTouch({ ...base, origin: 'https://evil.example', method: 'POST', body: touchBody() }, deps())).status).toBe(403);
    expect((await handleTouch({ ...base, method: 'POST', body: '{nope' }, deps())).status).toBe(400);
  });

  it('refuses touches without a click ID, or with a time out of range', async () => {
    expect(await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: at(0), landingUrl: 'https://x' } }) }, deps())).toMatchObject({ status: 400, body: { error: 'no_click_id' } });
    expect((await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: at(500), gclid: 'G' } }) }, deps())).status).toBe(400);
    expect((await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: NOW.getTime() + 3_600_000, gclid: 'G' } }) }, deps())).status).toBe(400);
  });

  it('GET shows what the cookie holds; a tampered cookie shows nothing; clear removes it', async () => {
    const value = sealTouches([{ clickedAt: at(2), gclid: 'G1' }], SECRET);
    const get = (cookie: string) => handleTouch({ ...base, method: 'GET', query: new URLSearchParams({ key: KEY }), cookieHeader: cookie }, deps());
    expect((await get(`${cookieName(KEY)}=${value}`)).body).toEqual({ status: 'ok', touches: [{ clickedAt: at(2), gclid: 'G1' }] });
    expect((await get(`${cookieName(KEY)}=${value}x`)).body).toEqual({ status: 'ok', touches: [] });

    const cleared = await handleTouch({ ...base, method: 'POST', body: { key: KEY, clear: true } }, deps());
    expect(cleared).toMatchObject({ status: 200, body: { status: 'cleared' } });
    expect(cleared.setCookie).toContain('Max-Age=0');
  });
});

describe('identify and withdraw use the cookie', () => {
  const identifyDeps = () => {
    const identify = vi.fn(async (_i: IdentifyInput): Promise<IdentifyResult> => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 0 }));
    return { identify, d: { findSite: async (k: string) => (k === KEY ? site() : null), storeFor: () => ({ identify }), now: () => NOW, cookieSecret: SECRET } };
  };
  const cookieWith = (touches: CookieTouch[]) => `${cookieName(KEY)}=${sealTouches(touches, SECRET)}`;
  const body = (touches: object[] = []) => ({ key: KEY, phone: '98765 43210', consent: { ads: true }, touches });

  it('on the tracking address, clicks from the cookie join the ones the browser sent', async () => {
    const { identify, d } = identifyDeps();
    await handleIdentify(
      { body: body([{ clickedAt: at(1), fbclid: 'F-browser' }]), origin: base.origin, host: 'track.brand.com', cookieHeader: cookieWith([{ clickedAt: at(6), gclid: 'G-cookie' }]) },
      d,
    );
    expect(identify.mock.calls[0]![0].touches?.map((t) => t.gclid ?? t.fbclid)).toEqual(['G-cookie', 'F-browser']);
  });

  it('a visitor whose browser storage was cleared still keeps their click through the cookie', async () => {
    const { identify, d } = identifyDeps();
    await handleIdentify({ body: body([]), origin: base.origin, host: 'track.brand.com', cookieHeader: cookieWith([{ clickedAt: at(6), gclid: 'G-cookie' }]) }, d);
    expect(identify.mock.calls[0]![0].touches).toHaveLength(1);
  });

  it('the same click in both places is counted once, with the earlier time', async () => {
    const { identify, d } = identifyDeps();
    await handleIdentify({ body: body([{ clickedAt: at(2), gclid: 'G1' }]), origin: base.origin, host: 'track.brand.com', cookieHeader: cookieWith([{ clickedAt: at(6), gclid: 'G1' }]) }, d);
    expect(identify.mock.calls[0]![0].touches).toEqual([{ clickedAt: at(6), gclid: 'G1' }]);
  });

  it('on another address, or with a forged or expired cookie, the cookie is ignored', async () => {
    const run = async (host: string, cookieHeader: string) => {
      const { identify, d } = identifyDeps();
      await handleIdentify({ body: body(), origin: base.origin, host, cookieHeader }, d);
      return identify.mock.calls[0]![0].touches;
    };
    expect(await run('collector.product.com', cookieWith([{ clickedAt: at(2), gclid: 'G1' }]))).toEqual([]);
    expect(await run('track.brand.com', `${cookieName(KEY)}=v1.${Buffer.from('[{"clickedAt":1,"gclid":"X"}]').toString('base64url')}.AAAA`)).toEqual([]);
    expect(await run('track.brand.com', cookieWith([{ clickedAt: at(500), gclid: 'ancient' }]))).toEqual([]);
  });

  it('withdrawing through the tracking address also clears the cookie; elsewhere it does not', async () => {
    const d = { findSite: async (k: string) => (k === KEY ? site() : null), storeFor: () => ({ identify: vi.fn(), withdraw: async () => ({ keys: 1, personFound: true }) }), now: () => NOW, cookieSecret: SECRET };
    const on = await handleWithdraw({ body: { key: KEY, phone: '98765 43210' }, origin: base.origin, host: 'track.brand.com', secure: true }, d);
    expect(on.setCookie).toBe(clearCookieHeader(cookieName(KEY), true));
    const off = await handleWithdraw({ body: { key: KEY, phone: '98765 43210' }, origin: base.origin, host: 'collector.product.com' }, d);
    expect(off.setCookie).toBeUndefined();
  });
});

describe('the cookie always fits in the browser', () => {
  const name = cookieName(KEY);
  const big = (i: number, fill = 500): CookieTouch => ({
    clickedAt: at(10 - i), gclid: `G${i}-${'g'.repeat(fill)}`, gbraid: 'b'.repeat(fill), wbraid: 'w'.repeat(fill), fbclid: 'f'.repeat(fill), fbc: 'c'.repeat(fill), ctwaClid: 't'.repeat(fill),
    utm: { utm_source: 's'.repeat(250), utm_campaign: 'c'.repeat(250), utm_term: 't'.repeat(250), utm_content: 'x'.repeat(250) },
  });
  const size = (value: string) => name.length + 1 + value.length;

  it('small cookies are left exactly as they are', () => {
    const touches: CookieTouch[] = [{ clickedAt: at(3), gclid: 'G1', utm: { utm_source: 'google' } }];
    expect(sealWithinLimit(name, touches, SECRET)).toEqual({ value: sealTouches(touches, SECRET), touches });
  });

  it('drops campaign details first, then the clicks in between, but keeps the first and the newest', () => {
    const many = [1, 2, 3, 4, 5].map((i) => big(i, 120));
    const sealed = sealWithinLimit(name, many, SECRET)!;
    expect(sealed).not.toBeNull();
    expect(size(sealed.value)).toBeLessThanOrEqual(MAX_COOKIE_BYTES);
    expect(sealed.touches[0]!.gclid).toBe(many[0]!.gclid);
    expect(sealed.touches[sealed.touches.length - 1]!.gclid).toBe(many[4]!.gclid);
    expect(openTouches(sealed.value, SECRET)).toEqual(sealed.touches); // and it still verifies
  });

  it('with two big clicks that cannot both fit, the newest survives', () => {
    const sealed = sealWithinLimit(name, [big(1, 380), big(2, 380)], SECRET)!;
    expect(size(sealed.value)).toBeLessThanOrEqual(MAX_COOKIE_BYTES);
    expect(sealed.touches).toHaveLength(1);
    expect(sealed.touches[0]!.gclid).toContain('G2');
  });

  it('one click that cannot fit even alone is refused instead of producing a cookie the browser would drop', () => {
    expect(sealWithinLimit(name, [big(1, 800)], SECRET)).toBeNull();
  });

  it('the touch endpoint never sets a cookie over the limit, however much arrives', async () => {
    let cookieHeader: string | undefined;
    for (let i = 1; i <= 8; i++) {
      const r = await handleTouch({ ...base, method: 'POST', cookieHeader, body: touchBody({ touch: { clickedAt: at(10 - i), gclid: `G${i}-${'g'.repeat(400)}`, fbclid: 'f'.repeat(400), fbc: 'c'.repeat(400), utm: { utm_source: 's'.repeat(250), utm_campaign: 'c'.repeat(250), utm_term: 't'.repeat(250) } } }) }, deps());
      expect(r.status).toBe(200);
      const pair = r.setCookie!.split('; ')[0]!;
      expect(pair.length).toBeLessThanOrEqual(MAX_COOKIE_BYTES);
      cookieHeader = pair;
    }
    expect(openTouches(parseCookies(cookieHeader)[name], SECRET).length).toBeGreaterThan(0);
  });

  it('a single oversized click is answered with an error, and the old cookie is left alone', async () => {
    const r = await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: at(0), gclid: 'g'.repeat(512), gbraid: 'b'.repeat(512), wbraid: 'w'.repeat(512), fbclid: 'f'.repeat(512), fbc: 'c'.repeat(512), ctwaClid: 't'.repeat(512) } }) }, deps());
    expect(r).toEqual({ status: 400, body: { error: 'touch_too_large' } });
    expect(r.setCookie).toBeUndefined();
  });
});

describe('the brand\'s retention period applies to clicks', () => {
  const short = (days: number) => site({ retentionDays: days });
  const cookie = (touches: CookieTouch[]) => `${cookieName(KEY)}=${sealTouches(touches, SECRET)}`;

  it('a click older than the retention period is not kept when the cookie is written', async () => {
    const cookieHeader = cookie([{ clickedAt: at(40), gclid: 'OLD' }, { clickedAt: at(5), gclid: 'RECENT' }]);
    const r = await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: at(0), gclid: 'NEW' } }), cookieHeader }, deps(short(30)));
    const kept = openTouches(parseCookies(r.setCookie!.split('; ')[0])[cookieName(KEY)], SECRET).map((t) => t.gclid);
    expect(kept).toEqual(['RECENT', 'NEW']);
  });

  it('GET does not show a click that is past retention', async () => {
    const r = await handleTouch({ ...base, method: 'GET', query: new URLSearchParams({ key: KEY }), cookieHeader: cookie([{ clickedAt: at(40), gclid: 'OLD' }, { clickedAt: at(5), gclid: 'RECENT' }]) }, deps(short(30)));
    expect((r.body.touches as CookieTouch[]).map((t) => t.gclid)).toEqual(['RECENT']);
  });

  it('a new click that is already past retention is skipped, not stored', async () => {
    const r = await handleTouch({ ...base, method: 'POST', body: touchBody({ touch: { clickedAt: at(40), gclid: 'LATE' } }) }, deps(short(30)));
    expect(r).toEqual({ status: 200, body: { status: 'skipped', reason: 'expired' } });
  });

  it('identify ignores clicks past retention from the cookie and from the browser, and does not fail the sign-up', async () => {
    const identify = vi.fn(async (_i: IdentifyInput): Promise<IdentifyResult> => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 1 }));
    const d = { findSite: async () => short(30), storeFor: () => ({ identify }), now: () => NOW, cookieSecret: SECRET };
    const res = await handleIdentify({
      body: { key: KEY, phone: '98765 43210', consent: { ads: true }, touches: [{ clickedAt: at(60), gclid: 'OLD-BROWSER' }, { clickedAt: at(2), gclid: 'NEW-BROWSER' }] },
      origin: base.origin, host: 'track.brand.com', cookieHeader: cookie([{ clickedAt: at(45), gclid: 'OLD-COOKIE' }, { clickedAt: at(3), gclid: 'NEW-COOKIE' }]),
    }, d);
    expect(res.status).toBe(200);
    expect(identify.mock.calls[0]![0].touches?.map((t) => t.gclid)).toEqual(['NEW-COOKIE', 'NEW-BROWSER']);
  });

  it('a click exactly at the edge is still kept', async () => {
    const r = await handleTouch({ ...base, method: 'GET', query: new URLSearchParams({ key: KEY }), cookieHeader: cookie([{ clickedAt: at(30), gclid: 'EDGE' }]) }, deps(short(30)));
    expect((r.body.touches as CookieTouch[]).map((t) => t.gclid)).toEqual(['EDGE']);
  });
});
