import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFbc } from '@datahash/core';
import { createFirestore, SalesRepo, Store } from '@datahash/store';
import { DEFAULT_ZOHO_MAPPING, processSale, type IncomingSale, type IngestTenant } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

function setup() {
  const tenantId = `ing-${randomUUID()}`;
  const store = new Store(db, { tenantId });
  const sales = new SalesRepo(db, { tenantId });
  const tenant: IngestTenant = {
    tenantId,
    consentPolicy: { mode: 'opt_in' },
    allowedChannels: ['store', 'whatsapp'],
    destinations: ['meta', 'google_ads'],
    defaultCountry: 'IN',
    sources: { zoho: DEFAULT_ZOHO_MAPPING },
  };
  return { store, sales, tenant, deps: { store, sales, now: () => NOW } };
}

const storeSale = (over: Partial<IncomingSale> = {}): IncomingSale => ({
  source: 'zoho',
  eventId: 'deal-1',
  eventName: 'Purchase',
  channel: 'store',
  occurredAt: daysAgo(1),
  value: 85000,
  currency: 'INR',
  storeName: 'Pune - FC Road',
  phone: '+91 98765 43210',
  ...over,
});

describe.skipIf(!emulator)('processSale (Firestore emulator)', () => {
  afterAll(async () => {
    await db.terminate();
  });

  it('credits a store sale to the earlier website click, found through the phone number alone', async () => {
    const { store, sales, tenant, deps } = setup();
    await store.identify({
      phone: '9876543210',
      consent: { ads: true },
      touches: [
        { clickedAt: daysAgo(12), gclid: 'G-12' },
        { clickedAt: daysAgo(9), fbclid: 'F-9', fbc: buildFbc('F-9', daysAgo(9).getTime()) },
      ],
      now: daysAgo(8),
    });

    const result = await processSale(storeSale(), tenant, deps);
    expect(result.matchedPerson).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.deliveries).toEqual([
      { destination: 'meta', status: 'pending' },
      { destination: 'google_ads', status: 'pending' },
    ]);

    const deliveries = await sales.getDeliveries(result.saleKey);
    const meta = deliveries.find((d) => d.destination === 'meta')!;
    const google = deliveries.find((d) => d.destination === 'google_ads')!;
    const touches = await store.getTouches((await store.findPerson({ phone: '9876543210' }))!.id);
    expect(touches.find((t) => t.id === meta.touchId)?.fbclid).toBe('F-9');
    expect(touches.find((t) => t.id === google.touchId)?.gclid).toBe('G-12');
  });

  it('a store-only customer with CRM consent is still reported, on hashed contact details only', async () => {
    const { sales, tenant, deps } = setup();
    const result = await processSale(storeSale({ consent: true, email: 'Priya@Example.com' }), tenant, deps);
    expect(result.matchedPerson).toBe(false);
    expect(result.deliveries.map((d) => d.status)).toEqual(['pending', 'pending']);

    const saved = await sales.getSale(result.saleKey);
    expect(saved?.personId).toBeNull();
    expect(saved?.hashes.metaPhone).toBeTruthy();
    expect(saved?.hashes.googleEmail).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain('98765');
    expect(JSON.stringify(saved)).not.toContain('priya@');
  });

  it('skips online sales (the Shopify apps report them) and records why', async () => {
    const { tenant, deps, sales } = setup();
    const result = await processSale(storeSale({ channel: 'online', consent: true }), tenant, deps);
    expect(result.deliveries).toEqual([
      { destination: 'meta', status: 'skipped', reason: 'channel_filtered' },
      { destination: 'google_ads', status: 'skipped', reason: 'channel_filtered' },
    ]);
    expect((await sales.getDeliveries(result.saleKey)).every((d) => d.status === 'skipped')).toBe(true);
  });

  it('skips when there is no consent anywhere', async () => {
    const { tenant, deps } = setup();
    const result = await processSale(storeSale(), tenant, deps);
    expect(result.deliveries.every((d) => d.reason === 'no_consent')).toBe(true);
  });

  it('CRM consent beats an older website answer (declined at the counter)', async () => {
    const { store, tenant, deps } = setup();
    await store.identify({ phone: '9876543210', consent: { ads: true }, now: daysAgo(30) });
    const result = await processSale(storeSale({ consent: false }), tenant, deps);
    expect(result.deliveries.every((d) => d.reason === 'no_consent')).toBe(true);
  });

  it('skips a sale with no phone, no email and no click', async () => {
    const { tenant, deps } = setup();
    const { phone: _p, ...noContact } = storeSale({ consent: true });
    const result = await processSale(noContact, tenant, deps);
    expect(result.deliveries.every((d) => d.reason === 'no_identifiers')).toBe(true);
  });

  it('skips a store sale that is too old for Google but not for Meta offline', async () => {
    const { tenant, deps } = setup();
    const result = await processSale(storeSale({ consent: true, occurredAt: daysAgo(100) }), tenant, deps);
    // 100 days old: Meta offline window (62 days, VERIFY) also exceeded, Google 90 days exceeded.
    expect(result.deliveries.map((d) => d.reason)).toEqual(['too_old', 'too_old']);
    const recent = await processSale(storeSale({ eventId: 'd2', consent: true, occurredAt: daysAgo(40) }), tenant, deps);
    expect(recent.deliveries.map((d) => d.status)).toEqual(['pending', 'pending']);
  });

  it('is idempotent: the same deal again changes nothing', async () => {
    const { sales, tenant, deps } = setup();
    const first = await processSale(storeSale({ consent: true }), tenant, deps);
    const second = await processSale(storeSale({ consent: false, value: 1 }), tenant, deps);
    expect(second.duplicate).toBe(true);
    expect(second.saleKey).toBe(first.saleKey);
    expect((await sales.getSale(first.saleKey))?.value).toBe(85000);
    expect((await sales.getDeliveries(first.saleKey)).every((d) => d.status === 'pending')).toBe(true);
  });

  it('only creates deliveries for the destinations the brand uses', async () => {
    const { sales, tenant, deps } = setup();
    const result = await processSale(storeSale({ consent: true }), { ...tenant, destinations: ['meta'] }, deps);
    expect((await sales.getDeliveries(result.saleKey)).map((d) => d.destination)).toEqual(['meta']);
  });
});
