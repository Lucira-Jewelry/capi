import type { Channel } from '@datahash/core';
import type { AdapterResult, IncomingSale } from '../types';
import { asString, parseAmount } from '../util';

const CHANNELS: Channel[] = ['online', 'store', 'whatsapp', 'web_lead'];

/** What is safe to keep in the ingest log for the generic JSON: a fixed allowlist, contact details redacted. */
export function genericLogView(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== 'object') return {};
  const r = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['eventId', 'eventName', 'channel', 'occurredAt', 'value', 'currency', 'store', 'consent']) {
    if (r[key] !== undefined) out[key] = r[key];
  }
  for (const key of ['phone', 'email']) if (r[key]) out[key] = '[redacted]';
  return out;
}

/**
 * Standard JSON any system can post:
 * { eventId, channel, occurredAt (ISO with time), value?, currency?, eventName?, phone?, email?, store?, consent? }
 */
export function mapGenericSale(record: unknown): AdapterResult {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'invalid_payload' };
  const r = record as Record<string, unknown>;

  const eventId = asString(r.eventId);
  if (!eventId) return { ok: false, reason: 'missing_deal_id' };

  const channel = asString(r.channel) as Channel | undefined;
  if (!channel || !CHANNELS.includes(channel)) return { ok: false, reason: 'unknown_channel', detail: channel };

  const at = asString(r.occurredAt);
  const occurredAt = at && /T/.test(at) ? new Date(at) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return { ok: false, reason: 'invalid_date' };

  const sale: IncomingSale = {
    source: 'webhook',
    eventId,
    eventName: asString(r.eventName) ?? 'Purchase',
    channel,
    occurredAt,
  };

  if (r.value !== undefined) {
    const value = parseAmount(r.value);
    if (value === null || value < 0) return { ok: false, reason: 'invalid_amount' };
    sale.value = value;
    sale.currency = (asString(r.currency) ?? 'INR').toUpperCase();
  }
  const store = asString(r.store);
  if (store) sale.storeName = store;
  const phone = asString(r.phone);
  if (phone) sale.phone = phone;
  const email = asString(r.email);
  if (email) sale.email = email;
  if (typeof r.consent === 'boolean') sale.consent = r.consent;

  return { ok: true, sale };
}
