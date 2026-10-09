import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createFirestore, TenantRegistry } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

afterAll(async () => {
  if (emulator) await db.terminate();
});

const unique = () => `track-${randomUUID().slice(0, 8)}.brand.com`;

describe.skipIf(!emulator)('site key tracking address (Firestore emulator)', () => {
  const reg = () => new TenantRegistry(db, { cacheMs: 0 });

  it('is saved with the site key, normalised, and found when the key is looked up', async () => {
    const r = reg();
    const { tenant } = await r.createTenant({ name: 'Host Co' });
    const host = unique();
    const key = await r.addSiteKey(tenant.tenantId, ['https://www.brand.com'], 'Main', host.toUpperCase());
    expect((await r.findSite(key))?.site).toMatchObject({ trackingHost: host, origins: ['https://www.brand.com'], label: 'Main' });
    expect((await r.listSiteKeys(tenant.tenantId)).find((s) => s.key === key)?.trackingHost).toBe(host);
  });

  it('can be given to the first site key when the brand is created', async () => {
    const r = reg();
    const host = unique();
    const { siteKey } = await r.createTenant({ name: 'First Host Co', trackingHost: host });
    expect((await r.findSite(siteKey))?.site.trackingHost).toBe(host);
  });

  it('rejects a bad address, and an address another site key already uses', async () => {
    const r = reg();
    const a = (await r.createTenant({ name: 'A' })).tenant.tenantId;
    const b = (await r.createTenant({ name: 'B' })).tenant.tenantId;
    const host = unique();
    await r.addSiteKey(a, [], undefined, host);
    await expect(r.addSiteKey(b, [], undefined, host)).rejects.toThrow('tracking_host_taken');
    await expect(r.addSiteKey(b, [], undefined, 'https://nope.com')).rejects.toThrow('invalid_tracking_host');
  });

  it('can be changed or removed later; a key can keep its own address when saved again', async () => {
    const r = reg();
    const id = (await r.createTenant({ name: 'Change Co' })).tenant.tenantId;
    const first = unique();
    const key = await r.addSiteKey(id, ['https://www.brand.com'], undefined, first);

    await r.updateSiteKey(id, key, { trackingHost: first }); // same value again: not "taken" by itself
    const second = unique();
    await r.updateSiteKey(id, key, { trackingHost: second, label: 'Renamed', origins: ['https://shop.brand.com'] });
    expect((await r.findSite(key))?.site).toMatchObject({ trackingHost: second, label: 'Renamed', origins: ['https://shop.brand.com'] });
    // the old address is free again
    expect(await r.addSiteKey(id, [], undefined, first)).toMatch(/^pk_/);

    await r.updateSiteKey(id, key, { trackingHost: null });
    expect((await r.findSite(key))?.site.trackingHost).toBeFalsy();
  });

  it("one brand cannot change another brand's site key", async () => {
    const r = reg();
    const a = (await r.createTenant({ name: 'Owner' })).tenant.tenantId;
    const b = (await r.createTenant({ name: 'Other' })).tenant.tenantId;
    const key = await r.addSiteKey(a, []);
    await expect(r.updateSiteKey(b, key, { label: 'hijack' })).rejects.toThrow('unknown_site_key');
    await expect(r.updateSiteKey(a, 'pk_000000000000000000000000', { label: 'x' })).rejects.toThrow('unknown_site_key');
  });
});
