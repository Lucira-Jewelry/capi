import { describe, expect, it } from 'vitest';
import type { Touch } from '@datahash/core';
import type { SaleRecord } from '@datahash/store';
import { buildGoogleEvent, buildMetaEvent, matchSummary, previewPayload, type SendContext } from '../src';

const sale = (hashes: SaleRecord['hashes']): SaleRecord => ({
  source: 'zoho',
  eventId: 'deal-1',
  eventName: 'Purchase',
  channel: 'store',
  occurredAt: new Date('2026-10-07T09:30:00Z'),
  value: 85000,
  currency: 'INR',
  personId: null,
  hashes,
  consentAds: true,
});
const ctx = (hashes: SaleRecord['hashes'], touch: Touch | null = null): SendContext => ({ saleKey: 'k', sale: sale(hashes), touch });

const rich = {
  metaPhone: 'mp', metaEmail: 'me', googlePhone: 'gp', googleEmail: 'ge',
  metaFirstName: 'fn', metaLastName: 'ln', metaCity: 'ct', metaState: 'st', metaZip: 'zp', metaCountry: 'co', metaExternalId: 'xid',
  googleFirstName: 'gfn', googleLastName: 'gln', googleRegion: 'IN', googlePostal: '411001',
  fbp: 'fb.1.1700000000000.123',
};

describe('Meta match details', () => {
  it('adds name, place, customer ID and the browser ID', () => {
    expect(buildMetaEvent(ctx(rich))!.user_data).toEqual({
      ph: ['mp'], em: ['me'], fn: ['fn'], ln: ['ln'], ct: ['ct'], st: ['st'], zp: ['zp'], country: ['co'], external_id: ['xid'], fbp: 'fb.1.1700000000000.123',
    });
  });

  it('name, place and the browser ID are not enough to send on their own', () => {
    expect(buildMetaEvent(ctx({ metaFirstName: 'fn', metaCity: 'ct', metaExternalId: 'xid', fbp: 'fb.1.1700000000000.1' }))).toBeNull();
  });

  it('sends exactly what it did before when there are no extra details', () => {
    expect(buildMetaEvent(ctx({ metaPhone: 'mp', metaEmail: 'me' }))!.user_data).toEqual({ ph: ['mp'], em: ['me'] });
  });
});

describe('Google match details', () => {
  it('adds an address when name, country and postal code are all there', () => {
    expect(buildGoogleEvent(ctx(rich))!.userData!.userIdentifiers).toEqual([
      { emailAddress: 'ge' },
      { phoneNumber: 'gp' },
      { address: { givenName: 'gfn', familyName: 'gln', regionCode: 'IN', postalCode: '411001' } },
    ]);
  });

  it('leaves the address out when any part is missing', () => {
    const { googlePostal: _drop, ...partial } = rich;
    const ids = buildGoogleEvent(ctx(partial))!.userData!.userIdentifiers;
    expect(ids.some((i) => 'address' in i)).toBe(false);
  });
});

describe('what the preview says', () => {
  it('lists what the sale is matched on and what is missing', () => {
    const m = matchSummary('meta', ctx({ metaPhone: 'mp' }));
    expect(m.used).toEqual(['phone']);
    expect(m.missing).toContain('email');
    expect(m.missing).toContain('postal code');
    const p = previewPayload('meta', ctx({ metaPhone: 'mp' }), null);
    expect('notes' in p && p.notes.some((n) => n.startsWith('Matched on: phone.'))).toBe(true);
  });
});
