import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, type SaleRecord } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
const box = new SecretBox(SecretBox.generateKey());

const NOW = new Date('2026-10-08T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

afterAll(async () => {
  if (emulator) await db.terminate();
});

describe.skipIf(!emulator)('ConnectionsRepo (Firestore emulator)', () => {
  const repo = () => new ConnectionsRepo(db, box, `conn-${randomUUID()}`);

  it('stores settings in the clear and the token encrypted; the public view never has the token', async () => {
    const tenantId = `conn-${randomUUID()}`;
    const r = new ConnectionsRepo(db, box, tenantId);
    await r.set('meta', { datasetId: '1234567890', testEventCode: ' TEST123 ' }, 'EAAG-secret-token', NOW);

    const raw = (await db.collection('tenants').doc(tenantId).collection('connections').doc('meta').get()).data()!;
    expect(JSON.stringify(raw)).not.toContain('EAAG-secret-token');
    expect(raw.datasetId).toBe('1234567890');

    const pub = await r.get('meta');
    expect(pub).toMatchObject({ kind: 'meta', datasetId: '1234567890', testEventCode: 'TEST123', secretSet: true, status: 'active' });
    expect(JSON.stringify(pub)).not.toContain('EAAG');

    expect(await r.getWithSecret('meta')).toEqual({
      settings: { datasetId: '1234567890', testEventCode: 'TEST123' },
      secret: 'EAAG-secret-token',
    });
  });

  it('normalises Google Ads IDs and validates input', async () => {
    const r = repo();
    await r.set(
      'google_ads',
      { customerId: '123-456-7890', loginCustomerId: '987-654-3210', conversionActionId: '555' },
      'refresh-token',
    );
    expect((await r.getWithSecret('google_ads'))?.settings).toEqual({
      customerId: '1234567890',
      loginCustomerId: '9876543210',
      conversionActionId: '555',
    });
    await expect(r.set('google_ads', { customerId: '12', conversionActionId: '1' }, 't')).rejects.toThrow('invalid_customer_id');
    await expect(r.set('meta', { datasetId: 'abc' }, 't')).rejects.toThrow('invalid_dataset_id');
    await expect(r.set('meta', { datasetId: '123' }, '  ')).rejects.toThrow('secret_required');
  });

  it('lists, marks errors, and removes connections', async () => {
    const r = repo();
    await r.set('meta', { datasetId: '111' }, 'tok');
    await r.markStatus('meta', 'error', 'Invalid OAuth access token');
    expect(await r.get('meta')).toMatchObject({ status: 'error', lastError: 'Invalid OAuth access token' });
    await r.markStatus('meta', 'active');
    expect((await r.get('meta'))?.lastError).toBeUndefined();
    expect((await r.list()).map((c) => c.kind)).toEqual(['meta']);
    await r.remove('meta');
    expect(await r.get('meta')).toBeNull();
    expect(await r.getWithSecret('meta')).toBeNull();
  });
});

describe.skipIf(!emulator)('SalesRepo delivery lifecycle (Firestore emulator)', () => {
  const sale = (eventId: string, over: Partial<SaleRecord> = {}): SaleRecord => ({
    source: 'zoho',
    eventId,
    eventName: 'Purchase',
    channel: 'store',
    occurredAt: NOW,
    value: 1000,
    currency: 'INR',
    personId: null,
    hashes: { metaPhone: 'h' },
    consentAds: true,
    ...over,
  });

  async function seed() {
    const repo = new SalesRepo(db, { tenantId: `sales-${randomUUID()}` });
    const { saleKey } = await repo.recordSale(
      sale('D1'),
      [
        { destination: 'meta', status: 'pending' },
        { destination: 'google_ads', status: 'skipped', skipReason: 'no_identifiers' },
      ],
      NOW,
    );
    return { repo, saleKey };
  }

  it('lists only what is due, and claims a delivery once', async () => {
    const { repo, saleKey } = await seed();
    const due = await repo.listDueDeliveries(NOW);
    expect(due.map((d) => `${d.saleKey}:${d.destination}`)).toEqual([`${saleKey}:meta`]);

    expect(await repo.claimDelivery(saleKey, 'meta', NOW)).toEqual(expect.any(String));
    expect(await repo.claimDelivery(saleKey, 'meta', NOW)).toBeNull(); // already claimed
    const [d] = await repo.getDeliveries(saleKey).then((all) => all.filter((x) => x.destination === 'meta'));
    expect(d).toMatchObject({ status: 'sending', claims: 1, attempts: 0 }); // a claim is not a send attempt
    expect(await repo.listDueDeliveries(NOW)).toEqual([]);
  });

  it('a dead worker is covered: the lease expires and the delivery is due again', async () => {
    const { repo, saleKey } = await seed();
    await repo.claimDelivery(saleKey, 'meta', NOW, 2 * 60_000);
    expect(await repo.listDueDeliveries(at(1))).toEqual([]);
    expect((await repo.listDueDeliveries(at(3))).map((d) => d.destination)).toEqual(['meta']);
    expect(await repo.claimDelivery(saleKey, 'meta', at(3))).toEqual(expect.any(String));
  });

  it('retries wait until their time; sent and failed are final', async () => {
    const { repo, saleKey } = await seed();
    await repo.claimDelivery(saleKey, 'meta', NOW);
    await repo.completeDelivery(saleKey, 'meta', { status: 'retry', error: 'HTTP 503', nextRetryAt: at(5) }, NOW);
    expect(await repo.listDueDeliveries(at(1))).toEqual([]);
    expect((await repo.listDueDeliveries(at(6))).length).toBe(1);

    await repo.claimDelivery(saleKey, 'meta', at(6));
    await repo.completeDelivery(saleKey, 'meta', { status: 'sent', response: 'events_received=1' }, at(6));
    const meta = (await repo.getDeliveries(saleKey)).find((d) => d.destination === 'meta')!;
    expect(meta).toMatchObject({ status: 'sent', attempts: 2, response: 'events_received=1' });
    expect(meta.sentAt).toEqual(at(6));
    expect(meta.lastError).toBeUndefined();
    expect(await repo.listDueDeliveries(at(60))).toEqual([]);
  });

  it('a failed delivery can be put back by hand; a skipped one cannot', async () => {
    const { repo, saleKey } = await seed();
    await repo.claimDelivery(saleKey, 'meta', NOW);
    await repo.completeDelivery(saleKey, 'meta', { status: 'failed', error: 'Invalid parameter' }, NOW);
    expect(await repo.listDueDeliveries(at(60))).toEqual([]);

    expect(await repo.resetDelivery(saleKey, 'meta', at(61))).toBe(true);
    expect((await repo.listDueDeliveries(at(61))).length).toBe(1);
    expect(await repo.resetDelivery(saleKey, 'google_ads')).toBe(false);
    expect(await repo.resetDelivery(saleKey, 'nope')).toBe(false);
  });

  it('lists recent sales with their deliveries, newest first', async () => {
    const repo = new SalesRepo(db, { tenantId: `sales-${randomUUID()}` });
    await repo.recordSale(sale('old'), [{ destination: 'meta', status: 'pending' }], at(-120));
    await repo.recordSale(sale('new'), [{ destination: 'meta', status: 'pending' }], NOW);
    const list = await repo.listSales(10);
    expect(list.map((s) => s.sale.eventId)).toEqual(['new', 'old']);
    expect(list[0]?.deliveries).toHaveLength(1);
  });

  it('computes stats: channels, statuses, skip reasons, and click-ID vs contact-only sends', async () => {
    const repo = new SalesRepo(db, { tenantId: `sales-${randomUUID()}` });
    await repo.recordSale(sale('a', { personId: 'p1' }), [{ destination: 'meta', status: 'pending', touchId: 't1' }], NOW);
    await repo.recordSale(sale('b'), [{ destination: 'meta', status: 'pending' }], NOW);
    await repo.recordSale(sale('c', { channel: 'online' }), [{ destination: 'meta', status: 'skipped', skipReason: 'channel_filtered' }], NOW);
    await repo.recordSale(sale('old'), [{ destination: 'meta', status: 'pending' }], at(-60 * 24 * 40));

    const s = await repo.stats(at(-60 * 24 * 7));
    expect(s).toMatchObject({
      sales: 3,
      matchedToPerson: 1,
      byChannel: { store: 2, online: 1 },
      deliveries: { meta: { pending: 2, skipped: 1 } },
      skipReasons: { meta: { channel_filtered: 1 } },
      withClickId: 1,
      contactOnly: 1,
    });
  });
});
