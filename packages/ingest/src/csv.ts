import type { IncomingSale } from './types';
import { mapGenericSale } from './adapters/generic';

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, commas and newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export const IMPORT_COLUMNS = ['eventId', 'channel', 'occurredAt', 'value', 'currency', 'phone', 'email', 'store', 'consent', 'eventName'];

export const IMPORT_TEMPLATE = `${IMPORT_COLUMNS.join(',')}\nINV-1001,store,2026-10-07,85000,INR,9876543210,priya@example.com,Main Showroom,yes,Purchase\n`;

const YES = ['true', 'yes', 'y', '1', 'consented', 'granted'];
const NO = ['false', 'no', 'n', '0', 'declined', 'denied'];

export interface ImportRow {
  line: number;
  ok: boolean;
  error?: string;
  sale?: IncomingSale;
}

/**
 * CSV fallback for sales missing from the CRM. Columns: eventId, channel, occurredAt, value, currency, phone,
 * email, store, consent, eventName (header names are case-insensitive; eventId, channel and occurredAt are required).
 * Date-only values (2026-10-07) are read as noon in `dateOnlyOffset`.
 */
export function salesFromCsv(text: string, dateOnlyOffset = '+05:30', maxRows = 1000): { rows: ImportRow[]; error?: string } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: 'The file needs a header row and at least one sale.' };
  if (table.length - 1 > maxRows) return { rows: [], error: `Too many rows: at most ${maxRows} per import.` };

  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const index = (name: string) => header.indexOf(name.toLowerCase());
  for (const required of ['eventId', 'channel', 'occurredAt']) {
    if (index(required) === -1) return { rows: [], error: `Missing required column: ${required}` };
  }

  const rows: ImportRow[] = table.slice(1).map((cells, i) => {
    const get = (name: string) => {
      const idx = index(name);
      const v = idx === -1 ? '' : (cells[idx] ?? '').trim();
      return v === '' ? undefined : v;
    };
    const record: Record<string, unknown> = {};
    for (const col of IMPORT_COLUMNS) {
      const v = get(col);
      if (v !== undefined) record[col] = v;
    }
    if (typeof record.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.occurredAt)) {
      record.occurredAt = `${record.occurredAt}T12:00:00${dateOnlyOffset}`;
    }
    if (typeof record.consent === 'string') {
      const c = record.consent.toLowerCase();
      if (YES.includes(c)) record.consent = true;
      else if (NO.includes(c)) record.consent = false;
      else delete record.consent;
    }
    if (typeof record.channel === 'string') record.channel = record.channel.toLowerCase();

    const mapped = mapGenericSale(record);
    const line = i + 2;
    if (!mapped.ok) return { line, ok: false, error: describe(mapped.reason, mapped.detail) };
    return { line, ok: true, sale: { ...mapped.sale, source: 'import' } };
  });
  return { rows };
}

function describe(reason: string, detail?: string): string {
  const text: Record<string, string> = {
    missing_deal_id: 'eventId is empty',
    unknown_channel: 'channel must be one of: store, online, whatsapp, web_lead',
    invalid_date: 'occurredAt must be a date like 2026-10-07 or a full timestamp',
    invalid_amount: 'value is not a number',
    invalid_payload: 'row could not be read',
  };
  return `${text[reason] ?? reason}${detail ? ` (${detail})` : ''}`;
}
