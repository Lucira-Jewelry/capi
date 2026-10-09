import { describe, expect, it } from 'vitest';
import {
  evaluateDelivery,
  hasAdConsent,
  selectTouch,
  type BusinessEvent,
  type EligibilityInput,
  type Touch,
} from '../src';

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

const storeSale = (daysOld = 1): BusinessEvent => ({
  eventId: 'deal-1',
  eventName: 'Purchase',
  channel: 'store',
  occurredAt: daysAgo(daysOld),
  value: 85000,
  currency: 'INR',
});

const touch = (id: string, daysOld: number, ids: Partial<Touch>): Touch => ({
  id,
  clickedAt: daysAgo(daysOld),
  ...ids,
});

const base = (overrides: Partial<EligibilityInput> = {}): EligibilityInput => ({
  event: storeSale(),
  destination: 'meta',
  identity: { phoneHash: 'p' },
  consent: { ads: true },
  consentPolicy: { mode: 'opt_in' },
  touches: [],
  allowedChannels: ['store', 'whatsapp'],
  now: NOW,
  ...overrides,
});

describe('hasAdConsent', () => {
  it('opt_in needs an explicit yes', () => {
    expect(hasAdConsent({ ads: true }, { mode: 'opt_in' })).toBe(true);
    expect(hasAdConsent({ ads: false }, { mode: 'opt_in' })).toBe(false);
    expect(hasAdConsent({}, { mode: 'opt_in' })).toBe(false);
    expect(hasAdConsent(null, { mode: 'opt_in' })).toBe(false);
  });
  it('opt_out allows unless declined', () => {
    expect(hasAdConsent({}, { mode: 'opt_out' })).toBe(true);
    expect(hasAdConsent(undefined, { mode: 'opt_out' })).toBe(true);
    expect(hasAdConsent({ ads: false }, { mode: 'opt_out' })).toBe(false);
  });
});

describe('selectTouch', () => {
  const touches = [
    touch('old-g', 40, { gclid: 'G-old' }),
    touch('new-g', 10, { gclid: 'G-new' }),
    touch('meta', 20, { fbclid: 'F1', fbc: 'fb.1.1.F1' }),
    touch('after-sale', 0.1, { gclid: 'G-late' }),
    touch('expired', 5, { gclid: 'G-exp', expiresAt: daysAgo(1) }),
  ];
  const sale = daysAgo(1);

  it('picks the most recent touch before the sale that has the right ID', () => {
    expect(selectTouch(touches, sale, 'google_ads', NOW)?.id).toBe('new-g');
    expect(selectTouch(touches, sale, 'meta', NOW)?.id).toBe('meta');
  });
  it('ignores touches after the sale and expired touches', () => {
    const ids = touches.map((t) => t.id);
    expect(ids).toContain('after-sale');
    expect(selectTouch(touches, sale, 'google_ads', NOW)?.id).not.toBe('after-sale');
    expect(selectTouch(touches, sale, 'google_ads', NOW)?.id).not.toBe('expired');
  });
  it('returns null when nothing qualifies', () => {
    expect(selectTouch([], sale, 'meta', NOW)).toBeNull();
  });
});

describe('evaluateDelivery', () => {
  it('sends a consented store sale to Meta with hashed identifiers only', () => {
    expect(evaluateDelivery(base())).toEqual({ action: 'send', touch: null });
  });

  it('skips without consent', () => {
    expect(evaluateDelivery(base({ consent: { ads: false } }))).toEqual({ action: 'skip', reason: 'no_consent' });
    expect(evaluateDelivery(base({ consent: undefined }))).toEqual({ action: 'skip', reason: 'no_consent' });
  });

  it('skips channels the tenant did not allow (avoids double counting online sales)', () => {
    const online = { ...storeSale(), channel: 'online' as const };
    expect(evaluateDelivery(base({ event: online }))).toEqual({ action: 'skip', reason: 'channel_filtered' });
  });

  it('skips when there are no identifiers and no click ID', () => {
    expect(evaluateDelivery(base({ identity: {} }))).toEqual({ action: 'skip', reason: 'no_identifiers' });
  });

  it('a click ID alone is enough to send', () => {
    const t = touch('t1', 3, { fbc: 'fb.1.1.F', fbclid: 'F' });
    const result = evaluateDelivery(base({ identity: {}, touches: [t] }));
    expect(result).toEqual({ action: 'send', touch: t });
  });

  it('attaches the chosen touch for Google', () => {
    const t = touch('t1', 12, { gclid: 'G1' });
    const result = evaluateDelivery(base({ destination: 'google_ads', touches: [t] }));
    expect(result).toEqual({ action: 'send', touch: t });
  });

  it('Google: click older than 90 days is too old; younger is fine', () => {
    const old = touch('old', 95, { gclid: 'G-old' });
    expect(
      evaluateDelivery(base({ destination: 'google_ads', event: storeSale(1), touches: [old] })),
    ).toEqual({ action: 'skip', reason: 'too_old' });
    const ok = touch('ok', 80, { gclid: 'G-ok' });
    expect(
      evaluateDelivery(base({ destination: 'google_ads', event: storeSale(1), touches: [ok] })).action,
    ).toBe('send');
  });

  it('Meta: offline sale allows a longer window than a web event', () => {
    expect(evaluateDelivery(base({ event: storeSale(30) })).action).toBe('send');
    expect(evaluateDelivery(base({ event: storeSale(70) }))).toEqual({ action: 'skip', reason: 'too_old' });

    const webLead = { ...storeSale(10), channel: 'web_lead' as const };
    expect(
      evaluateDelivery(base({ event: webLead, allowedChannels: ['web_lead'] })),
    ).toEqual({ action: 'skip', reason: 'too_old' });
  });

  it('checks run in order: consent before channel before identifiers', () => {
    const online = { ...storeSale(), channel: 'online' as const };
    expect(
      evaluateDelivery(base({ consent: { ads: false }, event: online, identity: {} })),
    ).toEqual({ action: 'skip', reason: 'no_consent' });
    expect(evaluateDelivery(base({ event: online, identity: {} }))).toEqual({
      action: 'skip',
      reason: 'channel_filtered',
    });
  });
});
