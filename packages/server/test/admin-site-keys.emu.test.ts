import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCsv } from './import-helper';
import { processSale } from '@datahash/ingest';
import { previewPayload } from '@datahash/senders';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store, TenantRegistry } from '@datahash/store';
import { handleAdmin, type AdminDeps } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

afterAll(async () => {
  if (emulator) await db.terminate();
});

type View = { tenant: { tenantId: string }; siteKeys: Array<{ key: string; trackingHost?: string; snippet: string; gtmSnippet: string; dns?: { type: string; name: string; short: string; target: string; local: boolean; ready: boolean } }> };

describe.skipIf(!emulator)('admin: tracking address and payload preview (Firestore emulator)', () => {
  const registry = emulator ? new TenantRegistry(db, { cacheMs: 0 }) : (null as never);
  const box = new SecretBox(SecretBox.generateKey());
  let deps: AdminDeps;

  beforeAll(() => {
    const storeOf = (id: string) => new Store(db, { tenantId: id });
    const salesOf = (id: string) => new SalesRepo(db, { tenantId: id });
    deps = {
      adminToken: 'tok',
      registry,
      connectionsFor: (id) => new ConnectionsRepo(db, box, id),
      salesFor: salesOf,
      processFor: (tenant, sale) => processSale(sale, tenant, { store: storeOf(tenant.tenantId), sales: salesOf(tenant.tenantId) }),
      dispatchFor: async () => { throw new Error('not used'); },
      checkGoogleFor: async () => ({ ok: true, message: 'ok' }),
      withdrawFor: async () => ({ keys: 0, personFound: false }),
      previewFor: async (tenantId, saleKey, destination) => {
        const sale = await salesOf(tenantId).getSale(saleKey);
        const delivery = (await salesOf(tenantId).getDeliveries(saleKey)).find((d) => d.destination === destination);
        if (!sale || !delivery) return null;
        const touch = delivery.touchId && sale.personId ? await storeOf(tenantId).getTouch(sale.personId, delivery.touchId) : null;
        const conn = await new ConnectionsRepo(db, box, tenantId).getWithSecret(destination).catch(() => null);
        return previewPayload(destination, { saleKey, sale, touch }, conn?.settings ?? null);
      },
      publicUrl: 'https://collector.product.com',
    };
  });

  const call = (method: string, path: string, body?: unknown) => handleAdmin({ method, path, query: new URLSearchParams(), body, token: 'tok' }, deps);
  const host = () => `track-${Math.random().toString(36).slice(2, 10)}.brand.com`;

  it('a brand with its own tracking address gets a script tag that uses it, and the DNS record to add', async () => {
    const h = host();
    const created = (await call('POST', '/tenants', { name: 'Own Host', origins: ['https://www.brand.com'], trackingHost: h })).body as View;
    const key = created.siteKeys[0]!;
    expect(key.trackingHost).toBe(h);
    expect(key.snippet).toBe(`<script src="https://${h}/tracker.js" data-key="${key.key}" data-endpoint="https://${h}" async></script>`);
    // The Tag Manager loader follows the brand's own tracking address and leaves consent at the default (opt-in).
    expect(key.gtmSnippet).toContain(`s.setAttribute('data-endpoint', 'https://${h}');`);
    expect(key.gtmSnippet).toContain(`s.src = 'https://${h}/tracker.js';`);
    expect(key.gtmSnippet).not.toContain('data-consent-mode');
    expect(key.dns).toEqual({ type: 'CNAME', name: h, short: h.split('.')[0], target: 'collector.product.com', local: false, ready: true });
  });

  it('without one, the shared address is used and there is no DNS step', async () => {
    const created = (await call('POST', '/tenants', { name: 'Shared Host' })).body as View;
    expect(created.siteKeys[0]?.snippet).toContain('src="https://collector.product.com/tracker.js"');
    expect(created.siteKeys[0]?.dns).toBeUndefined();
  });

  it('a local test address uses http and keeps its port in the tag but not in the DNS name', async () => {
    const local = `track-${Math.random().toString(36).slice(2, 10)}.brand.localhost`;
    const created = (await call('POST', '/tenants', { name: 'Local', trackingHost: `${local}:8787` })).body as View;
    const key = created.siteKeys[0]!;
    expect(key.snippet).toContain(`src="http://${local}:8787/tracker.js"`);
    expect(key.snippet).toContain(`data-endpoint="http://${local}:8787"`);
    expect(key.dns?.name).toBe(local);
  });

  it('can be set, changed and removed on an existing site key, and bad or taken addresses are explained', async () => {
    const created = (await call('POST', '/tenants', { name: 'Edit Host', origins: ['https://www.brand.com'] })).body as View;
    const id = created.tenant.tenantId;
    const key = created.siteKeys[0]!.key;
    const h = host();

    const set = (await call('PATCH', `/tenants/${id}/site-keys/${key}`, { trackingHost: h })).body as View;
    expect(set.siteKeys.find((s) => s.key === key)?.trackingHost).toBe(h);

    const other = (await call('POST', '/tenants', { name: 'Other Host' })).body as View;
    expect(await call('PATCH', `/tenants/${other.tenant.tenantId}/site-keys/${other.siteKeys[0]!.key}`, { trackingHost: h })).toMatchObject({ status: 409, body: { error: 'tracking_host_taken' } });
    expect(await call('PATCH', `/tenants/${id}/site-keys/${key}`, { trackingHost: 'https://nope.com' })).toMatchObject({ status: 400, body: { error: 'invalid_tracking_host' } });
    expect(await call('PATCH', `/tenants/${id}/site-keys/pk_000000000000000000000000`, { label: 'x' })).toMatchObject({ status: 404, body: { error: 'unknown_site_key' } });
    expect(await call('PATCH', `/tenants/${other.tenant.tenantId}/site-keys/${key}`, { label: 'hijack' })).toMatchObject({ status: 404 }); // not that brand's key

    const removed = (await call('PATCH', `/tenants/${id}/site-keys/${key}`, { trackingHost: '' })).body as View;
    expect(removed.siteKeys.find((s) => s.key === key)?.trackingHost).toBeUndefined();
    expect(removed.siteKeys.find((s) => s.key === key)?.snippet).toContain('collector.product.com');
  });

  it('a new site key can be created with its own address', async () => {
    const created = (await call('POST', '/tenants', { name: 'Second Key' })).body as View;
    const id = created.tenant.tenantId;
    const h = host();
    expect(await call('POST', `/tenants/${id}/site-keys`, { origins: ['https://shop.brand.com'], trackingHost: h })).toMatchObject({ status: 201 });
    const view = (await call('GET', `/tenants/${id}`)).body as View;
    expect(view.siteKeys.some((s) => s.trackingHost === h)).toBe(true);
    expect(await call('POST', `/tenants/${id}/site-keys`, { origins: [], trackingHost: 'bad host' })).toMatchObject({ status: 400 });
  });

  it('"Check setup" runs for a site key that has a tracking address, and is refused otherwise', async () => {
    const h = host();
    const created = (await call('POST', '/tenants', { name: 'Check Setup', origins: ['https://www.brand.com'], trackingHost: h })).body as View;
    const id = created.tenant.tenantId;
    const key = created.siteKeys[0]!.key;
    const fakeDeps = {
      resolveCname: async () => ['collector.product.com'],
      lookupAddresses: async () => ['203.0.113.7'],
      request: async (url: string) => ({
        status: 200,
        headers: {} as Record<string, string>,
        body: url.includes('/trackcheck') ? JSON.stringify({ ok: true, siteKnown: true, hostMatches: false }) : '',
      }),
    };
    const local: AdminDeps = { ...deps, trackingCheckDeps: fakeDeps };
    const res = await handleAdmin({ method: 'POST', path: `/tenants/${id}/site-keys/${key}/check`, query: new URLSearchParams(), body: {}, token: 'tok' }, local);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; checks: Array<{ id: string; status: string }> };
    expect(body.ok).toBe(false);
    expect(body.checks.find((c) => c.id === 'dns')?.status).toBe('pass');
    expect(body.checks.find((c) => c.id === 'https')?.status).toBe('fail');

    const noHost = (await call('POST', '/tenants', { name: 'No Host' })).body as View;
    expect(await call('POST', `/tenants/${noHost.tenant.tenantId}/site-keys/${noHost.siteKeys[0]!.key}/check`)).toMatchObject({ status: 400, body: { error: 'no_tracking_host' } });
    expect(await call('POST', `/tenants/${id}/site-keys/pk_000000000000000000000000/check`)).toMatchObject({ status: 404 });
    expect(await call('POST', `/tenants/${noHost.tenant.tenantId}/site-keys/${key}/check`)).toMatchObject({ status: 404 }); // not that brand's key
  });

  it('the payload preview shows what would be sent: the credited click, fbc, hashed contact details, test mode, and no tokens', async () => {
    const created = (await call('POST', '/tenants', { name: 'Preview Co', destinations: ['meta', 'google_ads'] })).body as View;
    const id = created.tenant.tenantId;
    await new ConnectionsRepo(db, box, id).set('meta', { datasetId: '999', testEventCode: 'TEST123' }, 'SECRET-META-TOKEN');
    await new ConnectionsRepo(db, box, id).set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' });

    const clickedAt = new Date(Date.now() - 5 * 86_400_000);
    await new Store(db, { tenantId: id }).identify({
      phone: '98765 43210', email: 'priya@example.com', consent: { ads: true },
      touches: [{ clickedAt, gclid: 'G-preview', fbclid: 'F-preview', fbc: `fb.1.${clickedAt.getTime()}.F-preview` }],
    });
    const today = new Date().toISOString().slice(0, 10);
    await importCsv(call, id, `eventId,channel,occurredAt,value,phone,consent\nP1,store,${today},85000,9876543210,yes`);
    const sales = (await call('GET', `/tenants/${id}/sales`)).body as { sales: Array<{ saleKey: string }> };
    const key = sales.sales[0]!.saleKey;

    const meta = (await call('GET', `/tenants/${id}/sales/${key}/deliveries/meta/preview`)).body as { url: string; body: { data: Array<{ event_id: string; action_source: string; user_data: Record<string, unknown> }>; test_event_code?: string }; notes: string[] };
    expect(meta.url).toBe('https://graph.facebook.com/v21.0/999/events');
    expect(meta.body.test_event_code).toBe('TEST123');
    expect(meta.body.data[0]).toMatchObject({ event_id: 'P1', action_source: 'physical_store' });
    expect(meta.body.data[0]!.user_data.fbc).toBe(`fb.1.${clickedAt.getTime()}.F-preview`);
    expect(meta.body.data[0]!.user_data.ph).toHaveLength(1);
    expect(meta.notes.join(' ')).toContain('fbclid F-preview');
    expect(meta.notes.join(' ')).toContain('Test mode');

    const google = (await call('GET', `/tenants/${id}/sales/${key}/deliveries/google_ads/preview`)).body as { url: string; body: { destinations: Array<{ productDestinationId: string }>; events: Array<{ adIdentifiers: { gclid: string }; transactionId: string }> } };
    expect(google.url).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(google.body.destinations[0]?.productDestinationId).toBe('77');
    expect(google.body.events[0]).toMatchObject({ transactionId: 'P1', adIdentifiers: { gclid: 'G-preview' } });

    expect(JSON.stringify([meta, google])).not.toMatch(/SECRET-META-TOKEN|98765|priya@/); // no secret, no plain contact details

    expect(await call('GET', `/tenants/${id}/sales/${key}/deliveries/meta/preview`)).toMatchObject({ status: 200 });
    expect(await call('GET', `/tenants/${id}/sales/${'0'.repeat(32)}/deliveries/meta/preview`)).toMatchObject({ status: 404 });
  });

  it('the preview works for a brand that is not connected yet, using clearly marked placeholders', async () => {
    const created = (await call('POST', '/tenants', { name: 'Unconnected' })).body as View;
    const id = created.tenant.tenantId;
    const today = new Date().toISOString().slice(0, 10);
    await importCsv(call, id, `eventId,channel,occurredAt,phone,consent\nU1,store,${today},9876543210,yes`);
    const key = ((await call('GET', `/tenants/${id}/sales`)).body as { sales: Array<{ saleKey: string }> }).sales[0]!.saleKey;
    const meta = (await call('GET', `/tenants/${id}/sales/${key}/deliveries/meta/preview`)).body as { url: string; notes: string[] };
    expect(meta.url).toContain('<dataset id>');
    expect(meta.notes.join(' ')).toContain('not connected');
    expect(meta.notes.join(' ')).toContain('No website click is credited');
  });
});
