import { describe, expect, it } from 'vitest';
import { IMPORT_TEMPLATE, parseCsv, salesFromCsv } from '../src';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines in fields, CRLF, BOM and blank lines', () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n"multi\nline",2,3\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['multi\nline', '2', '3'],
    ]);
  });
});

describe('salesFromCsv', () => {
  it('the downloadable template is itself a valid import', () => {
    const { rows, error } = salesFromCsv(IMPORT_TEMPLATE);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ok: true,
      sale: {
        source: 'import',
        eventId: 'INV-1001',
        channel: 'store',
        value: 85000,
        currency: 'INR',
        storeName: 'Main Showroom',
        consent: true,
        occurredAt: new Date('2026-10-07T06:30:00.000Z'), // date-only -> noon IST
      },
    });
  });

  it('is case-insensitive about headers and column order, and reports row errors by line number', () => {
    const csv = [
      'CHANNEL,EventID,OccurredAt,Value,Phone,Consent',
      'Store,A1,2026-10-07T10:00:00+05:30,1000,9876543210,no',
      'mars,A2,2026-10-07,5,,',
      'store,,2026-10-07,5,,',
      'store,A4,someday,5,,',
      'store,A5,2026-10-07,lots,,',
    ].join('\n');
    const { rows } = salesFromCsv(csv);
    expect(rows[0]).toMatchObject({ line: 2, ok: true, sale: { eventId: 'A1', consent: false, phone: '9876543210' } });
    expect(rows.slice(1).map((r) => [r.line, r.ok, r.error])).toEqual([
      [3, false, expect.stringContaining('channel must be one of')],
      [4, false, expect.stringContaining('eventId is empty')],
      [5, false, expect.stringContaining('occurredAt')],
      [6, false, expect.stringContaining('value is not a number')],
    ]);
  });

  it('rejects files with no header, missing required columns, or too many rows', () => {
    expect(salesFromCsv('')).toMatchObject({ error: expect.stringContaining('header row') });
    expect(salesFromCsv('eventId,channel\nA,store')).toMatchObject({ error: 'Missing required column: occurredAt' });
    const big = 'eventId,channel,occurredAt\n' + Array.from({ length: 6 }, (_, i) => `A${i},store,2026-10-07`).join('\n');
    expect(salesFromCsv(big, '+05:30', 5)).toMatchObject({ error: expect.stringContaining('Too many rows') });
  });

  it('an unrecognised consent word is treated as "not stated"', () => {
    const { rows } = salesFromCsv('eventId,channel,occurredAt,consent\nA1,store,2026-10-07,maybe');
    expect(rows[0]?.sale && 'consent' in rows[0].sale).toBe(false);
  });
});
