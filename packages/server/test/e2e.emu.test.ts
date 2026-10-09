// @vitest-environment jsdom
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFirestore, Store, TenantRegistry } from '@datahash/store';
import { createTracker } from '../../tracker/src/tracker';
import { createHttpServer } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

describe.skipIf(!emulator)('browser tracker -> collector -> Firestore (multi-brand)', () => {
  const registry = emulator ? new TenantRegistry(db, { cacheMs: 0 }) : (null as never);
  let base = '';
  let server: ReturnType<typeof createHttpServer>;
  let brandA: { tenantId: string; siteKey: string };
  let brandB: { tenantId: string; siteKey: string };

  beforeAll(async () => {
    const a = await registry.createTenant({ name: 'Brand A' });
    const b = await registry.createTenant({ name: 'Brand B' });
    brandA = { tenantId: a.tenant.tenantId, siteKey: a.siteKey };
    brandB = { tenantId: b.tenant.tenantId, siteKey: b.siteKey };

    server = createHttpServer({
      findSite: async (key) => {
        const f = await registry.findSite(key);
        return f
          ? {
              tenantId: f.tenant.tenantId,
              origins: f.site.origins,
              consentMode: f.tenant.consentPolicy.mode,
              retentionDays: f.tenant.retentionDays,
              defaultCountry: f.tenant.defaultCountry,
            }
          : null;
      },
      storeFor: (site) => new Store(db, { tenantId: site.tenantId, retentionDays: site.retentionDays }),
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db.terminate();
  });

  function visitor(siteKey: string, search: string) {
    // Each brand's site is its own domain in real life; jsdom has one origin, so reset the browser between visitors.
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = `dh_t_${siteKey.replace(/[^A-Za-z0-9_]/g, '_')}=;path=/;max-age=0`;
    window.history.pushState({}, '', `/rings${search}`);
    return createTracker({
      key: siteKey,
      endpoint: base,
      consentMode: 'opt_in',
      getConsent: () => 'unknown',
      autoBind: false,
      fetchImpl: globalThis.fetch,
    });
  }

  it('a visitor clicks an ad, accepts cookies, submits an enquiry; the person and click are stored', async () => {
    const tracker = visitor(brandA.siteKey, '?gclid=G-e2e&fbclid=F-e2e&utm_source=google');
    const store = new Store(db, { tenantId: brandA.tenantId });

    // Before consent: nothing leaves the browser and nothing is stored.
    expect(await tracker.identify({ phone: '98765 43210' })).toEqual({ sent: false, reason: 'no_consent' });
    expect(await store.findPerson({ phone: '9876543210' })).toBeNull();

    tracker.setConsent(true);
    expect(await tracker.identify({ phone: '98765 43210', email: 'Priya@Example.com' })).toEqual({ sent: true });

    const found = await store.lookupForSale({ phone: '+919876543210' });
    expect(found?.person.consent?.ads).toBe(true);
    expect(found?.touches).toHaveLength(1);
    expect(found?.touches[0]).toMatchObject({ gclid: 'G-e2e', fbclid: 'F-e2e' });
    expect(found?.touches[0]?.fbc).toMatch(/^fb\.1\.\d+\.F-e2e$/);
    expect((await store.findPerson({ email: 'priya@example.com' }))?.id).toBe(found?.person.id);
  });

  it('withdrawing consent in the browser clears it there and stops the server using the customer', async () => {
    const tracker = visitor(brandA.siteKey, '?gclid=G-withdraw');
    const store = new Store(db, { tenantId: brandA.tenantId });
    tracker.setConsent(true);
    expect(await tracker.identify({ phone: '90000 12345', email: 'leaving@example.com' })).toEqual({ sent: true });
    expect((await store.findPerson({ phone: '9000012345' }))?.consent?.ads).toBe(true);

    // The visitor changes their mind on the cookie banner.
    expect(await tracker.withdraw()).toEqual({ notified: true });
    expect(localStorage.getItem(`dh_touches:${brandA.siteKey}`)).toBeNull();
    expect(tracker.touches()).toEqual([]);
    expect((await store.findPerson({ email: 'leaving@example.com' }))?.consent?.ads).toBe(false);
    const { identityKeyForEmail, identityKeyForPhone } = await import('@datahash/core');
    expect(await store.isSuppressed([identityKeyForPhone('9000012345')!, identityKeyForEmail('leaving@example.com')!])).toBe(true);
  });

  it('brands are isolated: the same phone number in another brand is a different, unrelated record', async () => {
    const trackerB = visitor(brandB.siteKey, '?gclid=G-brandB');
    trackerB.setConsent(true);
    expect(await trackerB.identify({ phone: '98765 43210' })).toEqual({ sent: true });

    const a = await new Store(db, { tenantId: brandA.tenantId }).lookupForSale({ phone: '9876543210' });
    const b = await new Store(db, { tenantId: brandB.tenantId }).lookupForSale({ phone: '9876543210' });
    expect(a?.person.id).not.toBe(b?.person.id);
    expect(a?.touches.map((t) => t.gclid)).toEqual(['G-e2e']);
    expect(b?.touches.map((t) => t.gclid)).toEqual(['G-brandB']);
  });

  it('rejects an unknown or malformed site key, and a suspended brand', async () => {
    const post = (key: string) =>
      fetch(`${base}/identify`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ key, phone: '9876543210', consent: { ads: true } }),
      });
    expect((await post('nope')).status).toBe(401);
    expect((await post('pk_000000000000000000000000')).status).toBe(401);

    await registry.update(brandB.tenantId, { status: 'suspended' });
    expect((await post(brandB.siteKey)).status).toBe(401);
    await registry.update(brandB.tenantId, { status: 'active' });
    expect((await post(brandB.siteKey)).status).toBe(200);
  });

  it('answers the health check', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });
});
