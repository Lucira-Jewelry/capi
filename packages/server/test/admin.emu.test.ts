import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importCsv } from './import-helper';
import { processSale } from '@datahash/ingest';
import { dispatchDue } from '@datahash/senders';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store, TenantRegistry } from '@datahash/store';
import { handleAdmin, validateZohoMapping, type AdminDeps } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

afterAll(async () => {
  if (emulator) await db.terminate();
});

const TOKEN = 'operator-token';
const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('validateZohoMapping', () => {
  const good = { dealId: 'id', amount: 'Amount', occurredAt: 'Closing_Date', phone: 'Phone', channel: 'Mode', storeChannelValues: ['counter'] };

  it('accepts a minimal mapping and drops unknown keys', () => {
    expect(validateZohoMapping({ ...good, evil: 'x' })).toEqual(good);
  });

  it('explains what is wrong', () => {
    expect(validateZohoMapping(null)).toContain('object');
    expect(validateZohoMapping({ ...good, amount: '' })).toContain('amount');
    expect(validateZohoMapping({ ...good, storeChannelValues: [] })).toContain('storeChannelValues');
    expect(validateZohoMapping({ ...good, wonStages: 'Closed Won' })).toContain('wonStages');
    expect(validateZohoMapping({ ...good, email: 5 })).toContain('email');
  });
});

describe.skipIf(!emulator)('admin API (Firestore emulator)', () => {
  const registry = emulator ? new TenantRegistry(db, { cacheMs: 0 }) : (null as never);
  const box = new SecretBox(SecretBox.generateKey());
  let clockOffsetMs = 0;
  const now = () => new Date(Date.now() + clockOffsetMs);
  const dispatchSpy = vi.fn();
  let deps: AdminDeps;

  beforeAll(() => {
    deps = {
      adminToken: TOKEN,
      registry,
      connectionsFor: (id) => new ConnectionsRepo(db, box, id),
      salesFor: (id) => new SalesRepo(db, { tenantId: id }),
      processFor: (tenant, sale) =>
        processSale(sale, tenant, { store: new Store(db, { tenantId: tenant.tenantId }), sales: new SalesRepo(db, { tenantId: tenant.tenantId }), now }),
      dispatchFor: async (id) => {
        dispatchSpy(id);
        return dispatchDue({
          sales: new SalesRepo(db, { tenantId: id }),
          store: new Store(db, { tenantId: id }),
          connections: new ConnectionsRepo(db, box, id),
          http: { fetchImpl: (async () => json({ events_received: 1 })) as never },
          now,
        });
      },
      checkGoogleFor: async () => ({ ok: true, message: 'ok' }),
      withdrawFor: (tenant, contact) => new Store(db, { tenantId: tenant.tenantId }).withdraw({ ...contact, defaultCountry: tenant.defaultCountry }),
      publicUrl: 'https://track.example.com/',
      now,
    };
  });

  const call = (method: string, path: string, body?: unknown, token: string | undefined = TOKEN, query = '') =>
    handleAdmin({ method, path, query: new URLSearchParams(query), body, token }, deps);

  async function newBrand(extra: Record<string, unknown> = {}) {
    const res = await call('POST', '/tenants', { name: 'Test Brand', origins: ['https://www.brand.com/shop'], zoho: true, ...extra });
    expect(res.status).toBe(201);
    return res.body as {
      tenant: { tenantId: string };
      siteKey: string;
      webhookSecret: string;
      siteKeys: Array<{ key: string; origins: string[]; snippet: string }>;
      webhooks: { zoho: string; generic: string };
    };
  }

  it('needs the operator token on every call', async () => {
    const anonymous = await handleAdmin({ method: 'GET', path: '/tenants', query: new URLSearchParams(), body: undefined }, deps);
    expect(anonymous.status).toBe(401); // a missing token is refused (the helper's default token would hide this)
    expect((await call('GET', '/tenants', undefined, 'wrong')).status).toBe(401);
    expect((await call('GET', '/me')).status).toBe(200);
    const noServerToken = await handleAdmin({ method: 'GET', path: '/me', query: new URLSearchParams(), body: {}, token: '' }, { ...deps, adminToken: '' });
    expect(noServerToken.status).toBe(401); // an unset server token never lets anyone in
  });

  it('creates a brand and returns the secrets once, with ready-to-paste snippets and URLs', async () => {
    const b = await newBrand({ consentMode: 'opt_out', destinations: ['meta'] });
    expect(b.siteKey).toMatch(/^pk_/);
    expect(b.webhookSecret.length).toBeGreaterThan(30);
    expect(b.siteKeys[0]?.origins).toEqual(['https://www.brand.com']); // normalised to an origin
    expect(b.siteKeys[0]?.snippet).toBe(`<script src="https://track.example.com/tracker.js" data-key="${b.siteKey}" data-endpoint="https://track.example.com" data-consent-mode="opt_out" async></script>`); // this brand is opt-out
    // The Tag Manager loader is built from the same settings.
    const gtm = (b.siteKeys[0] as unknown as { gtmSnippet: string }).gtmSnippet;
    expect(gtm).toContain(`s.setAttribute('data-key', '${b.siteKey}');`);
    expect(gtm).toContain("s.setAttribute('data-endpoint', 'https://track.example.com');");
    expect(gtm).toContain("s.setAttribute('data-consent-mode', 'opt_out');");
    expect(gtm).toContain("s.src = 'https://track.example.com/tracker.js';");
    expect(b.webhooks.zoho).toBe(`https://track.example.com/webhooks/${b.tenant.tenantId}/zoho`);

    const again = await call('GET', `/tenants/${b.tenant.tenantId}`);
    expect(again.status).toBe(200);
    expect(JSON.stringify(again.body)).not.toContain(b.webhookSecret);
    expect(again.body).toMatchObject({ tenant: { consentPolicy: { mode: 'opt_out' }, destinations: ['meta'] } });
  });

  it('validates input with clear messages', async () => {
    const bad = (body: object) => call('POST', '/tenants', body);
    expect(await bad({})).toMatchObject({ status: 400, body: { error: 'invalid_name' } });
    expect(await bad({ name: 'X', origins: ['not a url'] })).toMatchObject({ status: 400, body: { error: 'invalid_origins' } });
    expect(await bad({ name: 'X', origins: ['javascript:alert(1)'] })).toMatchObject({ status: 400, body: { error: 'invalid_origins' } });
    expect(await bad({ name: 'X', consentMode: 'maybe' })).toMatchObject({ status: 400, body: { error: 'invalid_settings' } });
    expect(await bad({ name: 'X', destinations: [] })).toMatchObject({ status: 400, body: { error: 'invalid_settings' } });
    expect(await bad({ name: 'X', retentionDays: 0 })).toMatchObject({ status: 400, body: { error: 'invalid_settings' } });
    expect(await bad({ name: 'X', zoho: { dealId: 'id' } })).toMatchObject({ status: 400, body: { error: 'invalid_mapping' } });
    expect((await call('GET', '/tenants/nobody')).status).toBe(404);
    expect((await call('GET', '/tenants/../../etc')).status).toBe(404);
  });

  it('lists brands, edits settings, saves a Zoho mapping, and suspends a brand', async () => {
    const b = await newBrand();
    const id = b.tenant.tenantId;
    expect(((await call('GET', '/tenants')).body as { tenants: Array<{ tenantId: string }> }).tenants.map((t) => t.tenantId)).toContain(id);

    const patched = await call('PATCH', `/tenants/${id}`, { name: 'Renamed', allowedChannels: ['store', 'online'], retentionDays: 30 });
    expect(patched.body).toMatchObject({ tenant: { name: 'Renamed', allowedChannels: ['store', 'online'], retentionDays: 30 } });
    expect(await call('PATCH', `/tenants/${id}`, { status: 'paused' })).toMatchObject({ status: 400 });

    const mapping = { dealId: 'Deal_Id', amount: 'Total', occurredAt: 'Sold_On', phone: 'Phone', channel: 'Source', storeChannelValues: ['showroom'] };
    const saved = await call('PUT', `/tenants/${id}/sources/zoho`, mapping);
    expect(saved.body).toMatchObject({ tenant: { sources: { zoho: { amount: 'Total' } } } });
    expect(await call('PUT', `/tenants/${id}/sources/zoho`, { ...mapping, phone: '' })).toMatchObject({ status: 400 });

    await call('PATCH', `/tenants/${id}`, { status: 'suspended' });
    expect(await registry.findSite(b.siteKey)).toBeNull();
  });

  it('rotates the webhook secret and adds site keys', async () => {
    const b = await newBrand();
    const id = b.tenant.tenantId;
    const rotated = (await call('POST', `/tenants/${id}/webhook-secret/rotate`)).body as { webhookSecret: string };
    expect(await registry.verifyWebhookSecret(id, b.webhookSecret)).toBe(false);
    expect(await registry.verifyWebhookSecret(id, rotated.webhookSecret)).toBe(true);

    const key = (await call('POST', `/tenants/${id}/site-keys`, { origins: ['https://shop.brand.com'], label: 'Shop' })).body as { siteKey: string };
    expect((await registry.findSite(key.siteKey))?.site).toMatchObject({ origins: ['https://shop.brand.com'], label: 'Shop' });
    expect(await call('POST', `/tenants/${id}/site-keys`, { origins: ['nope'] })).toMatchObject({ status: 400 });
  });

  it('saves connections without ever returning the token, and keeps the old token when it is left blank', async () => {
    const b = await newBrand();
    const id = b.tenant.tenantId;

    const meta = await call('PUT', `/tenants/${id}/connections/meta`, { datasetId: '999', accessToken: 'EAAG-secret', testEventCode: 'TEST1' });
    expect(meta.status).toBe(200);
    expect(JSON.stringify(meta.body)).not.toContain('EAAG-secret');
    expect(meta.body).toMatchObject({ kind: 'meta', datasetId: '999', testEventCode: 'TEST1', secretSet: true });

    // Edit the dataset without pasting the token again.
    await call('PUT', `/tenants/${id}/connections/meta`, { datasetId: '1000' });
    expect((await new ConnectionsRepo(db, box, id).getWithSecret('meta'))).toEqual({ settings: { datasetId: '1000' }, secret: 'EAAG-secret' });

    expect(await call('PUT', `/tenants/${id}/connections/google_ads`, { customerId: '1234567890', conversionActionId: '5' })).toMatchObject({
      status: 400,
      body: { error: 'secret_required' },
    });
    expect(await call('PUT', `/tenants/${id}/connections/google_ads`, { customerId: '12', conversionActionId: '5', refreshToken: 'rt' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_customer_id' },
    });
    await call('PUT', `/tenants/${id}/connections/google_ads`, { customerId: '123-456-7890', conversionActionId: '5', refreshToken: 'rt' });

    const detail = JSON.stringify((await call('GET', `/tenants/${id}`)).body);
    expect(detail).not.toMatch(/EAAG|"rt"/);
    expect(detail).toContain('1234567890');

    await call('DELETE', `/tenants/${id}/connections/meta`);
    expect(await new ConnectionsRepo(db, box, id).get('meta')).toBeNull();
  });

  it('imports a CSV (dry run first), is idempotent, then sends and shows sales, stats and resend', async () => {
    const b = await newBrand({ destinations: ['meta'] });
    const id = b.tenant.tenantId;
    const today = new Date().toISOString().slice(0, 10);
    const csv = [
      'eventId,channel,occurredAt,value,phone,consent',
      `INV-1,store,${today},85000,9876543210,yes`,
      `INV-2,online,${today},500,9876543211,yes`,
      `INV-3,store,${today},300,9876543212,no`,
      `INV-4,mars,${today},1,,`,
    ].join('\n');
    const clean = csv.split('\n').slice(0, 4).join('\n'); // without the bad row

    const dry = (await call('POST', `/tenants/${id}/import`, { csv, dryRun: true })).body as { counts: Record<string, number>; results: Array<{ status: string }>; checkToken?: string };
    expect(dry.counts).toMatchObject({ recorded: 0, invalid: 1 });
    expect(dry.results.map((r) => r.status)).toEqual(['valid', 'valid', 'valid', 'invalid']);
    expect(dry.checkToken).toBeUndefined(); // a file with problems does not pass the check
    expect(((await call('GET', `/tenants/${id}/sales`)).body as { sales: unknown[] }).sales).toHaveLength(0);

    // No import without a clean check of this very file.
    expect(await call('POST', `/tenants/${id}/import`, { csv })).toMatchObject({ status: 400, body: { error: 'check_required' } });
    expect(await call('POST', `/tenants/${id}/import`, { csv, checkToken: 'x' })).toMatchObject({ status: 400 });

    const checked = (await call('POST', `/tenants/${id}/import`, { csv: clean, dryRun: true })).body as { checkToken: string; summary: Record<string, unknown> };
    expect(checked.summary).toMatchObject({ rows: 3, newSales: 3, alreadyImported: 0, withContact: 3, withoutContact: 0, consent: { yes: 2, no: 1, notStated: 0 }, value: { INR: 85800 } });
    // A token belongs to the file it was issued for: change one character and it no longer works.
    expect(await call('POST', `/tenants/${id}/import`, { csv: clean.replace('85000', '85001'), checkToken: checked.checkToken })).toMatchObject({ status: 400, body: { error: 'check_outdated' } });
    expect(await call('POST', `/tenants/${id}/import`, { csv: clean, checkToken: checked.checkToken.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).toMatchObject({ status: 400, body: { error: 'check_outdated' } });

    const real = (await call('POST', `/tenants/${id}/import`, { csv: clean, checkToken: checked.checkToken })).body as { counts: Record<string, number> };
    expect(real.counts).toEqual({ recorded: 3, duplicate: 0, invalid: 0, error: 0 });
    const again = (await importCsv(call, id, clean)).body as { counts: Record<string, number> };
    expect(again.counts).toEqual({ recorded: 0, duplicate: 3, invalid: 0, error: 0 });
    // The next check says these are already in.
    const second = (await call('POST', `/tenants/${id}/import`, { csv: clean, dryRun: true })).body as { summary: Record<string, unknown> };
    expect(second.summary).toMatchObject({ newSales: 0, alreadyImported: 3, withContact: 0, consent: { yes: 0, no: 0, notStated: 0 }, value: {}, firstDate: null });

    // A file that is part old, part new describes only the new part: value, dates and counts exclude what is skipped.
    const more = `${clean}\nINV-9,store,2026-01-05,1000,9876543219,no`;
    const mixed = (await call('POST', `/tenants/${id}/import`, { csv: more, dryRun: true })).body as { summary: Record<string, unknown> };
    expect(mixed.summary).toMatchObject({ rows: 4, newSales: 1, alreadyImported: 3, withContact: 1, consent: { yes: 0, no: 1, notStated: 0 }, value: { INR: 1000 }, firstDate: '2026-01-05', lastDate: '2026-01-05' });
    expect(await call('POST', `/tenants/${id}/import`, { csv: '   ' })).toMatchObject({ status: 400 });
    expect(await call('POST', `/tenants/${id}/import`, { csv: 'a,b\n1,2' })).toMatchObject({ status: 400, body: { error: 'invalid_csv' } });

    // Connect Meta, run the dispatcher through the API, and look at the result.
    await call('PUT', `/tenants/${id}/connections/meta`, { datasetId: '999', accessToken: 'tok' });
    const sent = (await call('POST', `/tenants/${id}/dispatch`)).body as { sent: number };
    expect(sent.sent).toBe(1); // only INV-1: INV-2 is online (filtered), INV-3 has no consent
    expect(dispatchSpy).toHaveBeenCalledWith(id);

    const sales = (await call('GET', `/tenants/${id}/sales`, undefined, TOKEN, 'limit=10')).body as {
      sales: Array<{ saleKey: string; sale: { eventId: string }; deliveries: Array<{ destination: string; status: string; skipReason?: string }> }>;
    };
    const byId = Object.fromEntries(sales.sales.map((s) => [s.sale.eventId, s]));
    expect(byId['INV-1']?.deliveries[0]).toMatchObject({ destination: 'meta', status: 'sent' });
    expect(byId['INV-2']?.deliveries[0]).toMatchObject({ status: 'skipped', skipReason: 'channel_filtered' });
    expect(byId['INV-3']?.deliveries[0]).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });

    const stats = (await call('GET', `/tenants/${id}/stats`, undefined, TOKEN, 'days=7')).body as {
      sales: number;
      deliveries: Record<string, Record<string, number>>;
      skipReasons: Record<string, Record<string, number>>;
    };
    expect(stats.sales).toBe(3);
    expect(stats.deliveries.meta).toEqual({ sent: 1, skipped: 2 });
    expect(stats.skipReasons.meta).toEqual({ channel_filtered: 1, no_consent: 1 });

    // Resend: allowed for a sent delivery, refused for a skipped one.
    const key = byId['INV-1']!.saleKey;
    expect(await call('POST', `/tenants/${id}/sales/${key}/deliveries/meta/resend`)).toMatchObject({ status: 200 });
    expect(await call('POST', `/tenants/${id}/sales/${byId['INV-2']!.saleKey}/deliveries/meta/resend`)).toMatchObject({ status: 409 });
    expect(await call('POST', `/tenants/${id}/sales/not-a-key/deliveries/meta/resend`)).toMatchObject({ status: 404 });
  });

  it("one brand's data never appears in another brand's sales list", async () => {
    const a = await newBrand();
    const b = await newBrand();
    const today = new Date().toISOString().slice(0, 10);
    await importCsv(call, a.tenant.tenantId, `eventId,channel,occurredAt\nONLY-A,store,${today}`);
    const listB = (await call('GET', `/tenants/${b.tenant.tenantId}/sales`)).body as { sales: unknown[] };
    expect(listB.sales).toEqual([]);
  });
});
