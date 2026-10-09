import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clientIp, createHttpServer, FailureLimiter, type AdminDeps } from '../src';

describe('FailureLimiter', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('allows a few wrong tokens, then locks that address out', () => {
    const c = clock();
    const l = new FailureLimiter({ now: c.now });
    for (let i = 0; i < 9; i++) {
      expect(l.fail('a')).toBe(false);
      expect(l.retryAfterSec('a')).toBe(0);
    }
    expect(l.fail('a')).toBe(true); // the tenth
    expect(l.retryAfterSec('a')).toBe(15 * 60);
    c.advance(5 * 60_000);
    expect(l.retryAfterSec('a')).toBe(10 * 60);
  });

  it('other addresses are not affected', () => {
    const l = new FailureLimiter({ maxFailures: 2 });
    l.fail('a');
    l.fail('a');
    expect(l.retryAfterSec('a')).toBeGreaterThan(0);
    expect(l.retryAfterSec('b')).toBe(0);
  });

  it('the lock ends by itself and the count starts again', () => {
    const c = clock();
    const l = new FailureLimiter({ maxFailures: 3, now: c.now });
    for (let i = 0; i < 3; i++) l.fail('a');
    c.advance(15 * 60_000 + 1000);
    expect(l.retryAfterSec('a')).toBe(0);
    expect(l.fail('a')).toBe(false); // one failure, not three
  });

  it('old failures are forgotten once the window has passed', () => {
    const c = clock();
    const l = new FailureLimiter({ maxFailures: 3, now: c.now });
    l.fail('a');
    l.fail('a');
    c.advance(16 * 60_000);
    expect(l.fail('a')).toBe(false);
    expect(l.retryAfterSec('a')).toBe(0);
  });

  it('a right token clears the count', () => {
    const l = new FailureLimiter({ maxFailures: 3 });
    l.fail('a');
    l.fail('a');
    l.succeed('a');
    l.fail('a');
    l.fail('a');
    expect(l.retryAfterSec('a')).toBe(0);
  });

  it('memory stays bounded however many addresses fail', () => {
    const l = new FailureLimiter({ maxEntries: 50, maxFailures: 1 });
    for (let i = 0; i < 500; i++) l.fail(`ip-${i}`);
    const size = (l as unknown as { entries: Map<string, unknown> }).entries.size;
    expect(size).toBeLessThanOrEqual(50);
    expect(l.retryAfterSec('ip-499')).toBeGreaterThan(0); // the newest are kept
  });
});

describe('clientIp', () => {
  const req = (xff: string | undefined, remote = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as never;

  it('without a proxy header it is the connection\'s own address', () => {
    expect(clientIp(req(undefined, '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('behind one proxy it is the last entry, which the proxy wrote', () => {
    expect(clientIp(req('198.51.100.7'))).toBe('198.51.100.7');
  });

  it('entries the client wrote in front of it cannot be used to pretend to be someone else', () => {
    expect(clientIp(req('1.1.1.1, 2.2.2.2, 198.51.100.7'))).toBe('198.51.100.7');
  });

  it('behind two proxies it counts back two', () => {
    expect(clientIp(req('9.9.9.9, 198.51.100.7, 35.191.0.1'), 2)).toBe('198.51.100.7');
  });

  it('falls back to the connection if there are fewer entries than proxies', () => {
    expect(clientIp(req('198.51.100.7'), 2, )).toBe('10.0.0.1');
  });
});

describe('login guessing over HTTP', () => {
  let server: ReturnType<typeof createHttpServer> | undefined;
  afterEach(() => new Promise((r) => (server ? server.close(r) : r(undefined))));

  async function start(limiter = new FailureLimiter()) {
    server = createHttpServer({
      findSite: async () => null,
      storeFor: () => ({ identify: async () => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 0 }) }),
      admin: { adminToken: 'right-token' } as AdminDeps, // /me is answered before anything else is needed
      internal: { token: 'internal-token', dispatchAll: async () => ({}) },
      limiter,
      adminUiDir: new URL('../../admin-ui/static', import.meta.url).pathname,
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      me: (token: string, ip = '198.51.100.1') => fetch(`${base}/admin/api/me`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip } }),
      dispatch: (token: string, ip = '198.51.100.1') => fetch(`${base}/internal/dispatch`, { method: 'POST', headers: { 'x-internal-token': token, 'x-forwarded-for': ip } }),
      get: (path: string, ip = '198.51.100.1') => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } }),
    };
  }

  it('ten wrong tokens lock the address, and then even the right token is refused for a while', async () => {
    const s = await start();
    for (let i = 0; i < 10; i++) expect((await s.me('wrong')).status).toBe(401);
    const locked = await s.me('right-token');
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe(String(15 * 60));
    expect(await locked.json()).toMatchObject({ error: 'too_many_attempts', message: expect.stringContaining('15 minutes') });
  });

  it('someone else on another address is unaffected, and so is the console page and the health check', async () => {
    const s = await start();
    for (let i = 0; i < 10; i++) await s.me('wrong', '198.51.100.1');
    expect((await s.me('right-token', '203.0.113.50')).status).toBe(200);
    expect((await s.get('/admin/', '198.51.100.1')).status).toBe(200);
    expect((await s.get('/health', '198.51.100.1')).status).toBe(200);
  });

  it('a right token clears earlier wrong ones, so normal typos never add up', async () => {
    const s = await start();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 6; i++) expect((await s.me('wrong')).status).toBe(401);
      expect((await s.me('right-token')).status).toBe(200);
    }
  });

  it('pretending to be another address in the header does not dodge the lock', async () => {
    const s = await start();
    for (let i = 0; i < 10; i++) await s.me('wrong', '1.1.1.1, 198.51.100.1');
    expect((await s.me('wrong', '9.9.9.9, 198.51.100.1')).status).toBe(429);
  });

  it('the scheduler endpoint is protected the same way, separately from the console', async () => {
    const s = await start();
    for (let i = 0; i < 10; i++) expect((await s.dispatch('wrong')).status).toBe(401);
    expect((await s.dispatch('internal-token')).status).toBe(429);
    expect((await s.me('right-token')).status).toBe(200); // the console is a different counter
  });

  it('the lock ends after its time', async () => {
    let t = 1_000_000;
    const s = await start(new FailureLimiter({ now: () => t }));
    for (let i = 0; i < 10; i++) await s.me('wrong');
    expect((await s.me('right-token')).status).toBe(429);
    t += 16 * 60_000;
    expect((await s.me('right-token')).status).toBe(200);
  });
});

import { RateLimiter, KeyedCache } from '../src';

describe('RateLimiter', () => {
  it('allows the budget, then says when to come back, then starts over', () => {
    let t = 0;
    const l = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([0, 0, 0]);
    expect(l.take('a')).toBe(60);
    t = 45_000;
    expect(l.take('a')).toBe(15);
    expect(l.take('b')).toBe(0); // someone else
    t = 60_000;
    expect(l.take('a')).toBe(0); // a new window
  });

  it('memory stays bounded', () => {
    const l = new RateLimiter({ limit: 1, maxEntries: 40 });
    for (let i = 0; i < 400; i++) l.take(`ip-${i}`);
    expect((l as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(40);
  });
});

describe('public endpoints are throttled per address', () => {
  let server: ReturnType<typeof createHttpServer> | undefined;
  afterEach(() => new Promise((r) => (server ? server.close(r) : r(undefined))));

  async function start(publicLimits: { browserPerMin?: number; webhookPerMin?: number }) {
    server = createHttpServer({
      findSite: async () => null,
      storeFor: () => ({ identify: async () => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 0 }) }),
      webhook: {
        getTenant: async (id) => (id === 'brand' ? ({ tenantId: 'brand', sources: {}, status: 'active' } as never) : null),
        verifySecret: async (_id, secret) => secret === 'good',
        process: async () => { throw new Error('not used'); },
        log: async () => {},
      },
      publicLimits,
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    return {
      trackcheck: (ip = '198.51.100.1') => fetch(`${base}/trackcheck?key=pk_x`, { headers: from(ip) }),
      identify: (ip = '198.51.100.1') => fetch(`${base}/identify`, { method: 'POST', headers: from(ip), body: '{}' }),
      hook: (secret: string, ip = '198.51.100.1') => fetch(`${base}/webhooks/brand/zoho`, { method: 'POST', headers: { ...from(ip), 'x-webhook-secret': secret }, body: '{}' }),
      get: (path: string, ip = '198.51.100.1') => fetch(`${base}${path}`, { headers: from(ip) }),
    };
  }

  it('the website script endpoints share a budget per address, and say when to retry', async () => {
    const s = await start({ browserPerMin: 5 });
    for (let i = 0; i < 3; i++) expect((await s.trackcheck()).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await s.identify()).status).not.toBe(429);
    const over = await s.identify();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await over.json()).toEqual({ error: 'rate_limited' });
    expect((await s.trackcheck()).status).toBe(429); // same budget
  });

  it('another address, the health check and the script file are not affected', async () => {
    const s = await start({ browserPerMin: 2 });
    for (let i = 0; i < 4; i++) await s.trackcheck();
    expect((await s.trackcheck('203.0.113.77')).status).toBe(200);
    expect((await s.get('/health')).status).toBe(200);
  });

  it('webhooks have their own, larger budget', async () => {
    const s = await start({ browserPerMin: 1, webhookPerMin: 4 });
    for (let i = 0; i < 4; i++) expect((await s.hook('good')).status).toBe(404); // zoho not configured: past the login, so counted
    expect((await s.hook('good')).status).toBe(429);
    expect((await s.hook('good', '203.0.113.5')).status).toBe(404);
  });

  it('an address that keeps sending wrong secrets is paused, even for the right one, then a right secret clears the count', async () => {
    const s = await start({});
    for (let i = 0; i < 29; i++) expect((await s.hook('wrong')).status).toBe(401);
    expect((await s.hook('good')).status).toBe(404); // a right one clears the count
    for (let i = 0; i < 30; i++) expect((await s.hook('wrong')).status).toBe(401);
    const locked = await s.hook('good');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(300);
    expect((await s.hook('good', '203.0.113.9')).status).toBe(404); // other addresses unaffected
  });
});

describe('KeyedCache', () => {
  it('reuses an object for the same brand and retention, and makes a new one when the retention changes', () => {
    let made = 0;
    const cache = new KeyedCache((tenantId, days) => ({ tenantId, days, n: ++made }));
    const a = cache.get('b', 90);
    expect(cache.get('b', 90)).toBe(a);
    const b = cache.get('b', 30); // retention changed in the console
    expect(b).not.toBe(a);
    expect(b.days).toBe(30);
    expect(cache.get('b', 30)).toBe(b);
    expect(cache.get('other', 90)).not.toBe(a);
    expect(made).toBe(3);
  });

  it('does not hand a brand the object that was made without a retention (the old bug)', () => {
    const cache = new KeyedCache((tenantId, days) => ({ tenantId, days }));
    const early = cache.get('b'); // e.g. made by a path that does not know the retention
    const later = cache.get('b', 30);
    expect(later).not.toBe(early);
    expect(later.days).toBe(30);
  });
});
