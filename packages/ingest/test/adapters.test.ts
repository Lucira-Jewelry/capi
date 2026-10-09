import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZOHO_MAPPING as M,
  getPath,
  mapGenericSale,
  mapZohoDeal,
  parseAmount,
  parseDate,
  redactRecord,
  zohoFieldsFromMapping,
} from '../src';

const deal = (over: Record<string, unknown> = {}) => ({
  id: '5000000012345',
  Stage: 'Closed Won',
  Amount: '85000.00',
  Closing_Date: '2026-10-07',
  Store: 'Pune - FC Road',
  Sale_Channel: 'In-Store',
  Ad_Consent: 'Yes',
  Contact_Name: { Mobile: '98765 43210', Email: 'Priya@Example.com' },
  ...over,
});

describe('helpers', () => {
  it('parseAmount handles currency symbols, commas and Indian grouping', () => {
    expect(parseAmount('85000.00')).toBe(85000);
    expect(parseAmount('₹ 85,000')).toBe(85000);
    expect(parseAmount('Rs. 1,20,000.50')).toBe(120000.5);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });

  it('parseDate: date-only becomes noon IST, full timestamps are kept', () => {
    expect(parseDate('2026-10-07')?.toISOString()).toBe('2026-10-07T06:30:00.000Z');
    expect(parseDate('2026-10-07T14:30:00+05:30')?.toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  it('getPath reads nested and flat dotted keys', () => {
    expect(getPath({ A: { B: 'x' } }, 'A.B')).toBe('x');
    expect(getPath({ 'A.B': 'flat' }, 'A.B')).toBe('flat');
    expect(getPath({}, 'A.B')).toBeUndefined();
  });

  it('redactRecord hides phone and email but keeps the rest, without touching the original', () => {
    const rec = deal();
    const red = redactRecord(rec, ['Contact_Name.Mobile', 'Contact_Name.Email']) as typeof rec;
    expect(JSON.stringify(red)).not.toContain('98765');
    expect(JSON.stringify(red)).not.toContain('priya');
    expect(red.id).toBe(rec.id);
    expect(rec.Contact_Name.Mobile).toBe('98765 43210');
    expect(redactRecord({ phone: '123' }, ['phone'])).toEqual({ phone: '[redacted]' });
  });

  it('zohoFieldsFromMapping lists every field the mapping reads once', () => {
    const fields = zohoFieldsFromMapping(M);
    expect(fields).toContain('Contact_Name.Mobile');
    expect(fields).toContain('Sale_Channel');
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('mapZohoDeal', () => {
  it('maps a store sale', () => {
    const r = mapZohoDeal(deal(), M);
    expect(r).toEqual({
      ok: true,
      sale: {
        source: 'zoho',
        eventId: '5000000012345',
        eventName: 'Purchase',
        channel: 'store',
        occurredAt: new Date('2026-10-07T06:30:00.000Z'),
        value: 85000,
        currency: 'INR',
        storeName: 'Pune - FC Road',
        phone: '98765 43210',
        email: 'Priya@Example.com',
        consent: true,
      },
    });
  });

  it('works with flat dotted keys (COQL results) too', () => {
    const flat = { ...deal(), 'Contact_Name.Mobile': '90000 11111' } as Record<string, unknown>;
    delete flat.Contact_Name;
    const r = mapZohoDeal(flat, M);
    expect(r.ok && r.sale.phone).toBe('90000 11111');
  });

  it('ignores deals that are not in a won stage', () => {
    expect(mapZohoDeal(deal({ Stage: 'Negotiation' }), M)).toMatchObject({ ok: false, reason: 'not_won' });
    expect(mapZohoDeal(deal({ Stage: 'closed won' }), M).ok).toBe(true);
  });

  it('rejects a missing deal ID, bad amount, bad date and unknown channel', () => {
    expect(mapZohoDeal(deal({ id: '' }), M)).toMatchObject({ ok: false, reason: 'missing_deal_id' });
    expect(mapZohoDeal(deal({ Amount: 'tbd' }), M)).toMatchObject({ ok: false, reason: 'invalid_amount' });
    expect(mapZohoDeal(deal({ Closing_Date: '', Modified_Time: '' }), M)).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(mapZohoDeal(deal({ Sale_Channel: 'Referral' }), M)).toMatchObject({ ok: false, reason: 'unknown_channel' });
    expect(mapZohoDeal(deal({ Sale_Channel: '' }), M)).toMatchObject({ ok: false, reason: 'unknown_channel' });
    expect(mapZohoDeal(null, M)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('falls back to the second date field', () => {
    const r = mapZohoDeal(deal({ Closing_Date: '', Modified_Time: '2026-10-07T10:00:00+05:30' }), M);
    expect(r.ok && r.sale.occurredAt.toISOString()).toBe('2026-10-07T04:30:00.000Z');
  });

  it('maps channels: online and whatsapp', () => {
    expect(mapZohoDeal(deal({ Sale_Channel: 'Website' }), M)).toMatchObject({ ok: true, sale: { channel: 'online' } });
    expect(mapZohoDeal(deal({ Sale_Channel: 'WhatsApp' }), M)).toMatchObject({ ok: true, sale: { channel: 'whatsapp' } });
  });

  it('consent: yes/no/blank', () => {
    expect(mapZohoDeal(deal({ Ad_Consent: 'No' }), M)).toMatchObject({ ok: true, sale: { consent: false } });
    const blank = mapZohoDeal(deal({ Ad_Consent: '' }), M);
    expect(blank.ok && 'consent' in blank.sale).toBe(false);
  });

  it('keeps the sale when phone and email are missing (the pipeline decides what to do)', () => {
    const r = mapZohoDeal(deal({ Contact_Name: {} }), M);
    expect(r.ok && r.sale.phone).toBeUndefined();
  });
});

describe('mapGenericSale', () => {
  const ok = { eventId: 'o-1', channel: 'whatsapp', occurredAt: '2026-10-07T10:00:00+05:30', value: 5000, phone: '9876543210', consent: true };

  it('maps the standard shape', () => {
    expect(mapGenericSale(ok)).toMatchObject({
      ok: true,
      sale: { source: 'webhook', eventId: 'o-1', channel: 'whatsapp', value: 5000, currency: 'INR', consent: true },
    });
  });

  it('rejects bad input', () => {
    expect(mapGenericSale({ ...ok, eventId: '' })).toMatchObject({ ok: false, reason: 'missing_deal_id' });
    expect(mapGenericSale({ ...ok, channel: 'mars' })).toMatchObject({ ok: false, reason: 'unknown_channel' });
    expect(mapGenericSale({ ...ok, occurredAt: '2026-10-07' })).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(mapGenericSale({ ...ok, value: 'x' })).toMatchObject({ ok: false, reason: 'invalid_amount' });
    expect(mapGenericSale('nope')).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
});
