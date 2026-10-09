import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { identityKeyForEmail, identityKeyForPhone } from '@datahash/core';
import { createFirestore, SalesRepo, Store } from '@datahash/store';
import { eraseCustomer, MAX_LINKED_CONTACTS, processSale, TooManyLinkedContacts, withdrawCustomer, type IncomingSale, type IngestTenant } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
afterAll(async () => {
  if (emulator) await db.terminate();
});

const NOW = new Date('2026-10-08T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function setup() {
  const tenantId = `erase-${randomUUID()}`;
  const store = new Store(db, { tenantId });
  const sales = new SalesRepo(db, { tenantId });
  const tenant: IngestTenant = { tenantId, consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], destinations: ['meta', 'google_ads'], defaultCountry: 'IN', sources: {} };
  const root = db.collection('tenants').doc(tenantId);
  return { tenantId, store, sales, tenant, root, deps: { store, sales, now: () => NOW } };
}

const sale = (over: Partial<IncomingSale> = {}): IncomingSale => ({
  source: 'zoho', eventId: 'deal-1', eventName: 'Purchase', channel: 'store', occurredAt: hoursAgo(2), value: 85000, currency: 'INR',
  phone: '9876543210', email: 'priya@example.com', consent: true, ...over,
});

const PHONE = '9876543210';
const EMAIL = 'priya@example.com';

async function websiteVisit(s: ReturnType<typeof setup>, contact: { phone?: string; email?: string }, gclid = 'G-1') {
  return s.store.identify({ ...contact, defaultCountry: 'IN', consent: { ads: true, source: 'tracker' }, touches: [{ clickedAt: hoursAgo(30), gclid }], now: NOW });
}

describe.skipIf(!emulator)('erasing a customer (Firestore emulator)', () => {
  it('removes their website profile, clicks and identities, and records that nothing may be sent for them', async () => {
    const s = setup();
    const visit = await websiteVisit(s, { phone: PHONE, email: EMAIL });
    if (visit.status !== 'ok') throw new Error('setup failed');

    const r = await eraseCustomer(s, { phone: PHONE, defaultCountry: 'IN' }, NOW); // the phone alone is enough: the email is found through the profile
    expect(r).toMatchObject({ found: true, persons: 1, touches: 1, identities: 2 });

    expect((await s.root.collection('persons').doc(visit.personId).get()).exists).toBe(false);
    expect((await s.root.collection('persons').doc(visit.personId).collection('touches').get()).size).toBe(0);
    expect((await s.root.collection('identities').get()).size).toBe(0);
    // both contact keys are now suppressed, including the one that was not given
    expect(await s.store.isSuppressed([identityKeyForPhone(PHONE)!])).toBe(true);
    expect(await s.store.isSuppressed([identityKeyForEmail(EMAIL)!])).toBe(true);
    expect((await s.root.collection('suppressions').doc(identityKeyForEmail(EMAIL)!).get()).data()).toMatchObject({ source: 'erasure' });
  });

  it('strips the customer from their sales and cancels what was queued, keeping the sale as a record', async () => {
    const s = setup();
    await websiteVisit(s, { phone: PHONE, email: EMAIL });
    const { saleKey } = await processSale(sale(), s.tenant, s.deps);
    const before = await s.sales.getSale(saleKey);
    expect(before?.identityKeys?.length).toBe(2);
    expect(before?.personId).toBeTruthy();
    expect((await s.sales.getDeliveries(saleKey)).some((d) => d.touchId)).toBe(true);

    const r = await eraseCustomer(s, { email: EMAIL }, NOW);
    expect(r).toMatchObject({ sales: 1, deliveriesCancelled: 2 });

    const after = await s.sales.getSale(saleKey);
    expect(after).toMatchObject({ hashes: {}, identityKeys: [], personId: null, eventId: 'deal-1', value: 85000, channel: 'store' });
    expect(JSON.stringify(after)).not.toMatch(/[0-9a-f]{64}/); // no contact hash survives anywhere on the sale
    for (const d of await s.sales.getDeliveries(saleKey)) {
      expect(d).toMatchObject({ status: 'skipped', skipReason: 'customer_erased' });
      expect(d.touchId).toBeUndefined();
    }
    expect(await s.sales.listDueDeliveries(NOW)).toEqual([]); // nothing left to send
  });

  it('finds sales of a customer who never visited the website, by their contact details alone', async () => {
    const s = setup();
    const { saleKey } = await processSale(sale({ eventId: 'crm-only' }), s.tenant, s.deps);
    expect((await s.sales.getSale(saleKey))?.personId).toBeNull();
    const r = await eraseCustomer(s, { phone: PHONE }, NOW);
    expect(r).toMatchObject({ found: true, persons: 0, sales: 1 });
    expect((await s.sales.getSale(saleKey))?.identityKeys).toEqual([]);
  });

  it('leaves other customers completely alone', async () => {
    const s = setup();
    await websiteVisit(s, { phone: '9123456780', email: 'other@example.com' }, 'G-other');
    const other = await processSale(sale({ eventId: 'deal-other', phone: '9123456780', email: 'other@example.com' }), s.tenant, s.deps);
    await processSale(sale(), s.tenant, s.deps);

    await eraseCustomer(s, { phone: PHONE }, NOW);

    const kept = await s.sales.getSale(other.saleKey);
    expect(kept?.identityKeys).toHaveLength(2);
    expect(kept?.personId).toBeTruthy();
    expect((await s.sales.getDeliveries(other.saleKey)).map((d) => d.status)).toEqual(['pending', 'pending']);
    expect((await s.root.collection('persons').get()).size).toBe(1);
    expect(await s.store.isSuppressed([identityKeyForPhone('9123456780')!])).toBe(false);
  });

  it('also removes the empty records left when two profiles were merged', async () => {
    const s = setup();
    await websiteVisit(s, { phone: PHONE }, 'G-a');
    await websiteVisit(s, { email: EMAIL }, 'G-b');
    const merged = await websiteVisit(s, { phone: PHONE, email: EMAIL }, 'G-c');
    expect(merged).toMatchObject({ status: 'ok', merged: true });
    const withTombstone = (await s.root.collection('persons').get()).size;
    expect(withTombstone).toBe(2); // the profile and the retired one

    const r = await eraseCustomer(s, { phone: PHONE }, NOW);
    expect(r.persons).toBe(1);
    expect((await s.root.collection('persons').get()).size).toBe(0);
    expect((await s.root.collection('identities').get()).size).toBe(0);
  });

  it('a replayed webhook for an erased sale does not bring the customer back', async () => {
    const s = setup();
    const first = await processSale(sale(), s.tenant, s.deps);
    await eraseCustomer(s, { phone: PHONE }, NOW);
    const replay = await processSale(sale(), s.tenant, s.deps);
    expect(replay.saleKey).toBe(first.saleKey);
    expect((await s.sales.getSale(first.saleKey))?.identityKeys).toEqual([]);
    expect((await s.sales.getDeliveries(first.saleKey)).every((d) => d.status === 'skipped')).toBe(true);
  });

  it('a later, new sale from an erased customer is not sent to the platforms', async () => {
    const s = setup();
    await processSale(sale(), s.tenant, s.deps);
    await eraseCustomer(s, { phone: PHONE }, NOW);
    const next = await processSale(sale({ eventId: 'deal-2' }), s.tenant, s.deps);
    const deliveries = await s.sales.getDeliveries(next.saleKey);
    expect(deliveries.map((d) => d.status)).toEqual(['skipped', 'skipped']);
    expect(deliveries[0]?.skipReason).toBe('consent_withdrawn');
  });

  it('does nothing, and says so, when the details cannot identify anyone', async () => {
    const s = setup();
    await processSale(sale(), s.tenant, s.deps);
    expect(await eraseCustomer(s, {}, NOW)).toMatchObject({ found: false, sales: 0 });
    expect(await eraseCustomer(s, { phone: 'abc', email: 'not an email' }, NOW)).toMatchObject({ found: false });
    expect((await s.root.collection('suppressions').get()).size).toBe(0);
  });

  it('is safe to run twice', async () => {
    const s = setup();
    await websiteVisit(s, { phone: PHONE });
    await processSale(sale(), s.tenant, s.deps);
    await eraseCustomer(s, { phone: PHONE }, NOW);
    expect(await eraseCustomer(s, { phone: PHONE }, NOW)).toMatchObject({ found: true, persons: 0, touches: 0, deliveriesCancelled: 0 });
  });
});

describe.skipIf(!emulator)('a customer is erased under every contact detail we know for them (Firestore emulator)', () => {
  const statuses = async (s: ReturnType<typeof setup>, saleKey: string) => (await s.sales.getDeliveries(saleKey)).map((d) => `${d.status}${d.skipReason ? `:${d.skipReason}` : ''}`);

  it('REPRODUCTION: a store purchase with phone and email, erased by phone, then an email-only purchase: nothing is sent', async () => {
    const s = setup();
    await processSale(sale({ eventId: 'first' }), s.tenant, s.deps); // phone AND email, never visited the website
    await eraseCustomer(s, { phone: PHONE }, NOW);

    const emailOnly = await processSale(sale({ eventId: 'second', phone: undefined }), s.tenant, s.deps);
    expect(await statuses(s, emailOnly.saleKey)).toEqual(['skipped:consent_withdrawn', 'skipped:consent_withdrawn']);
    const phoneOnly = await processSale(sale({ eventId: 'third', email: undefined }), s.tenant, s.deps);
    expect(await statuses(s, phoneOnly.saleKey)).toEqual(['skipped:consent_withdrawn', 'skipped:consent_withdrawn']);
  });

  it('the same the other way round: erased by email, then a phone-only purchase', async () => {
    const s = setup();
    await processSale(sale({ eventId: 'first' }), s.tenant, s.deps);
    const r = await eraseCustomer(s, { email: EMAIL }, NOW);
    expect(r.contactDetails).toBe(2);
    const phoneOnly = await processSale(sale({ eventId: 'second', email: undefined }), s.tenant, s.deps);
    expect(await statuses(s, phoneOnly.saleKey)).toEqual(['skipped:consent_withdrawn', 'skipped:consent_withdrawn']);
  });

  it('both contact details are recorded as suppressed', async () => {
    const s = setup();
    await processSale(sale(), s.tenant, s.deps);
    await eraseCustomer(s, { phone: PHONE }, NOW);
    expect(await s.store.isSuppressed([identityKeyForEmail(EMAIL)!])).toBe(true);
    expect(await s.store.isSuppressed([identityKeyForPhone(PHONE)!])).toBe(true);
    expect((await s.root.collection('suppressions').get()).size).toBe(2);
  });

  it('follows a chain: a second sale that pairs the same email with another phone brings that phone in too', async () => {
    const s = setup();
    await processSale(sale({ eventId: 'a' }), s.tenant, s.deps); // phone + email
    await processSale(sale({ eventId: 'b', phone: '9123456780' }), s.tenant, s.deps); // same email, another phone
    const r = await eraseCustomer(s, { phone: PHONE }, NOW);
    expect(r).toMatchObject({ contactDetails: 3, sales: 2 });
    expect(await s.store.isSuppressed([identityKeyForPhone('9123456780')!])).toBe(true);
  });

  it('knows an email belongs to a website profile even when no sale pairs them', async () => {
    const s = setup();
    await websiteVisit(s, { phone: PHONE, email: EMAIL });
    await processSale(sale({ eventId: 'phone-only', email: undefined }), s.tenant, s.deps); // the sale only has the phone
    await eraseCustomer(s, { phone: PHONE }, NOW);
    expect(await s.store.isSuppressed([identityKeyForEmail(EMAIL)!])).toBe(true);
    const emailOnly = await processSale(sale({ eventId: 'later', phone: undefined }), s.tenant, s.deps);
    expect(await statuses(s, emailOnly.saleKey)).toEqual(['skipped:consent_withdrawn', 'skipped:consent_withdrawn']);
  });

  it('suppresses everything BEFORE it clears anything', async () => {
    const s = setup();
    await websiteVisit(s, { phone: PHONE, email: EMAIL });
    await processSale(sale(), s.tenant, s.deps);
    const order: string[] = [];
    const store = {
      keysFor: s.store.keysFor.bind(s.store),
      profilesForKeys: s.store.profilesForKeys.bind(s.store),
      markDeclined: s.store.markDeclined.bind(s.store),
      suppress: async (...a: Parameters<typeof s.store.suppress>) => { order.push('suppress'); return s.store.suppress(...a); },
      deletePerson: async (id: string) => { order.push('deletePerson'); return s.store.deletePerson(id); },
    };
    const sales = {
      linkedTo: s.sales.linkedTo.bind(s.sales),
      anonymizeCustomer: async (...a: Parameters<typeof s.sales.anonymizeCustomer>) => { order.push('anonymize'); return s.sales.anonymizeCustomer(...a); },
    };
    await eraseCustomer({ store, sales }, { phone: PHONE }, NOW);
    expect(order).toEqual(['suppress', 'deletePerson', 'anonymize']);
  });

  it('a purchase racing the erasure cannot slip through: it is suppressed as soon as the suppression exists', async () => {
    const s = setup();
    await processSale(sale({ eventId: 'first' }), s.tenant, s.deps);
    let racing: Awaited<ReturnType<typeof processSale>> | undefined;
    const store = {
      keysFor: s.store.keysFor.bind(s.store),
      profilesForKeys: s.store.profilesForKeys.bind(s.store),
      markDeclined: s.store.markDeclined.bind(s.store),
      deletePerson: s.store.deletePerson.bind(s.store),
      suppress: async (...a: Parameters<typeof s.store.suppress>) => {
        await s.store.suppress(...a);
        // a new email-only purchase arrives right after the suppression is written, before the clearing
        racing = await processSale(sale({ eventId: 'racing', phone: undefined }), s.tenant, s.deps);
      },
    };
    await eraseCustomer({ store, sales: s.sales }, { phone: PHONE }, NOW);
    expect(await statuses(s, racing!.saleKey)).toEqual(['skipped:consent_withdrawn', 'skipped:consent_withdrawn']);
  });

  it('a number shared by many people is refused, and nothing at all is changed', async () => {
    const s = setup();
    for (let i = 0; i <= MAX_LINKED_CONTACTS; i++) await processSale(sale({ eventId: `shop-${i}`, email: `customer${i}@example.com` }), s.tenant, s.deps);
    const before = await s.root.collection('sales').get();
    await expect(eraseCustomer(s, { phone: PHONE }, NOW)).rejects.toBeInstanceOf(TooManyLinkedContacts);
    expect((await s.root.collection('suppressions').get()).size).toBe(0);
    const after = await s.root.collection('sales').get();
    expect(after.docs.every((d) => (d.data().identityKeys as string[]).length === 2)).toBe(true);
    expect(after.size).toBe(before.size);
  }, 60_000);
});

describe.skipIf(!emulator)('an operator privacy request reaches every linked contact detail too (Firestore emulator)', () => {
  it('stopping use by phone also stops a later email-only purchase, and deletes nothing', async () => {
    const s = setup();
    const first = await processSale(sale({ eventId: 'first' }), s.tenant, s.deps);
    const r = await withdrawCustomer(s, { phone: PHONE }, NOW);
    expect(r).toEqual({ keys: 2, personFound: false });

    const emailOnly = await processSale(sale({ eventId: 'second', phone: undefined }), s.tenant, s.deps);
    expect((await s.sales.getDeliveries(emailOnly.saleKey)).map((d) => d.status)).toEqual(['skipped', 'skipped']);
    // the earlier sale is untouched: still has its details, only the unsent deliveries were not cancelled by this
    expect((await s.sales.getSale(first.saleKey))?.identityKeys).toHaveLength(2);
  });

  it('marks the website profile as declined', async () => {
    const s = setup();
    const visit = await websiteVisit(s, { phone: PHONE, email: EMAIL });
    if (visit.status !== 'ok') throw new Error('setup failed');
    expect(await withdrawCustomer(s, { email: EMAIL }, NOW)).toEqual({ keys: 2, personFound: true });
    expect((await s.root.collection('persons').doc(visit.personId).get()).data()?.consent).toMatchObject({ ads: false, source: 'withdrawal' });
  });

  it('says nothing was found when the details cannot be read', async () => {
    const s = setup();
    expect(await withdrawCustomer(s, { phone: 'abc' }, NOW)).toEqual({ keys: 0, personFound: false });
  });
});
