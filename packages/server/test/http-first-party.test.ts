import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IdentifyInput, IdentifyResult } from '@datahash/store';
import { createHttpServer, type SiteLookup } from '../src';

const KEY = 'pk_bbbbbbbbbbbbbbbbbbbbbbbb';
const ORIGIN = 'https://www.brand.com';

describe('the first-party cookie over real HTTP (cookies carried by hand, as a browser would)', () => {
  let server: ReturnType<typeof createHttpServer>;
  let base = '';
  let port = 0;
  const identify = vi.fn(async (_i: IdentifyInput): Promise<IdentifyResult> => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 1 }));

  beforeAll(async () => {
    const site = (host: string): SiteLookup => ({ tenantId: 'brand', origins: [ORIGIN], consentMode: 'opt_in', retentionDays: 90, defaultCountry: 'IN', trackingHost: host });
    server = createHttpServer({
      findSite: async (k) => (k === KEY ? site(`track.brand.localhost:${port}`) : null),
      storeFor: () => ({ identify }),
      cookieSecret: 'secret',
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  // The Host header decides whether this is the brand's tracking address. fetch() ignores a custom Host header, so
  // use http.request, which lets the test pose as a browser talking to track.brand.localhost.
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; host?: string; origin?: string } = {}) =>
    new Promise<{ status: number; headers: Headers; json: () => Promise<unknown> }>((resolve, reject) => {
      const payload = init.body ? JSON.stringify(init.body) : undefined;
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'POST',
          headers: {
            'content-type': 'text/plain',
            origin: init.origin ?? ORIGIN,
            host: init.host ?? `track.brand.localhost:${port}`,
            ...(init.cookie ? { cookie: init.cookie } : {}),
            ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
              else if (v !== undefined) headers.set(k, v);
            }
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, headers, json: async () => JSON.parse(text) });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  const touch = { key: KEY, consent: true, touch: { clickedAt: Date.now() - 1000, gclid: 'G-http', fbclid: 'F-http', fbc: 'fb.1.1.F-http' } };

  it('landing sets the cookie, then identify on the same address reads it back', async () => {
    const landing = await call('/touch', { body: touch });
    expect(landing.status).toBe(200);
    expect(landing.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(landing.headers.get('access-control-allow-credentials')).toBe('true');
    const setCookie = landing.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Domain=/);
    const cookie = setCookie.split(';')[0]!;

    // later, the visitor gives their phone: the browser sends no click data at all, only the cookie
    identify.mockClear();
    const res = await call('/identify', { body: { key: KEY, phone: '98765 43210', consent: { ads: true } }, cookie });
    expect(res.status).toBe(200);
    expect(identify.mock.calls[0]![0].touches).toMatchObject([{ gclid: 'G-http', fbclid: 'F-http', fbc: 'fb.1.1.F-http' }]);
  });

  it('through the shared product address there is no cookie, and nothing else changes', async () => {
    const res = await call('/touch', { body: touch, host: `collector.product.com` });
    expect(await res.json()).toEqual({ status: 'skipped', reason: 'not_first_party_host' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a page from another site gets nothing: no cookie, no CORS permission', async () => {
    const res = await call('/touch', { body: touch, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('the preflight allows credentials for the asking site, GET and POST', async () => {
    const res = await call('/touch', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('clearing sends an expired cookie', async () => {
    const res = await call('/touch', { body: { key: KEY, clear: true } });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('GET shows the cookie contents to the brand\'s own page only', async () => {
    const landing = await call('/touch', { body: touch });
    const cookie = landing.headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(`/touch?key=${KEY}`, { method: 'GET', cookie });
    expect(((await res.json()) as { touches: Array<{ gclid: string }> }).touches[0]?.gclid).toBe('G-http');
    expect((await call(`/touch?key=${KEY}`, { method: 'GET', cookie, origin: 'https://evil.example' })).status).toBe(403);
  });
});
