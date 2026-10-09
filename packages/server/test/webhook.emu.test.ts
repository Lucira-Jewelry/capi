import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ZOHO_MAPPING, processSale } from '@datahash/ingest';
import { createFirestore, SalesRepo, saleKey, Store, TenantRegistry } from '@datahash/store';
import { createHttpServer } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

describe.skipIf(!emulator)('CRM webhooks over HTTP -> Firestore (multi-brand)', () => {
  const registry = emulator ? new TenantRegistry(db, { cacheMs: 0 }) : (null as never);
  let base = '';
  let server: ReturnType<typeof createHttpServer>;
  let a: { tenantId: string; secret: string };
  let b: { tenantId: string; secret: string };

  const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    // Brand A uses the default Zoho field names; brand B has its own custom ones and a different consent policy.
    const ca = await registry.createTenant({ name: 'Brand A', zoho: DEFAULT_ZOHO_MAPPING });
    const cb = await registry.createTenant({
      name: 'Brand B',
      consentMode: 'opt_out',
      destinations: ['meta'],
      allowedChannels: ['store', 'online'],
      zoho: {
        dealId: 'Deal_Id',
        amount: 'Total',
        occurredAt: 'Sold_On',
        phone: 'Customer_Phone',
        channel: 'Source',
        storeChannelValues: ['showroom'],
        onlineChannelValues: ['web'],
        currency: 'USD',
      },
    });
    a = { tenantId: ca.tenant.tenantId, secret: ca.webhookSecret };
    b = { tenantId: cb.tenant.tenantId, secret: cb.webhookSecret };

    server = createHttpServer({
      findSite: async () => null,
      storeFor: () => {
        throw new Error('not used');
      },
      webhook: {
        getTenant: async (id) => {
          const t = await registry.getTenant(id);
          return t && t.status === 'active' ? t : null;
        },
        verifySecret: (id, secret) => registry.verifyWebhookSecret(id, secret),
        process: (tenant, sale) =>
          processSale(sale, tenant, {
            store: new Store(db, { tenantId: tenant.tenantId }),
            sales: new SalesRepo(db, { tenantId: tenant.tenantId }),
          }),
        log: (tenant, source, payload, outcome) =>
          new SalesRepo(db, { tenantId: tenant.tenantId }).logIngest({ source, payload, outcome }),
      },
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db.terminate();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const dealA = (over: Record<string, unknown> = {}) => ({
    id: 'Z-1001',
    Stage: 'Closed Won',
    Amount: '85000',
    Closing_Date: yesterday(),
    Sale_Channel: 'In-Store',
    Store: 'Main Showroom',
    Ad_Consent: 'Yes',
    Contact_Name: { Mobile: '98765 43210' },
    ...over,
  });

  it('brand A: stores the sale and a delivery per destination, using the click found from the phone number', async () => {
    const store = new Store(db, { tenantId: a.tenantId });
    const sales = new SalesRepo(db, { tenantId: a.tenantId });
    await store.identify({
      phone: '9876543210',
      consent: { ads: true },
      touches: [{ clickedAt: new Date(Date.now() - 5 * 86_400_000), gclid: 'G-web' }],
    });

    const res = await post(`/webhooks/${a.tenantId}/zoho`, dealA(), { 'x-webhook-secret': a.secret });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ status: string; saleKey: string }> };
    expect(json.results[0]?.status).toBe('recorded');

    const key = saleKey('zoho', 'Z-1001');
    expect(json.results[0]?.saleKey).toBe(key);
    expect(await sales.getSale(key)).toMatchObject({ eventId: 'Z-1001', channel: 'store', value: 85000, storeName: 'Main Showroom' });

    const deliveries = await sales.getDeliveries(key);
    expect(deliveries.map((d) => `${d.destination}:${d.status}`).sort()).toEqual(['google_ads:pending', 'meta:pending']);
    expect(deliveries.find((d) => d.destination === 'google_ads')?.touchId).toBeTruthy();
  });

  it('a repeat of the same deal (retry or the daily sync) is a duplicate', async () => {
    const res = await post(`/webhooks/${a.tenantId}/zoho?secret=${a.secret}`, dealA());
    expect(((await res.json()) as { results: Array<{ status: string }> }).results[0]?.status).toBe('duplicate');
  });

  it('brand B: its own field names, currency, consent policy and destinations all apply', async () => {
    const sales = new SalesRepo(db, { tenantId: b.tenantId });
    const res = await post(
      `/webhooks/${b.tenantId}/zoho`,
      { Deal_Id: 'B-1', Total: '$1,200.50', Sold_On: yesterday(), Customer_Phone: '+1 415 555 2671', Source: 'Showroom' },
      { 'x-webhook-secret': b.secret },
    );
    expect(res.status).toBe(200);

    const key = saleKey('zoho', 'B-1');
    expect(await sales.getSale(key)).toMatchObject({ value: 1200.5, currency: 'USD', channel: 'store' });
    // opt_out brand with no consent info: reported. Only Meta is enabled for this brand.
    expect((await sales.getDeliveries(key)).map((d) => `${d.destination}:${d.status}`)).toEqual(['meta:pending']);

    // Brand B also reports online sales; brand A would skip this.
    await post(
      `/webhooks/${b.tenantId}/zoho`,
      { Deal_Id: 'B-2', Total: '50', Sold_On: yesterday(), Customer_Phone: '+1 415 555 2671', Source: 'Web' },
      { 'x-webhook-secret': b.secret },
    );
    expect((await sales.getDeliveries(saleKey('zoho', 'B-2')))[0]?.status).toBe('pending');
  });

  it("one brand's secret does not open another brand's endpoint", async () => {
    expect((await post(`/webhooks/${b.tenantId}/zoho?secret=${a.secret}`, dealA())).status).toBe(401);
    expect((await post(`/webhooks/${a.tenantId}/zoho?secret=wrong`, dealA())).status).toBe(401);
    expect((await post(`/webhooks/${a.tenantId}/zoho`, dealA())).status).toBe(401);
    expect((await post(`/webhooks/nobody/zoho?secret=x`, dealA())).status).toBe(401);
  });

  it("brand A's data never shows up under brand B", async () => {
    const aSales = new SalesRepo(db, { tenantId: a.tenantId });
    const bSales = new SalesRepo(db, { tenantId: b.tenantId });
    const key = saleKey('zoho', 'Z-1001');
    expect(await aSales.getSale(key)).not.toBeNull();
    expect(await bSales.getSale(key)).toBeNull();
  });

  it('accepts a form-encoded Zoho post and skips an online order with the reason recorded', async () => {
    const form = new URLSearchParams({
      id: 'Z-1002',
      Stage: 'Closed Won',
      Amount: '5000',
      Closing_Date: yesterday(),
      Sale_Channel: 'Website',
      Ad_Consent: 'Yes',
      'Contact_Name.Mobile': '9000011111',
    });
    const res = await fetch(`${base}/webhooks/${a.tenantId}/zoho?secret=${a.secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    const deliveries = await new SalesRepo(db, { tenantId: a.tenantId }).getDeliveries(saleKey('zoho', 'Z-1002'));
    expect(deliveries.every((d) => d.status === 'skipped' && d.skipReason === 'channel_filtered')).toBe(true);
  });

  it('a suspended brand is refused', async () => {
    await registry.update(b.tenantId, { status: 'suspended' });
    expect((await post(`/webhooks/${b.tenantId}/zoho?secret=${b.secret}`, { Deal_Id: 'B-3' })).status).toBe(401);
    await registry.update(b.tenantId, { status: 'active' });
  });

  it('keeps a redacted trace in the ingest log', async () => {
    const snap = await db.collection('tenants').doc(a.tenantId).collection('ingest_log').get();
    expect(snap.size).toBeGreaterThan(0);
    const all = snap.docs.map((d) => d.data().payload as string).join('\n');
    expect(all).not.toContain('98765 43210');
    expect(all).not.toContain('9000011111');
    expect(all).toContain('[redacted]');
  });
});
