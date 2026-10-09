import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { identityKeyForEmail, identityKeyForPhone } from '@datahash/core';
import { createFirestore, SalesRepo, Store, type SaleRecord } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

afterAll(async () => {
  if (emulator) await db.terminate();
});

const NOW = new Date('2026-10-08T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const sale = (eventId: string): SaleRecord => ({
  source: 'zoho', eventId, eventName: 'Purchase', channel: 'store', occurredAt: NOW, value: 1,
  currency: 'INR', personId: null, hashes: { metaPhone: 'h' }, consentAds: true,
});

describe.skipIf(!emulator)('delivery queue hardening (Firestore emulator)', () => {
  it('600 deliveries that are not due yet cannot hide one that is', async () => {
    const tenantId = `q-${randomUUID()}`;
    const repo = new SalesRepo(db, { tenantId });
    // Bulk-write 600 retries scheduled for tomorrow straight into Firestore (much faster than 600 transactions).
    const sales = db.collection('tenants').doc(tenantId).collection('sales');
    for (let from = 0; from < 600; from += 300) {
      const batch = db.batch();
      for (let i = from; i < from + 300; i++) {
        batch.set(sales.doc(`later-${i}`).collection('deliveries').doc('meta'), {
          tenantId, saleKey: `later-${i}`, destination: 'meta', status: 'retry', attempts: 1, claims: 1,
          nextRetryAt: at(24 * 60), createdAt: at(-i), updatedAt: NOW,
        });
      }
      await batch.commit();
    }
    await repo.recordSale(sale('due-now'), [{ destination: 'meta', status: 'pending' }], NOW);

    const due = await repo.listDueDeliveries(NOW, 50);
    expect(due.map((d) => d.status)).toEqual(['pending']);
    // ...and when their time comes they are found too, oldest first, capped by the limit.
    expect((await repo.listDueDeliveries(at(24 * 60 + 1), 10)).length).toBe(10);
  });

  it('only the worker holding the lease can write the result', async () => {
    const repo = new SalesRepo(db, { tenantId: `q-${randomUUID()}` });
    const { saleKey } = await repo.recordSale(sale('D1'), [{ destination: 'meta', status: 'pending' }], NOW);

    const slow = (await repo.claimDelivery(saleKey, 'meta', NOW, 2 * 60_000))!;
    const fast = (await repo.claimDelivery(saleKey, 'meta', at(3), 2 * 60_000))!; // lease expired: another worker takes over
    expect(fast).not.toBe(slow);

    // The slow worker finally finishes: its write is refused and changes nothing.
    expect(await repo.completeDelivery(saleKey, 'meta', { status: 'failed', error: 'stale', leaseToken: slow }, at(4))).toBe(false);
    expect((await repo.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sending', claims: 2 });

    expect(await repo.completeDelivery(saleKey, 'meta', { status: 'sent', leaseToken: fast }, at(4))).toBe(true);
    expect((await repo.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('counts an attempt only when asked to: waiting for a connection or a skip is not a send attempt', async () => {
    const repo = new SalesRepo(db, { tenantId: `q-${randomUUID()}` });
    const { saleKey } = await repo.recordSale(sale('D1'), [{ destination: 'meta', status: 'pending' }], NOW);

    for (let i = 0; i < 4; i++) {
      const t = (await repo.claimDelivery(saleKey, 'meta', at(i * 20)))!;
      await repo.completeDelivery(saleKey, 'meta', { status: 'retry', error: 'not_connected', nextRetryAt: at(i * 20 + 15), countAttempt: false, leaseToken: t }, at(i * 20));
    }
    expect((await repo.getDeliveries(saleKey))[0]).toMatchObject({ attempts: 0, claims: 0 });

    const t = (await repo.claimDelivery(saleKey, 'meta', at(200)))!;
    await repo.completeDelivery(saleKey, 'meta', { status: 'retry', error: 'HTTP 503', nextRetryAt: at(210), leaseToken: t }, at(200));
    expect((await repo.getDeliveries(saleKey))[0]).toMatchObject({ attempts: 1, claims: 0 });
  });

  it('a skipped result records its reason', async () => {
    const repo = new SalesRepo(db, { tenantId: `q-${randomUUID()}` });
    const { saleKey } = await repo.recordSale(sale('D1'), [{ destination: 'meta', status: 'pending' }], NOW);
    const t = (await repo.claimDelivery(saleKey, 'meta', NOW))!;
    await repo.completeDelivery(saleKey, 'meta', { status: 'skipped', skipReason: 'consent_withdrawn', leaseToken: t, countAttempt: false }, NOW);
    expect((await repo.getDeliveries(saleKey))[0]).toMatchObject({ status: 'skipped', skipReason: 'consent_withdrawn', attempts: 0 });
    expect(await repo.listDueDeliveries(at(60))).toEqual([]);
  });
});

describe.skipIf(!emulator)('withdrawal of consent (Firestore emulator)', () => {
  const keys = (phone: string, email?: string) => [identityKeyForPhone(phone), email ? identityKeyForEmail(email) : null].filter((k): k is string => Boolean(k));

  it('suppresses a customer who identified on the website, and marks their consent declined', async () => {
    const store = new Store(db, { tenantId: `w-${randomUUID()}` });
    await store.identify({ phone: '9876543210', email: 'priya@example.com', consent: { ads: true }, now: NOW });
    expect(await store.isSuppressed(keys('9876543210', 'priya@example.com'))).toBe(false);

    // Withdrawing by email alone also covers the phone the stored person owns.
    expect(await store.withdraw({ email: 'Priya@Example.com' }, at(5))).toEqual({ keys: 2, personFound: true });
    expect(await store.isSuppressed(keys('9876543210'))).toBe(true);
    expect(await store.isSuppressed(keys('9000000000'))).toBe(false); // someone else is untouched
    expect((await store.findPerson({ phone: '9876543210' }))?.consent).toMatchObject({ ads: false });
  });

  it('works for a CRM-only customer who never visited the website', async () => {
    const store = new Store(db, { tenantId: `w-${randomUUID()}` });
    expect(await store.withdraw({ phone: '98765 43210' }, NOW)).toEqual({ keys: 1, personFound: false });
    expect(await store.isSuppressed(keys('9876543210'))).toBe(true);
  });

  it('an explicit later "yes" lifts it; a declined or silent identify does not', async () => {
    const store = new Store(db, { tenantId: `w-${randomUUID()}` });
    await store.withdraw({ phone: '9876543210' }, NOW);

    await store.identify({ phone: '9876543210', now: at(1) }); // no consent given
    expect(await store.isSuppressed(keys('9876543210'))).toBe(true);
    await store.identify({ phone: '9876543210', consent: { ads: false }, now: at(2) });
    expect(await store.isSuppressed(keys('9876543210'))).toBe(true);

    await store.identify({ phone: '9876543210', consent: { ads: true }, now: at(3) });
    expect(await store.isSuppressed(keys('9876543210'))).toBe(false);
  });

  it('ignores contact details it cannot use, and brands are separate', async () => {
    const a = new Store(db, { tenantId: `w-${randomUUID()}` });
    const b = new Store(db, { tenantId: `w-${randomUUID()}` });
    expect(await a.withdraw({ phone: 'abc', email: 'nope' })).toEqual({ keys: 0, personFound: false });
    await a.withdraw({ phone: '9876543210' });
    expect(await b.isSuppressed(keys('9876543210'))).toBe(false);
    expect(await a.isSuppressed([])).toBe(false);
  });
});
