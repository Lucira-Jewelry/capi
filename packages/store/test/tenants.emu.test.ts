import { afterAll, describe, expect, it } from 'vitest';
import { createFirestore, TenantRegistry } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

describe.skipIf(!emulator)('TenantRegistry (Firestore emulator)', () => {
  afterAll(async () => {
    await db.terminate();
  });

  it('creates a brand with safe defaults and returns its keys', async () => {
    const reg = new TenantRegistry(db, { cacheMs: 0 });
    const { tenant, siteKey, webhookSecret } = await reg.createTenant({ name: 'Acme Jewels & Co.', origins: ['https://acme.com'] });

    expect(tenant.tenantId).toMatch(/^acme-jewels-co-[0-9a-f]{6}$/);
    expect(tenant).toMatchObject({
      status: 'active',
      consentPolicy: { mode: 'opt_in' },
      allowedChannels: ['store', 'whatsapp'], // online left out by default to avoid double counting
      destinations: ['meta', 'google_ads'],
      defaultCountry: 'IN',
      retentionDays: 90,
    });
    expect(siteKey).toMatch(/^pk_[a-f0-9]{24}$/);
    expect(webhookSecret.length).toBeGreaterThanOrEqual(30);

    const found = await reg.findSite(siteKey);
    expect(found?.tenant.tenantId).toBe(tenant.tenantId);
    expect(found?.site.origins).toEqual(['https://acme.com']);
  });

  it('stores only a hash of the webhook secret, and verifies it', async () => {
    const reg = new TenantRegistry(db, { cacheMs: 0 });
    const { tenant, webhookSecret } = await reg.createTenant({ name: 'Secret Co' });

    expect(await reg.verifyWebhookSecret(tenant.tenantId, webhookSecret)).toBe(true);
    expect(await reg.verifyWebhookSecret(tenant.tenantId, webhookSecret + 'x')).toBe(false);
    expect(await reg.verifyWebhookSecret(tenant.tenantId, undefined)).toBe(false);
    expect(await reg.verifyWebhookSecret('nobody', webhookSecret)).toBe(false);

    const raw = await db.collection('tenants').doc(tenant.tenantId).collection('private').doc('webhook').get();
    expect(JSON.stringify(raw.data())).not.toContain(webhookSecret);
  });

  it('rotating the secret invalidates the old one', async () => {
    const reg = new TenantRegistry(db, { cacheMs: 0 });
    const { tenant, webhookSecret } = await reg.createTenant({ name: 'Rotate Co' });
    const fresh = await reg.rotateWebhookSecret(tenant.tenantId);
    expect(await reg.verifyWebhookSecret(tenant.tenantId, webhookSecret)).toBe(false);
    expect(await reg.verifyWebhookSecret(tenant.tenantId, fresh)).toBe(true);
    await expect(reg.rotateWebhookSecret('nobody')).rejects.toThrow('unknown_tenant');
  });

  it('refuses a duplicate tenant ID and unknown or malformed site keys', async () => {
    const reg = new TenantRegistry(db, { cacheMs: 0 });
    await reg.createTenant({ name: 'Dup', tenantId: `dup-${Date.now()}` });
    const id = `fixed-${Date.now()}`;
    await reg.createTenant({ name: 'Fixed', tenantId: id });
    await expect(reg.createTenant({ name: 'Fixed again', tenantId: id })).rejects.toThrow('tenant_exists');
    expect(await reg.findSite('pk_000000000000000000000000')).toBeNull();
    expect(await reg.findSite("../../x")).toBeNull();
  });

  it('saves a per-brand Zoho mapping and settings changes', async () => {
    const reg = new TenantRegistry(db, { cacheMs: 0 });
    const { tenant } = await reg.createTenant({ name: 'Mapped Co' });
    expect(tenant.sources.zoho).toBeUndefined();

    await reg.setSourceMapping(tenant.tenantId, 'zoho', {
      dealId: 'id',
      amount: 'Grand_Total',
      occurredAt: 'Closing_Date',
      phone: 'Phone',
      channel: 'Mode',
      storeChannelValues: ['counter'],
    });
    await reg.update(tenant.tenantId, { destinations: ['meta'], allowedChannels: ['store', 'online'] });

    const reloaded = await reg.getTenant(tenant.tenantId);
    expect(reloaded?.sources.zoho?.amount).toBe('Grand_Total');
    expect(reloaded?.destinations).toEqual(['meta']);
    expect(reloaded?.allowedChannels).toEqual(['store', 'online']);
  });

  it('a suspended brand disappears from site-key lookups', async () => {
    const reg = new TenantRegistry(db, { cacheMs: 0 });
    const { tenant, siteKey } = await reg.createTenant({ name: 'Pause Co' });
    await reg.update(tenant.tenantId, { status: 'suspended' });
    expect(await reg.findSite(siteKey)).toBeNull();
    await reg.update(tenant.tenantId, { status: 'active' });
    expect((await reg.findSite(siteKey))?.tenant.tenantId).toBe(tenant.tenantId);
  });

  it('caches lookups for the configured time', async () => {
    let clock = 1_000;
    const reg = new TenantRegistry(db, { cacheMs: 60_000, now: () => clock });
    const { tenant } = await reg.createTenant({ name: 'Cache Co' });
    expect((await reg.getTenant(tenant.tenantId))?.name).toBe('Cache Co');

    // Change the document behind the registry's back: the cached value is served until it expires.
    await db.collection('tenants').doc(tenant.tenantId).update({ name: 'Renamed' });
    expect((await reg.getTenant(tenant.tenantId))?.name).toBe('Cache Co');
    clock += 61_000;
    expect((await reg.getTenant(tenant.tenantId))?.name).toBe('Renamed');
  });
});
