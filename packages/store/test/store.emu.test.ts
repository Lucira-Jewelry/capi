import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFbc, evaluateDelivery, type BusinessEvent } from '@datahash/core';
import { createFirestore, Store, touchId } from '../src';

// These tests need the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const newStore = () => new Store(db, { tenantId: `test-${randomUUID()}` });

describe.skipIf(!emulator)('Store (Firestore emulator)', () => {
  afterAll(async () => {
    await db.terminate();
  });

  it('rejects an identify call without a usable phone or email', async () => {
    const store = newStore();
    expect(await store.identify({ phone: '123', email: 'nope', now: NOW })).toEqual({
      status: 'rejected',
      reason: 'no_valid_identifier',
    });
  });

  it('creates a person and finds them from any phone format', async () => {
    const store = newStore();
    const res = await store.identify({
      phone: '98765 43210',
      touches: [{ clickedAt: daysAgo(3), gclid: 'G1' }],
      consent: { ads: true, source: 'enquiry-form', textVersion: 'v1' },
      now: NOW,
    });
    expect(res).toMatchObject({ status: 'ok', created: true, merged: false, touchesWritten: 1 });

    const found = await store.findPerson({ phone: '+91 9876543210' });
    expect(found?.id).toBe(res.status === 'ok' ? res.personId : '');
    expect(found?.consent?.ads).toBe(true);
    expect(found?.hashes.metaPhone).toBeTruthy();
    expect(found?.hashes.googlePhone).toBeTruthy();
  });

  it('never stores the plain phone or email', async () => {
    const store = newStore();
    const res = await store.identify({ phone: '9876543210', email: 'priya@example.com', now: NOW });
    if (res.status !== 'ok') throw new Error('expected ok');
    const person = await store.findPerson({ phone: '9876543210' });
    const dump = JSON.stringify(person);
    expect(dump).not.toContain('9876543210');
    expect(dump).not.toContain('priya@example.com');
  });

  it('links an email to the same person when it arrives later', async () => {
    const store = newStore();
    const first = await store.identify({ phone: '9876543210', now: NOW });
    const second = await store.identify({ phone: '9876543210', email: 'priya@example.com', now: NOW });
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected ok');
    expect(second.personId).toBe(first.personId);
    expect(second.created).toBe(false);
    expect((await store.findPerson({ email: 'Priya@Example.com' }))?.id).toBe(first.personId);
  });

  it('does not duplicate touches when the same identify call is retried', async () => {
    const store = newStore();
    const touch = { clickedAt: daysAgo(2), gclid: 'G1' };
    const a = await store.identify({ phone: '9876543210', touches: [touch], now: NOW });
    await store.identify({ phone: '9876543210', touches: [touch], now: NOW });
    if (a.status !== 'ok') throw new Error('expected ok');
    expect(await store.getTouches(a.personId)).toHaveLength(1);
    expect(touchId(touch)).toBe(touchId({ ...touch }));
  });

  it('merges two people when a phone and an email turn out to be the same person', async () => {
    const store = newStore();
    const a = await store.identify({
      phone: '9876543210',
      touches: [{ clickedAt: daysAgo(20), gclid: 'G-phone' }],
      now: daysAgo(20),
    });
    const b = await store.identify({
      email: 'priya@example.com',
      touches: [{ clickedAt: daysAgo(5), fbclid: 'F-email', fbc: buildFbc('F-email', daysAgo(5).getTime()) }],
      now: daysAgo(5),
    });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected ok');
    expect(a.personId).not.toBe(b.personId);

    const joined = await store.identify({ phone: '9876543210', email: 'priya@example.com', now: NOW });
    if (joined.status !== 'ok') throw new Error('expected ok');
    expect(joined.merged).toBe(true);
    expect(joined.personId).toBe(a.personId); // older record wins

    // Both contact details now resolve to the same person, with both touches.
    const byPhone = await store.lookupForSale({ phone: '9876543210' });
    const byEmail = await store.lookupForSale({ email: 'priya@example.com' });
    expect(byPhone?.person.id).toBe(a.personId);
    expect(byEmail?.person.id).toBe(a.personId);
    expect(byEmail?.touches.map((t) => t.gclid ?? t.fbclid).sort()).toEqual(['F-email', 'G-phone']);
    expect(byEmail?.person.hashes.metaPhone).toBeTruthy();
    expect(byEmail?.person.hashes.metaEmail).toBeTruthy();
  });

  it('latest consent answer wins', async () => {
    const store = newStore();
    await store.identify({ phone: '9876543210', consent: { ads: true }, now: daysAgo(10) });
    await store.identify({ phone: '9876543210', consent: { ads: false }, now: NOW });
    expect((await store.findPerson({ phone: '9876543210' }))?.consent?.ads).toBe(false);
  });

  it('returns touches newest first', async () => {
    const store = newStore();
    const res = await store.identify({
      phone: '9876543210',
      touches: [
        { clickedAt: daysAgo(30), gclid: 'old' },
        { clickedAt: daysAgo(2), gclid: 'new' },
        { clickedAt: daysAgo(10), gclid: 'mid' },
      ],
      now: NOW,
    });
    if (res.status !== 'ok') throw new Error('expected ok');
    expect((await store.getTouches(res.personId)).map((t) => t.gclid)).toEqual(['new', 'mid', 'old']);
  });

  it('deletes a person, their touches and their identities', async () => {
    const store = newStore();
    const res = await store.identify({
      phone: '9876543210',
      email: 'priya@example.com',
      touches: [{ clickedAt: daysAgo(1), gclid: 'G1' }],
      now: NOW,
    });
    if (res.status !== 'ok') throw new Error('expected ok');
    await store.deletePerson(res.personId);
    expect(await store.findPerson({ phone: '9876543210' })).toBeNull();
    expect(await store.findPerson({ email: 'priya@example.com' })).toBeNull();
    expect(await store.getTouches(res.personId)).toHaveLength(0);
  });

  it('end to end: ad click, enquiry, then a store sale is credited to the right click', async () => {
    const store = newStore();
    // Day -12: click a Google ad. Day -9: click a Meta ad. Day -8: fill the enquiry form.
    await store.identify({
      phone: '9876543210',
      email: 'priya@example.com',
      consent: { ads: true, source: 'enquiry-form' },
      touches: [
        { clickedAt: daysAgo(12), gclid: 'G-12' },
        { clickedAt: daysAgo(9), fbclid: 'F-9', fbc: buildFbc('F-9', daysAgo(9).getTime()) },
      ],
      now: daysAgo(8),
    });

    // Today: the store marks the deal Won, with only the phone number.
    const found = await store.lookupForSale({ phone: '+91 98765 43210' });
    expect(found).not.toBeNull();

    const sale: BusinessEvent = {
      eventId: 'deal-777',
      eventName: 'Purchase',
      channel: 'store',
      occurredAt: daysAgo(0.5),
      value: 92000,
      currency: 'INR',
    };
    const common = {
      event: sale,
      identity: { phoneHash: found!.person.hashes.metaPhone, emailHash: found!.person.hashes.metaEmail },
      consent: found!.person.consent,
      consentPolicy: { mode: 'opt_in' as const },
      touches: found!.touches,
      allowedChannels: ['store' as const, 'whatsapp' as const],
      now: NOW,
    };

    const meta = evaluateDelivery({ ...common, destination: 'meta' });
    const google = evaluateDelivery({ ...common, destination: 'google_ads' });
    expect(meta).toMatchObject({ action: 'send', touch: { fbclid: 'F-9' } });
    expect(google).toMatchObject({ action: 'send', touch: { gclid: 'G-12' } });
  });
});
